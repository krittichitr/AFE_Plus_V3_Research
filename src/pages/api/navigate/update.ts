/**
 * POST /api/navigate/update
 * Load session → GPS smooth → corridor check → MT-D* Lite step → save
 *
 * MT-D* Lite is THE decision maker:
 *  - Decides optimal path through corridor graph
 *  - extractPath() maps graph edges → road geometry
 *  - When MT-D* fails → refetch from Mapbox (replan)
 * Replan conditions:
 *   Agent >100m จาก routePolyline → ambulance ออกนอกเส้นทาง
 *   Target >200m จาก routePolyline → patient อยู่นอก corridor ไกลมาก
 *   (200m threshold เผื่อ patient อยู่ในอาคาร/มหาวิทยาลัย ห่างจากถนน ~100m)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  createLogger,
  metrics,
  AppError,
  SessionLockLostError,
  SessionLockCapabilityUnavailableError,
  SessionLockBackendUnavailableError,
  SessionCommitOutcomeAmbiguousError,
} from '@/lib/navigation/logger';
import { validateBody, UpdateRequestSchema } from '@/lib/navigation/validate';
import { MTDStarLitePlanner } from '@/lib/navigation/mtdstar-lite';
import { GPSKalmanFilter, haversine } from '@/lib/navigation/gps.smooth';
import { findNearestNode, distanceToCorridor, buildCorridorGraph } from '@/lib/navigation/corridor.builder';
import { findNearestEdgeProjection } from '@/lib/navigation/graph.projection';
import { evaluateGraphCoverage, evaluateTargetAttachment } from '@/lib/navigation/graph-coverage';
import { shouldCallMapbox } from '@/lib/navigation/navigation-policy';
import { fetchMultiProfileDirections } from '@/lib/navigation/mapbox.client';
import { buildTargetCenteredGraph, TARGET_GRAPH_RADIUS_M, countConnectedComponents } from '@/lib/navigation/bubble.graph';
import {
  finishBackendM1CandidateFromResponse,
  getBackendResearchEvents,
  markBackendM1CandidateReady,
  researchContextFromRequestBody,
  startBackendM1Candidate,
  withBackendResearchContext,
} from '@/lib/research/backendResearch';
import {
  loadSession,
  acquireSessionLock,
  releaseSessionLock,
  commitSessionIfLockOwned,
} from '@/lib/navigation/session.store';
import { resolveSameNode } from '@/lib/navigation/same-node-policy';
import {
  analyzePathJump,
  getMaxPathJump,
  isSparseGeometryJumpAllowed,
  pathCost,
  prepareRenderablePath as prepareRenderablePathBase,
  trimPathTailToProjection,
  extendPathToProjection,
  type PrepareRenderablePathInput as BasePrepareRenderablePathInput,
  type PreparedRenderablePath,
} from '@/lib/navigation/path-validation';
import {
  buildNavPathTruthLog,
  withMetricDefaults,
  withUpdateResponseDefaults,
  type NavPathTruthInput,
} from '@/lib/navigation/response-contract';
import { maneuversForPath } from '@/lib/navigation/maneuver.extractor';
import type {
  UpdateResponse,
  SessionData,
  Coordinate,
  GraphEdge,
  NavMetric,
  NavDistanceMode,
  PathJumpTrace,
} from '@/lib/navigation/types';

const log = createLogger('api/navigate/update');
// Agent off-route corridor threshold (M4-D2/M4-D3) — env-configurable product/UX
// tuning value, same pattern as session.store.ts's NAV_SESSION_LOCK_TTL_MS.
// 40m default balances "reroute quickly like Google Maps" against this app's
// own existing GPS-accuracy precedent (MOVEMENT_ACCURACY_MAX_M = 30m,
// afe_tracking_webapp/app/navigation/page.tsx) — see M4-D2 audit for the full
// risk comparison across 20-100m.
const DEFAULT_AGENT_CORRIDOR_THRESHOLD_M = 40;
const MIN_AGENT_CORRIDOR_THRESHOLD_M = 20;
const MAX_AGENT_CORRIDOR_THRESHOLD_M = 150;

function getAgentCorridorThresholdM(): number {
  const raw = process.env.AGENT_CORRIDOR_THRESHOLD_M;
  const parsed = raw == null ? NaN : Number(raw);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_AGENT_CORRIDOR_THRESHOLD_M;
  }

  return Math.min(
    MAX_AGENT_CORRIDOR_THRESHOLD_M,
    Math.max(MIN_AGENT_CORRIDOR_THRESHOLD_M, parsed),
  );
}

const AGENT_CORRIDOR_THRESHOLD = getAgentCorridorThresholdM(); // meters — ambulance must stay near route
const TARGET_CORRIDOR_THRESHOLD = 200;   // meters — patient may be inside buildings/campus
// Forward drift thresholds — mode-aware so local navigation reacts faster than highway routing.
// local_hybrid: 80m catches a walking patient (~1–2 polling cycles at 2s) before agent reaches route end.
// long_distance: 300m avoids over-fetching on highways where targets legitimately advance fast.
const LOCAL_TARGET_FORWARD_THRESHOLD_M        = 40;  // local_hybrid — dense urban, slow target
// Target-centered graph is always enabled — target is graph center, not the agent.
const LONG_DISTANCE_TARGET_FORWARD_THRESHOLD_M = 300; // long_distance — highway, sparse nodes
const MAX_PATH_JUMP_M = 50;              // meters — max allowed gap between consecutive path points
// Semantic gap: road-to-road — haversine(path.last(), graph.nodes[tId]).
// Should be ~0 when extractPath works correctly (path ends at sgoal=tId by design).
// Large value = parent chain stale or geometry gap in extractPath.
// Baseline thresholds (no node change):
const SEMANTIC_TARGET_GAP_THRESHOLD_M      = 75;   // local_hybrid — urban, dense nodes
const SEMANTIC_TARGET_GAP_THRESHOLD_LONG_M = 300;  // long_distance — sparse highway nodes
// Tighter thresholds when snapped node changed this tick.
// If node changed but endpoint didn't follow, route tail is stale.
const SEMANTIC_CHANGED_NODE_THRESHOLD_M      = 30;  // local_hybrid
const SEMANTIC_CHANGED_NODE_THRESHOLD_LONG_M = 150; // long_distance
const ROUTE_START_AGENT_WARN_M  = 20; // meters — diagnostic threshold for stale/full routes
const ROUTE_START_AGENT_BLOCK_M = 75; // meters — never render a route whose start is this far behind/away
// Phase 1 telemetry: projected target endpoint thresholds (dry-run only — no behavior change)
const TARGET_EDGE_PROJECTION_THRESHOLD_M = 30; // meters — candidate threshold to use projected target
const TARGET_EDGE_PROJECTION_WARN_M = 15;      // meters — ideal tight alignment distance
// M4-E2: consecutive invalid-attachment ticks required before the GRACE band
// (30-50m, see graph-coverage.ts evaluateTargetAttachment) is allowed to
// trigger a Mapbox refetch. Absorbs ordinary GPS jitter right at the render
// threshold; SUSPECT/OUTSIDE bands are actionable on the first invalid tick.
const ATTACHMENT_GRACE_TICKS = 2;

function withJumpAllowed(trace: PathJumpTrace | undefined, allowed: boolean): PathJumpTrace | null {
  return trace ? { ...trace, allowed } : null;
}
const SAME_NODE_ARRIVAL_THRESHOLD_M = 30;      // meters — GPS distance below which same-node snap is treated as near-arrival

// ─── Session lock commit helper (M4-B1.3) ─────────────────────────────────────
// Replaces every bare `saveSession(session)` call in this file. Atomically
// verifies `lockToken` still owns the session lock and writes in one
// indivisible operation (session.store.ts `commitSessionIfLockOwned`) — never
// a separate check-then-write (M4-B1.2.1 proved that composition unsafe).
// A rejected commit throws so all later saves in the same request are
// automatically skipped via normal control-flow unwinding to the top-level
// catch, which returns the frontend-safe lock_lost/busy response.
async function commitOrThrow(sessionId: string, lockToken: string, session: SessionData): Promise<void> {
  const result = await commitSessionIfLockOwned(sessionId, lockToken, session);
  if (result.committed) return;
  // M4-B1.5: each reason gets its own dedicated error so the catch block can
  // return a distinct `refetchReason` — M4-B1.4 proved collapsing all of
  // these into SessionLockLostError hid infrastructure failures behind the
  // same signal as ordinary, expected lock contention.
  switch (result.reason) {
    case 'lock_lost':
      throw new SessionLockLostError(sessionId);
    case 'capability_unavailable':
      throw new SessionLockCapabilityUnavailableError(sessionId);
    case 'backend_unavailable':
      throw new SessionLockBackendUnavailableError(sessionId);
    case 'ambiguous':
      throw new SessionCommitOutcomeAmbiguousError(sessionId);
  }
}

// ─── Refetch helper: fetch fresh Mapbox route + rebuild corridor ──────────────
async function refetchRoute(
  session: SessionData,
  agentPos: Coordinate,
  targetPos: Coordinate,
  gps: GPSKalmanFilter,
  reason: string,
  lockToken: string,
): Promise<{
  success: boolean;
  path: Coordinate[];
  totalCost: number;
  totalDuration: number;
  responsePathSource: 'planner_prepared' | 'error_empty' | 'refetch_planner_failed_no_fallback';
  pathUsesSparseGeometry: boolean;
  sparseGeometryMaxJumpM: number | null;
  sparseGeometryEdgeCount: number;
  selectedEdges: GraphEdge[];
}> {
  log.info({ sessionId: session.sessionId, reason, targetPos, radiusM: TARGET_GRAPH_RADIUS_M }, 'REFETCH_TARGET_GRAPH_START');

  // Corridor route and target-centered walking graph fetched in parallel.
  // Target is graph center — rays radiate FROM target for dense local road coverage.
  // targetGraph.rays appended AFTER mbResponses so responses[0] stays the corridor.
  const [mbResponses, targetGraph] = await Promise.all([
    fetchMultiProfileDirections(agentPos, targetPos),
    buildTargetCenteredGraph(targetPos, TARGET_GRAPH_RADIUS_M),
  ]);

  const allResponses = [...mbResponses, ...targetGraph.rays];
  const newGraph = buildCorridorGraph(allResponses, agentPos, targetPos, {
    targetRayResponseStartIndex: mbResponses.length,
  });

  log.info({
    sessionId:           session.sessionId,
    nodeCount:           Object.keys(newGraph.nodes).length,
    edgeCount:           Object.values(newGraph.edges).reduce((s, arr) => s + arr.length, 0),
    connectedComponents: countConnectedComponents(newGraph),
    successfulRayCount:  targetGraph.successfulRayCount,
    failedRayCount:      targetGraph.failedRayCount,
    graphCenterPos:      targetGraph.graphCenterPos,
    graphRadiusM:        TARGET_GRAPH_RADIUS_M,
  }, 'TARGET_GRAPH_AUGMENTED');
  const aId = findNearestNode(agentPos, newGraph.nodes);
  let tId = findNearestNode(targetPos, newGraph.nodes);

  if (!aId || !tId) {
    return {
      success: false,
      path: [],
      totalCost: Infinity,
      totalDuration: 0,
      responsePathSource: 'error_empty',
      pathUsesSparseGeometry: false,
      sparseGeometryMaxJumpM: null,
      sparseGeometryEdgeCount: 0,
      selectedEdges: [],
    };
  }

  // ── Same-node snap in refetch graph ──────────────────────────────────────────
  const refetchGpsDistanceM = haversine(agentPos.lat, agentPos.lng, targetPos.lat, targetPos.lng);
  if (aId === tId) {
    log.info({
      sessionId: session.sessionId,
      aId, tId,
      refetchGpsDistanceM: Math.round(refetchGpsDistanceM),
      sameNodeSnapDetected: true,
      sameNodeGpsDistanceM: Math.round(refetchGpsDistanceM),
    }, 'SAME_NODE_SNAP_REFETCH_DETECTED');

    if (refetchGpsDistanceM <= SAME_NODE_ARRIVAL_THRESHOLD_M) {
      log.info({
        sessionId: session.sessionId,
        aId, refetchGpsDistanceM: Math.round(refetchGpsDistanceM),
        sameNodeResolution: 'near_target_no_plan',
      }, 'SAME_NODE_NEAR_TARGET_REFETCH_NO_ROUTE');
      return {
        success: false,
        path: [],
        totalCost: 0,
        totalDuration: newGraph.totalDuration,
        responsePathSource: 'error_empty',
        pathUsesSparseGeometry: false,
        sparseGeometryMaxJumpM: null,
        sparseGeometryEdgeCount: 0,
        selectedEdges: [],
      };
    }

    const alternateTId = findNearestNode(targetPos, newGraph.nodes, { excludeNodeId: aId });
    if (!alternateTId) {
      log.warn({
        sessionId: session.sessionId,
        aId, refetchGpsDistanceM: Math.round(refetchGpsDistanceM),
        sameNodeResolution: 'no_alternate',
      }, 'SAME_NODE_NO_ALTERNATE_REFETCH');
      return {
        success: false,
        path: [],
        totalCost: Infinity,
        totalDuration: newGraph.totalDuration,
        responsePathSource: 'error_empty',
        pathUsesSparseGeometry: false,
        sparseGeometryMaxJumpM: null,
        sparseGeometryEdgeCount: 0,
        selectedEdges: [],
      };
    }
    log.info({
      sessionId: session.sessionId,
      oldTargetNodeId: tId,
      newTargetNodeId: alternateTId,
      refetchGpsDistanceM: Math.round(refetchGpsDistanceM),
      sameNodeResolution: 'alternate_target_selected',
    }, 'SAME_NODE_TARGET_SNAP_ALTERNATE_SELECTED_REFETCH');
    tId = alternateTId;
  }

  // MT-D* Lite plans through the new graph
  const planner = new MTDStarLitePlanner(newGraph);
  planner.initialize(aId, tId);
  const ok = planner.computePath();

  // extractPath maps graph edges → road geometry — path must be pure road geometry
  const selectedTraversal = ok
    ? planner.extractPathWithEdges()
    : { path: [], edges: [] };
  let path = selectedTraversal.path;
  let responsePathSource: 'planner_prepared' | 'error_empty' | 'refetch_planner_failed_no_fallback' =
    ok && path.length >= 2 ? 'planner_prepared' : 'error_empty';

  // Scan for sparse geometry in the planner path only. Planner failure must not
  // fall back to routePolyline because Mapbox is a graph supplier, not path supplier.
  const plannerPathLen = path.length;
  const sparseMeta = (ok && plannerPathLen >= 2)
    ? planner.scanSparseGeometry(plannerPathLen)
    : { pathUsesSparseGeometry: false, sparseGeometryMaxJumpM: null as number | null, sparseGeometryEdgeCount: 0 };

  if (path.length < 2) {
    log.warn({
      sessionId: session.sessionId,
      reason,
      success: ok,
      pathLen: path.length,
      routePolylineLen: newGraph.routePolyline.length,
      responsePathSource: 'refetch_planner_failed_no_fallback',
    }, 'INVALID_PATH_TOO_SHORT_BLOCKED');
    log.warn({
      sessionId: session.sessionId,
      reason,
      routePolylineLen: newGraph.routePolyline.length,
      responsePathSource: 'refetch_planner_failed_no_fallback',
    }, 'ROUTEPOLYLINE_FALLBACK_FORBIDDEN');
    path = [];
    responsePathSource = 'refetch_planner_failed_no_fallback';
  }

  // Update session with fresh graph + planner state
  session.graph = newGraph;
  session.plannerState = planner.serialize();
  session.gpsFilterState = gps.serialize();
  session.lastAgentPos = agentPos;
  session.lastTargetPos = targetPos;
  session.lastRefetchTargetPos = targetPos;
  session.graphCenterPos = targetGraph.graphCenterPos;
  session.graphRadiusM = TARGET_GRAPH_RADIUS_M;
  session.updateCount++;
  if (session.mapboxUsage) {
    const corridorCalls    = mbResponses.length;
    const targetGraphCalls = targetGraph.rays.length;
    session.mapboxUsage.mapboxRefetchCalls    += corridorCalls + targetGraphCalls;
    session.mapboxUsage.mapboxCallsTotal      += corridorCalls + targetGraphCalls;
    session.mapboxUsage.mapboxCorridorCalls   += corridorCalls;
    session.mapboxUsage.mapboxTargetGraphCalls += targetGraphCalls;
  }
  await commitOrThrow(session.sessionId, lockToken, session);

  const usingPlannerPath = responsePathSource === 'planner_prepared';
  return {
    success: ok && path.length >= 2,
    path,
    totalCost: newGraph.totalDistance,
    totalDuration: newGraph.totalDuration,
    responsePathSource,
    pathUsesSparseGeometry:  usingPlannerPath ? sparseMeta.pathUsesSparseGeometry  : false,
    sparseGeometryMaxJumpM:  usingPlannerPath ? sparseMeta.sparseGeometryMaxJumpM   : null,
    sparseGeometryEdgeCount: usingPlannerPath ? sparseMeta.sparseGeometryEdgeCount  : 0,
    selectedEdges: usingPlannerPath ? selectedTraversal.edges : [],
  };
}

// ─── Refetch loop suppression ─────────────────────────────────────────────────
// After N consecutive refetches with the same reason and a usable routePolyline,
// stop calling Mapbox and return OK with the current routePolyline. This prevents
// infinite loops when a graph consistently fails (e.g. planner_failed every tick).
const SUPPRESS_AFTER_N = 2;

function shouldSuppressRefetch(
  session: SessionData,
  reason: string,
  targetPos: Coordinate,
): boolean {
  // Never suppress semantic failures — route is actively drifting from target
  if (reason === 'semantic_target_mismatch') return false;

  if (session.lastRefetchReason !== reason) return false;
  if ((session.consecutiveRefetchCount ?? 0) < SUPPRESS_AFTER_N) return false;
  if (session.graph.routePolyline.length < 2) return false;

  // Safety: don't serve a stale routePolyline if target has moved far from it.
  // routePolyline ends at the destination used when the graph was last built.
  const polyEnd = session.graph.routePolyline[session.graph.routePolyline.length - 1];
  const endToTargetM = haversine(polyEnd.lat, polyEnd.lng, targetPos.lat, targetPos.lng);
  if (endToTargetM > TARGET_CORRIDOR_THRESHOLD) {
    log.warn({
      sessionId: session.sessionId, reason, endToTargetM: Math.round(endToTargetM),
    }, 'SEMANTIC_REFETCH_SUPPRESSED_BLOCKED');
    return false;
  }

  return true;
}

function recordRefetch(session: SessionData, reason: string): void {
  if (session.lastRefetchReason === reason) {
    session.consecutiveRefetchCount = (session.consecutiveRefetchCount ?? 0) + 1;
  } else {
    session.consecutiveRefetchCount = 1;
    session.lastRefetchReason = reason;
  }
}

function resetRefetchTracking(session: SessionData): void {
  session.consecutiveRefetchCount = 0;
  session.lastRefetchReason = null;
}

// ─── Frozen road attachment validity (PATCH 6E) ───────────────────────────────
// Returns true when the frozen p is safe to use as LAST_ROAD_ATTACHMENT goal:
//   - all three attachment fields are set
//   - at least one of edgeFrom or edgeTo still exists in the current session graph
//   - target GPS is within 300m of frozen p (staleness guard)
function frozenAttachmentIsValid(session: SessionData, targetPos: Coordinate): boolean {
  if (!session.lastTargetRoadAttachmentPoint)    return false;
  if (!session.lastTargetRoadAttachmentEdgeFrom) return false;
  if (!session.lastTargetRoadAttachmentEdgeTo)   return false;
  if (
    !session.graph.nodes[session.lastTargetRoadAttachmentEdgeFrom] &&
    !session.graph.nodes[session.lastTargetRoadAttachmentEdgeTo]
  ) return false;
  const distFromFrozenP = haversine(
    targetPos.lat, targetPos.lng,
    session.lastTargetRoadAttachmentPoint.lat,
    session.lastTargetRoadAttachmentPoint.lng,
  );
  return distFromFrozenP <= 300;
}

type PrepareRenderablePathInput = Omit<
  BasePrepareRenderablePathInput,
  'routeStartAgentWarnM' | 'routeStartAgentBlockM' | 'log'
>;

function logRefetchResponseContractFixed(input: {
  reason: string;
  refetchSuccess: boolean;
  preparedOk: boolean;
  responseSuccess: boolean;
  responsePathLen: number;
  pathSource: string;
  // optional — populated when the refetch planner path used sparse geometry edges
  refetchPathUsesSparseGeometry?: boolean;
  refetchSparseGeometryMaxJumpM?: number | null;
  refetchSparseGeometryEdgeCount?: number;
}): void {
  log.info(input, 'REFETCH_RESPONSE_CONTRACT_FIXED');
}

function prepareRenderablePath(input: PrepareRenderablePathInput): PreparedRenderablePath {
  return prepareRenderablePathBase({
    ...input,
    routeStartAgentWarnM: ROUTE_START_AGENT_WARN_M,
    routeStartAgentBlockM: ROUTE_START_AGENT_BLOCK_M,
    log,
  });
}

async function handleRequest(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({
      error: 'Method not allowed',
    });
    return;
  }

  let routeProvenance: UpdateResponse['routeProvenance'] = null;

  // HTTP adapter note (Phase 2B): json()/lockFailureResponse() were originally
  // top-level helpers that called NextResponse.json() (App Router). Pages API
  // has no equivalent "return a Response object" — it sends via the `res`
  // object instead — so both are declared here, nested inside the handler,
  // purely so they can close over `res`. Neither function's business logic
  // changed: json() still centralizes withResponseDefaults() the same way,
  // and every one of the ~30 call sites below is untouched.
  function json(body: UpdateResponse, init?: ResponseInit): void {
    const responseBody = withResponseDefaults(body);
    finishBackendM1CandidateFromResponse(responseBody);
    res.status(init?.status ?? 200).json({
      ...responseBody,
      routeProvenance,
      research_events: getBackendResearchEvents(),
    });
  }

  // M4-B1.5: every lock-related failure shares the identical frontend-safe
  // shape (success:false, path:[], totalCost:0, status:'NO_ROUTE', HTTP 200) —
  // only `refetchReason` differs per M4-B1.4 §11's recommended taxonomy. This
  // keeps the 5 call sites (initial acquire + 4 catch branches) from repeating
  // the literal object and risking an accidental typo/divergence between them.
  // The frontend does not branch UX on the exact refetchReason string (only
  // logs it, M4-B1.2 §7/M4-B1.4 §11) — this is a backend-only diagnostic
  // refinement, zero frontend changes required.
  function lockFailureResponse(refetchReason: string) {
    return json({
      success: false,
      path: [],
      totalCost: 0,
      status: 'NO_ROUTE',
      refetchReason,
      suggestedPollIntervalMs: 2000,
    });
  }

  const t0 = Date.now();
  // Declared outside the try so `finally` can always attempt release, on
  // every exit path (success, busy, SessionLockLostError, AppError, or an
  // unexpected error) — M4-B1.2 §6, M4-B1.2.1 §11.
  let lockToken: string | null = null;
  let lockedSessionId: string | null = null;
  try {
    const body: unknown = req.body;
    const parsed = validateBody(UpdateRequestSchema, body);
    const { sessionId, agentPos, targetPos, costChanges } = parsed;
    routeProvenance = parsed.routeProvenance ?? null;

    // 0. Acquire the session lock BEFORE any session read — covers loadSession,
    // planner computation, Mapbox/refetch work, and every session commit for
    // the remainder of this request (M4-B1.2 §5 critical-section placement).
    lockedSessionId = sessionId;
    const acquireResult = await acquireSessionLock(sessionId);
    if (!acquireResult.acquired) {
      // Fails closed for every reason — never continues unlocked
      // (M4-B1.2.1 §4). Frontend-safe response in all cases — lands in the
      // existing non-destructive `routeTemporarilyUnavailable` UX path with
      // zero frontend changes (M4-B1.2 §7) — but `refetchReason` now
      // distinguishes ordinary contention from an infrastructure problem
      // (M4-B1.4 §11 taxonomy), so backend logs/diagnostics are no longer
      // conflated even though the frontend UX intentionally stays identical.
      switch (acquireResult.reason) {
        case 'busy':
          return lockFailureResponse('session_locked');
        case 'capability_unavailable':
          return lockFailureResponse('session_lock_capability_unavailable');
        case 'backend_unavailable':
          return lockFailureResponse('session_lock_backend_unavailable');
      }
    }
    lockToken = acquireResult.token;

    // 1. Load session
    const session = await loadSession(sessionId);
    if (session.mapboxUsage) {
      session.mapboxUsage.updateTicks++;
    }

    // 2. GPS smooth (agent เท่านั้น — target มาจาก server ไม่ต้อง smooth)
    const gps = GPSKalmanFilter.deserialize(session.gpsFilterState);
    const smoothAgent = gps.update(agentPos.lat, agentPos.lng, 10);
    const pollMs = gps.getSuggestedPollIntervalMs();
    log.info({
      rawAgentPos:  { lat: agentPos.lat, lng: agentPos.lng },
      smoothAgent:  { lat: smoothAgent.lat, lng: smoothAgent.lng },
      deltaLat:     Math.abs(agentPos.lat - smoothAgent.lat),
      deltaLng:     Math.abs(agentPos.lng - smoothAgent.lng),
    }, 'AGENT_SMOOTH_DEBUG');

    // Navigation mode — set at init, default local_hybrid for sessions without it
    const navMode: NavDistanceMode = session.navigationMode ?? 'local_hybrid';
    log.info({ navMode, sessionId }, navMode === 'long_distance' ? 'LONG_DISTANCE_MODE_ENABLED' : 'LOCAL_HYBRID_MODE_ENABLED');

    // Mode-aware forward drift threshold — selected once per tick
    const targetForwardThresholdM = navMode === 'long_distance'
      ? LONG_DISTANCE_TARGET_FORWARD_THRESHOLD_M
      : LOCAL_TARGET_FORWARD_THRESHOLD_M;
    log.info({ navMode, targetForwardThresholdM, sessionId }, 'TARGET_FORWARD_DRIFT_THRESHOLD_SELECTED');

    // 3. Replan check — two independent thresholds:
    //   Agent: distanceToCorridor > 100m → ambulance ออกนอกเส้นทาง
    //   Target: distanceToCorridor > 200m → patient อยู่นอก corridor ไกลมาก
    //           (200m เผื่อ patient อยู่ในอาคาร/มหาวิทยาลัย ห่างจากถนน ~100m)
    const agentDist = distanceToCorridor(smoothAgent, session.graph.routePolyline);
    const targetDist = distanceToCorridor(targetPos, session.graph.routePolyline);
    // targetMovedM — คำนวณเพื่อ log เท่านั้น ไม่ใช้เป็น replan trigger
    const targetMovedM = haversine(
      targetPos.lat, targetPos.lng,
      session.lastTargetPos.lat, session.lastTargetPos.lng,
    );

    // ── Phase 1 telemetry: dry-run edge projection ────────────────────────────
    // Read-only — does NOT change routing behavior, path, tId, or goalChanged.
    const targetProjection = findNearestEdgeProjection(targetPos, session.graph);
    const wouldUseProjection = targetProjection !== null &&
      targetProjection.distanceM <= TARGET_EDGE_PROJECTION_THRESHOLD_M;
    let projectionFallbackReason: string | null = null;

    if (targetProjection !== null) {
      log.info({
        sessionId,
        targetPos,
        projectedPoint:                 targetProjection.projectedPoint,
        targetProjectionDistanceM:      Math.round(targetProjection.distanceM),
        projectedEdgeFrom:              targetProjection.edgeFrom,
        projectedEdgeTo:                targetProjection.edgeTo,
        projectedDistanceAlongEdgeM:    Math.round(targetProjection.distanceAlongEdgeM),
        projectedRatio:                 Math.round(targetProjection.projectedRatio * 1000) / 1000,
        segmentIndex:                   targetProjection.segmentIndex,
        geometryPointCount:             targetProjection.geometryPointCount,
        targetMovedM:                   Math.round(targetMovedM * 10) / 10,
        wouldUseProjection,
        warnThresholdM:                 TARGET_EDGE_PROJECTION_WARN_M,
        thresholdM:                     TARGET_EDGE_PROJECTION_THRESHOLD_M,
      }, 'TARGET_EDGE_PROJECTION_CANDIDATE');

      if (targetProjection.distanceM > TARGET_EDGE_PROJECTION_THRESHOLD_M) {
        projectionFallbackReason = 'projection_too_far';
        log.info({
          sessionId,
          targetPos,
          reason:                    projectionFallbackReason,
          targetProjectionDistanceM: Math.round(targetProjection.distanceM),
          threshold:                 TARGET_EDGE_PROJECTION_THRESHOLD_M,
        }, 'TARGET_EDGE_PROJECTION_FALLBACK_MAPBOX');
      }
    } else {
      projectionFallbackReason = 'no_edge_geometry';
      log.info({
        sessionId,
        targetPos,
        reason:                    projectionFallbackReason,
        targetProjectionDistanceM: null,
        threshold:                 TARGET_EDGE_PROJECTION_THRESHOLD_M,
      }, 'TARGET_EDGE_PROJECTION_FALLBACK_MAPBOX');
    }

    // targetForwardDistM — distance from last graph build position to current target.
    // Catches the blind spot: target advancing along route within perpendicular threshold
    // but past the graph's coverage area (no refetch would otherwise fire).
    const lastRefetchTargetPos =
      session.lastRefetchTargetPos ?? session.lastTargetPos ?? targetPos;
    const targetForwardDistM = haversine(
      targetPos.lat, targetPos.lng,
      lastRefetchTargetPos.lat, lastRefetchTargetPos.lng,
    );

    // Path truth tracking — populated as we advance through the pipeline (Patch 1)
    let truthPlannerAttempted = false;
    let truthPlannerSucceeded: boolean | null = null;
    let truthRawPlannerPath: Coordinate[] | null = null;
    let truthMaxPathJumpM = 0;

    // MT-D* First: evaluate graph coverage before committing to Mapbox refetch.
    // Coverage is graph-based only: edge projection + nearest graph node distance.
    // routePolyline/corridor distance remains telemetry and separate off-route signal.
    const coverageNearestNodeId = findNearestNode(targetPos, session.graph.nodes);
    const coverageNearestNode = coverageNearestNodeId ? session.graph.nodes[coverageNearestNodeId] : null;
    const coverageNearestNodeDistance = coverageNearestNode
      ? haversine(targetPos.lat, targetPos.lng, coverageNearestNode.lat, coverageNearestNode.lng)
      : null;
    const graphCoverage = evaluateGraphCoverage({
      targetPos,
      graph: session.graph,
      projection: targetProjection,
      nearestNodeDistance: coverageNearestNodeDistance,
      plannerReachable: null,
    });
    const targetCoveredBySessionGraph = graphCoverage.covered;
    const targetCoverageReason: string | null = graphCoverage.reason;
    // Closure reads live truth-tracking variables — must be called at appendMetric time, not earlier.
    const mkTruth = (): AppendMetricTruth => ({
      targetCoveredBySessionGraph,
      targetCoverageReason,
      plannerAttempted: truthPlannerAttempted,
      plannerSucceeded: truthPlannerSucceeded,
    });
    let targetForwardDriftSuppressed = false;

    // ── Target attachment validity gate (M4-E2) ────────────────────────────────
    // targetCoveredBySessionGraph (above) is geographic proximity only — it
    // stays true out to 150m and says nothing about whether the target is
    // actually attachable to a valid road edge (M4-E0/M4-E1). This gate answers
    // the stricter question and, when invalid beyond grace, forces a Mapbox
    // refetch even while targetCoveredBySessionGraph is still true.
    const targetAttachment = evaluateTargetAttachment({
      projection: targetProjection,
      thresholds: { attachedM: TARGET_EDGE_PROJECTION_THRESHOLD_M },
    });
    const targetAttachmentValid = targetAttachment.valid;
    const targetAttachmentBand = targetAttachment.band;
    const targetAttachmentInvalidReason = targetAttachment.invalidReason;

    const prevAttachmentInvalidStreak = session.targetAttachmentInvalidStreak ?? 0;
    const targetAttachmentInvalidStreak = targetAttachmentBand === 'ATTACHED'
      ? 0
      : prevAttachmentInvalidStreak + 1;
    session.targetAttachmentInvalidStreak = targetAttachmentInvalidStreak;

    // GRACE absorbs ATTACHMENT_GRACE_TICKS consecutive invalid ticks (GPS
    // jitter right at the 30m seam); SUSPECT/OUTSIDE are actionable immediately.
    const attachmentInvalidActionable =
      !targetAttachmentValid &&
      (targetAttachmentBand !== 'GRACE' || targetAttachmentInvalidStreak >= ATTACHMENT_GRACE_TICKS);

    const attachmentMapboxDecision = shouldCallMapbox({
      targetCoveredBySessionGraph,
      attachmentInvalid: attachmentInvalidActionable,
    });

    log.info({
      sessionId,
      targetAttachmentValid,
      targetAttachmentBand,
      targetAttachmentInvalidReason,
      targetAttachmentInvalidStreak,
      targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
      targetCoveredBySessionGraph,
      targetCoverageReason,
      attachmentInvalidActionable,
      mapboxPolicyReason: attachmentMapboxDecision.reason,
    }, targetAttachmentBand === 'ATTACHED' ? 'TARGET_ATTACHMENT_VALID' : 'TARGET_ATTACHMENT_INVALID');

    if (attachmentInvalidActionable && attachmentMapboxDecision.allowed) {
      const attachmentRefetchReason = 'attachment_invalid';
      if (shouldSuppressRefetch(session, attachmentRefetchReason, targetPos)) {
        log.warn({
          sessionId,
          reason: attachmentRefetchReason,
          consecutiveRefetchCount: session.consecutiveRefetchCount,
          targetAttachmentBand,
        }, 'REFETCH_SUPPRESSED_LOOP_DETECTED');
      } else {
        log.warn({
          sessionId,
          targetAttachmentBand,
          targetAttachmentInvalidReason,
          targetAttachmentInvalidStreak,
          targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
          targetCoveredBySessionGraph,
          targetCoverageReason,
          mapboxPolicyReason: attachmentMapboxDecision.reason,
        }, 'ATTACHMENT_INVALID_REFETCH');
        recordRefetch(session, attachmentRefetchReason);
        try {
          const result = await refetchRoute(
            session, smoothAgent, targetPos, gps,
            `target attachment invalid (band=${targetAttachmentBand}, projectionDistanceM=${targetProjection !== null ? Math.round(targetProjection.distanceM) : 'null'})`,
            lockToken,
          );
          const prepared = prepareRenderablePath({
            path: result.path,
            smoothAgent,
            source: 'attachment_invalid_refetch',
            reason: attachmentRefetchReason,
          });
          if (!prepared.ok) {
            const blockMs = Date.now() - t0;
            const blockMetric: NavMetric = {
              timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
              status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              stepMs: 0, totalMs: blockMs,
              pathLen: 0, totalCost: Infinity,
              maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
              targetCorridorM: Math.round(targetDist),
              targetForwardDistM: Math.round(targetForwardDistM),
              refetchReason: attachmentRefetchReason,
              responsePathSource: 'error_empty',
              pathReachesTarget: false,
              terminatesEarly: true,
              targetAttachmentValid,
              targetAttachmentBand,
              targetAttachmentInvalidReason,
              targetAttachmentInvalidStreak,
              targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
            };
            log.info(blockMetric, 'NAV_METRIC');
            logRefetchResponseContractFixed({
              reason: attachmentRefetchReason,
              refetchSuccess: result.success,
              preparedOk: false,
              responseSuccess: false,
              responsePathLen: 0,
              pathSource: 'error_empty',
            });
            logNavPathTruth({
              session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              refetchReason: attachmentRefetchReason, pathSource: 'error_empty',
              plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
              rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
              targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
              targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
              maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
            });
            appendMetric(session, blockMetric, mkTruth());
            await commitOrThrow(sessionId, lockToken, session);
            metrics.recordLatency(blockMs);
            return json({
              success: false,
              path: [],
              totalCost: Infinity,
              status: 'NO_ROUTE',
              suggestedPollIntervalMs: pollMs,
              refetchReason: attachmentRefetchReason,
              pathReachesTarget: false,
              terminatesEarly: true,
              lastMetric: blockMetric,
            });
          }

          const totalMs = Date.now() - t0;
          const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
          const responseSuccess = refetchStatus === 'OK';
          const preparedCost = pathCost(prepared.path);
          const metric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
            stepMs: 0, totalMs,
            pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
            maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: attachmentRefetchReason,
            responsePathSource: result.responsePathSource,
            targetAttachmentValid,
            targetAttachmentBand,
            targetAttachmentInvalidReason,
            targetAttachmentInvalidStreak,
            targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
          };
          log.info(metric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: attachmentRefetchReason,
            refetchSuccess: result.success,
            preparedOk: prepared.ok,
            responseSuccess,
            responsePathLen: responseSuccess ? prepared.path.length : 0,
            pathSource: result.responsePathSource,
          });
          logNavPathTruth({
            session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: attachmentRefetchReason, pathSource: result.responsePathSource,
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, metric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(totalMs);
          return json({
            success: responseSuccess,
            path: responseSuccess ? prepared.path : [],
            maneuvers: responseSuccess
              ? maneuversForPath(result.selectedEdges, prepared.path)
              : [],
            totalCost: Math.round(preparedCost),
            status: refetchStatus,
            suggestedPollIntervalMs: pollMs,
            estimatedTimeSeconds: Math.round(result.totalDuration),
            lastMetric: metric,
          });
        } catch (refetchErr) {
          // M4-E6: refetchRoute() (above) has its OWN internal commitOrThrow()
          // call (once it reaches a fresh graph) that can throw one of the four
          // specialized session-commit error classes below. This local catch
          // must not intercept those — rethrow them immediately, unconverted,
          // before any of the M4-E4 generic-failure persistence logic runs.
          // In particular SessionCommitOutcomeAmbiguousError means the first
          // commit's outcome is UNKNOWN; attempting a second high-level commit
          // from here (via the M4-E4 path below) could silently swallow or
          // reclassify that outcome instead of reaching the outer request
          // handler's dedicated mapping for each class (Codex M4-E5 finding).
          if (
            refetchErr instanceof SessionLockLostError ||
            refetchErr instanceof SessionLockCapabilityUnavailableError ||
            refetchErr instanceof SessionLockBackendUnavailableError ||
            refetchErr instanceof SessionCommitOutcomeAmbiguousError
          ) {
            throw refetchErr;
          }

          // M4-E4: recordRefetch() (above) and the targetAttachmentInvalidStreak
          // mutation (earlier in this gate) already happened on this in-memory
          // `session` object before refetchRoute() was called. refetchRoute()
          // normally persists the whole session itself (its own internal
          // commitOrThrow() call) once it reaches a fresh graph — but if it
          // throws before that point (e.g. Mapbox/network failure), that
          // internal commit never runs, and returning here without committing
          // would silently discard the anti-storm streak/counter mutations,
          // undermining the very suppression they exist to drive (M4-E3 finding).
          // Build and persist a failure metric with attachment diagnostics
          // through the existing fenced commit helper before returning.
          log.error({ err: String(refetchErr) }, 'Refetch failed (attachment invalid)');
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
            stepMs: 0, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: attachmentRefetchReason,
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
            targetAttachmentValid,
            targetAttachmentBand,
            targetAttachmentInvalidReason,
            targetAttachmentInvalidStreak,
            targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logNavPathTruth({
            session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: attachmentRefetchReason, pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          // Intentionally NOT wrapped in a nested try/catch: if commitOrThrow()
          // throws (SessionLockLostError / SessionLockCapabilityUnavailableError /
          // SessionLockBackendUnavailableError / SessionCommitOutcomeAmbiguousError),
          // it must propagate unchanged to this request's outer catch block, which
          // already has dedicated handling for each — do not collapse those into
          // a generic Mapbox/attachment error here.
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'ERROR',
            suggestedPollIntervalMs: 5000,
            refetchReason: attachmentRefetchReason,
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
          });
        }
      }
    }

    const targetForwardDriftDetected = targetForwardDistM > targetForwardThresholdM;
    const forwardDriftMapboxDecision = shouldCallMapbox({
      targetCoveredBySessionGraph,
      forwardDrift: targetForwardDriftDetected,
    });

    if (targetForwardDriftDetected && forwardDriftMapboxDecision.allowed) {
      log.info({
        targetForwardDistM: Math.round(targetForwardDistM),
        targetPos,
        lastRefetchTargetPos,
        threshold: targetForwardThresholdM,
        targetCoveredBySessionGraph,
        targetCoverageReason,
        targetDist: Math.round(targetDist),
        targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
        targetForwardDriftDetected: true,
        prePlannerRefetchBlocked: false,
        mapboxPolicyReason: forwardDriftMapboxDecision.reason,
        navMode,
      }, 'FORWARD_DRIFT_REFETCH');
      try {
        const result = await refetchRoute(
          session, smoothAgent, targetPos, gps,
          `target forward drift (${Math.round(targetForwardDistM)}m > ${targetForwardThresholdM}m, navMode=${navMode})`,
          lockToken,
        );

        // ── Post-refetch target verification ──────────────────────────────────
        const verifyThreshold = navMode === 'long_distance'
          ? SEMANTIC_TARGET_GAP_THRESHOLD_LONG_M
          : SEMANTIC_TARGET_GAP_THRESHOLD_M;
        const fdNewTId   = findNearestNode(targetPos, session.graph.nodes);
        const fdNewTNode = fdNewTId ? session.graph.nodes[fdNewTId] : null;
        if (result.path.length >= 2 && fdNewTNode) {
          const fdLastPt        = result.path[result.path.length - 1];
          const fdPostGapM      = haversine(fdLastPt.lat, fdLastPt.lng, fdNewTNode.lat, fdNewTNode.lng);
          const fdVerifyLog     = { sessionId, postRefetchRoadGapM: Math.round(fdPostGapM), verifyThreshold, refetchReason: 'target_forward_drift', navMode };
          if (fdPostGapM <= verifyThreshold) {
            log.info(fdVerifyLog, 'TARGET_REFETCH_VERIFIED');
          } else {
            log.warn(fdVerifyLog, 'TARGET_REFETCH_STILL_STALE');
            // Refetch succeeded but route still doesn't reach target — block it.
            // Frontend must keep previous route; next tick may succeed after target moves.
            log.warn({ sessionId: session.sessionId, postRefetchRoadGapM: Math.round(fdPostGapM), verifyThreshold, navMode }, 'STALE_REFETCH_RESULT_BLOCKED');
            const fdBlockMs = Date.now() - t0;
            const fdBlockMetric: NavMetric = {
              timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
              status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              stepMs: 0, totalMs: fdBlockMs,
              pathLen: 0, totalCost: Infinity,
              maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
              targetCorridorM: Math.round(targetDist),
              targetForwardDistM: Math.round(targetForwardDistM),
              refetchReason: 'target_forward_drift',
              responsePathSource: 'error_empty',
              pathReachesTarget: false,
              terminatesEarly: true,
            };
            log.info(fdBlockMetric, 'NAV_METRIC');
            logRefetchResponseContractFixed({
              reason: 'target_forward_drift',
              refetchSuccess: result.success,
              preparedOk: false,
              responseSuccess: false,
              responsePathLen: 0,
              pathSource: 'error_empty',
            });
            logNavPathTruth({
              session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              refetchReason: 'target_forward_drift', pathSource: 'error_empty',
              plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
              rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
              targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
              targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
              maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
            });
            appendMetric(session, fdBlockMetric, mkTruth());
            await commitOrThrow(sessionId, lockToken, session);
            metrics.recordLatency(fdBlockMs);
            return json({
              success: false,
              path: [],
              totalCost: Infinity,
              status: 'NO_ROUTE',
              suggestedPollIntervalMs: pollMs,
              refetchReason: 'target_forward_drift',
              pathReachesTarget: false,
              terminatesEarly: true,
              lastMetric: fdBlockMetric,
            });
          }
        }

        const prepared = prepareRenderablePath({
          path: result.path,
          smoothAgent,
          source: 'target_forward_drift_refetch',
          reason: 'target_forward_drift',
        });
        if (!prepared.ok) {
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            stepMs: 0, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: 'target_forward_drift',
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: 'target_forward_drift',
            refetchSuccess: result.success,
            preparedOk: false,
            responseSuccess: false,
            responsePathLen: 0,
            pathSource: 'error_empty',
          });
          logNavPathTruth({
            session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: 'target_forward_drift', pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path.length > 0 ? prepared.path : null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'NO_ROUTE',
            suggestedPollIntervalMs: pollMs,
            refetchReason: 'target_forward_drift',
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
          });
        }

        const totalMs = Date.now() - t0;
        const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
        const responseSuccess = refetchStatus === 'OK';
        const preparedCost = pathCost(prepared.path);
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          stepMs: 0, totalMs,
          pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: 'target_forward_drift',
          responsePathSource: result.responsePathSource,
        };
        log.info(metric, 'NAV_METRIC');
        logRefetchResponseContractFixed({
          reason: 'target_forward_drift',
          refetchSuccess: result.success,
          preparedOk: prepared.ok,
          responseSuccess,
          responsePathLen: responseSuccess ? prepared.path.length : 0,
          pathSource: result.responsePathSource,
        });
        logNavPathTruth({
          session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: 'target_forward_drift', pathSource: result.responsePathSource,
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMs);
        return json({
          success: responseSuccess,
          path: responseSuccess ? prepared.path : [],
          maneuvers: responseSuccess
            ? maneuversForPath(result.selectedEdges, prepared.path)
            : [],
          totalCost: Math.round(preparedCost),
          status: refetchStatus,
          suggestedPollIntervalMs: pollMs,
          estimatedTimeSeconds: Math.round(result.totalDuration),
          lastMetric: metric,
        });
      } catch (refetchErr) {
        // M4-F1: refetchRoute() (above) has its OWN internal commitOrThrow()
        // call that can throw one of the four specialized session-commit
        // error classes. Rethrow them immediately, unconverted, before any
        // generic refetch-failure logging/response below — same pattern as
        // the attachment_invalid catch (M4-E6), applied here because this
        // catch does not attempt any commit of its own (M4-F0 audit).
        if (
          refetchErr instanceof SessionLockLostError ||
          refetchErr instanceof SessionLockCapabilityUnavailableError ||
          refetchErr instanceof SessionLockBackendUnavailableError ||
          refetchErr instanceof SessionCommitOutcomeAmbiguousError
        ) {
          throw refetchErr;
        }

        log.error({ err: String(refetchErr) }, 'Refetch failed (forward drift)');
        logNavPathTruth({
          session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: 'target_forward_drift', pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        return json({
          success: false, path: [], totalCost: Infinity,
          status: 'ERROR', suggestedPollIntervalMs: 5000,
        });
      }
    } else if (targetForwardDriftDetected) {
      // Drift detected but target is still inside session graph — suppress Mapbox refetch.
      // Fall through to findNearestNode → planner.step() → existing post-planner gates.
      targetForwardDriftSuppressed = true;
      log.info({
        targetForwardDistM: Math.round(targetForwardDistM),
        threshold: targetForwardThresholdM,
        targetCoveredBySessionGraph,
        targetCoverageReason,
        targetDist: Math.round(targetDist),
        targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
        targetForwardDriftDetected: true,
        targetForwardDriftSuppressed: true,
        prePlannerRefetchBlocked: true,
        plannerAttempted: false,
        mapboxPolicyReason: forwardDriftMapboxDecision.reason,
        navMode,
      }, 'FORWARD_DRIFT_SUPPRESSED_GRAPH_COVERS_TARGET');
    }

    const agentCorridorExceeded = agentDist > AGENT_CORRIDOR_THRESHOLD;
    const targetCorridorExceeded = targetDist > TARGET_CORRIDOR_THRESHOLD;
    const corridorExceeded = agentCorridorExceeded || targetCorridorExceeded;
    // M4-D0/M4-D1: pass agent/target corridor exceedance as distinct inputs —
    // shouldCallMapbox() now allows agent off-route unconditionally (route-
    // origin invalidation), independent of target-side graph coverage.
    const corridorMapboxDecision = shouldCallMapbox({
      targetCoveredBySessionGraph,
      agentCorridorExceeded,
      targetCorridorExceeded,
    });

    if (agentCorridorExceeded && targetCoveredBySessionGraph) {
      // M4-D1: this case is now ALLOWED (agent off-route overrides target
      // graph coverage) — previously misreported as "suppressed" under the
      // old merged corridorExceeded policy (M4-D0 root cause).
      log.info({
        sessionId,
        agentDist: Math.round(agentDist),
        threshold: AGENT_CORRIDOR_THRESHOLD,
        targetCoveredBySessionGraph,
        targetCoverageReason,
        targetDist: Math.round(targetDist),
        targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
        plannerAttempted: false,
        mapboxPolicyReason: corridorMapboxDecision.reason,
      }, 'AGENT_CORRIDOR_REFETCH_ALLOWED_OVERRIDE_TARGET_COVERED');
    }

    if (targetCorridorExceeded && !agentCorridorExceeded && targetCoveredBySessionGraph) {
      log.info({
        sessionId,
        targetDist: Math.round(targetDist),
        threshold: TARGET_CORRIDOR_THRESHOLD,
        targetCoveredBySessionGraph,
        targetCoverageReason,
        targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
        plannerAttempted: false,
        prePlannerRefetchBlocked: true,
        mapboxPolicyReason: corridorMapboxDecision.reason,
      }, 'CORRIDOR_REFETCH_SUPPRESSED_GRAPH_COVERS_TARGET');
    }

    const prePlannerCorridorRefetchNeeded =
      corridorExceeded && corridorMapboxDecision.allowed;

    if (prePlannerCorridorRefetchNeeded) {
      try {
        const result = await refetchRoute(
          session, smoothAgent, targetPos, gps,
          agentCorridorExceeded
            ? `Agent off-route (${Math.round(agentDist)}m from corridor)`
            : `Target out-of-corridor (${Math.round(targetDist)}m > ${TARGET_CORRIDOR_THRESHOLD}m)`,
          lockToken,
        );
        const refetchReason = agentCorridorExceeded ? 'agent_corridor_exceeded' : 'target_corridor_exceeded';
        const prepared = prepareRenderablePath({
          path: result.path,
          smoothAgent,
          source: 'corridor_refetch',
          reason: refetchReason,
        });
        if (!prepared.ok) {
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            stepMs: 0, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason,
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: refetchReason,
            refetchSuccess: result.success,
            preparedOk: false,
            responseSuccess: false,
            responsePathLen: 0,
            pathSource: 'error_empty',
          });
          logNavPathTruth({
            session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason, pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'NO_ROUTE',
            suggestedPollIntervalMs: pollMs,
            refetchReason,
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
          });
        }
        const totalMs = Date.now() - t0;
        const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
        const responseSuccess = refetchStatus === 'OK';
        const preparedCost = pathCost(prepared.path);
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          stepMs: 0, totalMs,
          pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason,
          responsePathSource: result.responsePathSource,
        };
        log.info(metric, 'NAV_METRIC');
        logRefetchResponseContractFixed({
          reason: refetchReason,
          refetchSuccess: result.success,
          preparedOk: prepared.ok,
          responseSuccess,
          responsePathLen: responseSuccess ? prepared.path.length : 0,
          pathSource: result.responsePathSource,
        });
        logNavPathTruth({
          session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          refetchReason, pathSource: result.responsePathSource,
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMs);
        return json({
          success: responseSuccess,
          path: responseSuccess ? prepared.path : [],
          maneuvers: responseSuccess
            ? maneuversForPath(result.selectedEdges, prepared.path)
            : [],
          totalCost: Math.round(preparedCost),
          status: refetchStatus,
          suggestedPollIntervalMs: pollMs,
          estimatedTimeSeconds: Math.round(result.totalDuration),
          lastMetric: metric,
        });
      } catch (refetchErr) {
        // M4-F1: refetchRoute() (above) has its OWN internal commitOrThrow()
        // call that can throw one of the four specialized session-commit
        // error classes. Rethrow them immediately, unconverted, before any
        // generic refetch-failure logging/response below — same pattern as
        // the attachment_invalid catch (M4-E6), applied here because this
        // catch does not attempt any commit of its own (M4-F0 audit).
        if (
          refetchErr instanceof SessionLockLostError ||
          refetchErr instanceof SessionLockCapabilityUnavailableError ||
          refetchErr instanceof SessionLockBackendUnavailableError ||
          refetchErr instanceof SessionCommitOutcomeAmbiguousError
        ) {
          throw refetchErr;
        }

        log.error({ err: String(refetchErr) }, 'Refetch failed (corridor)');
        logNavPathTruth({
          session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: agentCorridorExceeded ? 'agent_corridor_exceeded' : 'target_corridor_exceeded',
          pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        return json({
          success: false, path: [], totalCost: Infinity,
          status: 'ERROR', suggestedPollIntervalMs: 5000,
        });
      }
    }

    // 4. Snap to graph
    const aId = findNearestNode(smoothAgent, session.graph.nodes);
    let tId = findNearestNode(targetPos, session.graph.nodes);
    if (!aId || !tId) {
      logNavPathTruth({
        session, status: 'ERROR', replanType: 'incremental', mapboxApiCalled: false,
        refetchReason: 'no_nearest_node', pathSource: 'error_empty',
        plannerAttempted: false, plannerSucceeded: null,
        rawPlannerPath: null, preparedPath: null, responsePath: [],
        targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
        targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
        maxPathJumpM: 0, jumpThresholdM: MAX_PATH_JUMP_M,
      });
      return json({ success: false, path: [], totalCost: Infinity, status: 'ERROR', suggestedPollIntervalMs: pollMs });
    }

    // ── DEBUG: ตรวจ snap quality + corridor distance ──
    const aNode = session.graph.nodes[aId];
    let tNode = session.graph.nodes[tId];
    const aSnapDist = aNode
      ? haversine(smoothAgent.lat, smoothAgent.lng, aNode.lat, aNode.lng)
      : -1;
    let tSnapDist = tNode
      ? haversine(targetPos.lat, targetPos.lng, tNode.lat, tNode.lng)
      : -1;
    const prevGoal = session.plannerState.sgoal;
    let goalChanged = prevGoal !== tId;
    log.debug({
      sessionId,
      aId,
      tId,
      aSnapDistM: Math.round(aSnapDist),
      tSnapDistM: Math.round(tSnapDist),
      agentCorridorM: Math.round(agentDist),
      targetCorridorM: Math.round(targetDist),
      targetMovedM: Math.round(targetMovedM),
      goalChanged,
      targetForwardDriftSuppressed,
      plannerAttempted: true,
      replanType: 'incremental',
    }, 'SNAP_DEBUG');
    // Target ends at nearest road node — no walking connector, no off-road append
    log.info({ tId, tSnapDistM: Math.round(tSnapDist), targetPos }, 'TARGET_SNAPPED_TO_ROAD');

    // ── Same-node snap detection ──────────────────────────────────────────────
    const agentTargetGpsDistanceM = haversine(
      smoothAgent.lat, smoothAgent.lng, targetPos.lat, targetPos.lng,
    );
    if (aId === tId) {
      const alternateTId = agentTargetGpsDistanceM > SAME_NODE_ARRIVAL_THRESHOLD_M
        ? findNearestNode(targetPos, session.graph.nodes, { excludeNodeId: aId })
        : null;
      const sameNodeDecision = resolveSameNode({
        agentNodeId: aId,
        targetNodeId: tId,
        gpsDistance: agentTargetGpsDistanceM,
        arrivalThreshold: SAME_NODE_ARRIVAL_THRESHOLD_M,
        alternateNodeId: alternateTId,
      });

      log.info({
        sessionId,
        updateCount:             session.updateCount,
        aId,
        tId,
        agentTargetGpsDistanceM: Math.round(agentTargetGpsDistanceM),
        arrivalThresholdM:       SAME_NODE_ARRIVAL_THRESHOLD_M,
        agentPos:                smoothAgent,
        targetPos,
        graphNodeCount:          Object.keys(session.graph.nodes).length,
        graphEdgeCount:          Object.values(session.graph.edges).reduce((s, arr) => s + arr.length, 0),
        sameNodeSnapDetected:    true,
        sameNodeGpsDistanceM:    Math.round(agentTargetGpsDistanceM),
      }, 'SAME_NODE_SNAP_TRACE');

      if (sameNodeDecision.kind === 'ARRIVED') {
        // Agent is physically near target — no planner needed, no Mapbox refetch
        log.info({
          sessionId,
          agentTargetGpsDistanceM: Math.round(agentTargetGpsDistanceM),
          aId,
          sameNodeResolution: 'near_target_no_plan',
        }, 'SAME_NODE_NEAR_TARGET_NO_PLAN');
        const nearMs = Date.now() - t0;
        const nearMetric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: 'ARRIVED', replanType: 'incremental', mapboxApiCalled: false,
          stepMs: 0, totalMs: nearMs,
          pathLen: 0, totalCost: 0,
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: 'same_node_near_target',
          responsePathSource: 'same_node_arrived',
          pathReachesTarget: true,
          terminatesEarly: false,
        };
        log.info(nearMetric, 'NAV_METRIC');
        logNavPathTruth({
          session, status: 'ARRIVED', replanType: 'incremental', mapboxApiCalled: false,
          refetchReason: 'same_node_near_target', pathSource: 'same_node_arrived',
          plannerAttempted: false, plannerSucceeded: null,
          rawPlannerPath: null, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: 0, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, nearMetric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(nearMs);
        return json({
          success: true,
          path: [],
          totalCost: 0,
          status: 'ARRIVED',
          suggestedPollIntervalMs: pollMs,
          refetchReason: 'same_node_near_target',
          pathReachesTarget: true,
          terminatesEarly: false,
          lastMetric: nearMetric,
        });
      }

      // aId === tId but GPS distance > arrival threshold — find alternate target node
      if (sameNodeDecision.kind === 'SNAP_AMBIGUITY') {
        log.warn({
          sessionId,
          aId,
          agentTargetGpsDistanceM: Math.round(agentTargetGpsDistanceM),
          sameNodeResolution: 'no_alternate',
        }, 'SAME_NODE_NO_ALTERNATE');
        const noAltMs = Date.now() - t0;
        const noAltMetric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: 'NO_ROUTE', replanType: 'incremental', mapboxApiCalled: false,
          stepMs: 0, totalMs: noAltMs,
          pathLen: 0, totalCost: Infinity,
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: 'same_node_no_alternate',
          responsePathSource: 'error_empty',
          pathReachesTarget: false,
          terminatesEarly: true,
        };
        log.info(noAltMetric, 'NAV_METRIC');
        logNavPathTruth({
          session, status: 'NO_ROUTE', replanType: 'incremental', mapboxApiCalled: false,
          refetchReason: 'same_node_no_alternate', pathSource: 'error_empty',
          plannerAttempted: false, plannerSucceeded: null,
          rawPlannerPath: null, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: 0, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, noAltMetric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(noAltMs);
        return json({
          success: false,
          path: [],
          totalCost: Infinity,
          status: 'NO_ROUTE',
          suggestedPollIntervalMs: pollMs,
          refetchReason: 'same_node_no_alternate',
          pathReachesTarget: false,
          terminatesEarly: true,
          lastMetric: noAltMetric,
        });
      }
      if (sameNodeDecision.kind === 'ALTERNATE_TARGET_SELECTED') {
      log.info({
        sessionId,
        oldTargetNodeId:         sameNodeDecision.previousTargetNodeId,
        newTargetNodeId:         sameNodeDecision.targetNodeId,
        agentNodeId:             aId,
        agentTargetGpsDistanceM: Math.round(agentTargetGpsDistanceM),
        sameNodeResolution:      'alternate_target_selected',
      }, 'SAME_NODE_TARGET_SNAP_ALTERNATE_SELECTED');
      tId = sameNodeDecision.targetNodeId;
      tNode = session.graph.nodes[tId];
      tSnapDist = tNode
        ? haversine(targetPos.lat, targetPos.lng, tNode.lat, tNode.lng)
        : -1;
      goalChanged = prevGoal !== tId;
      }
    }

    // 5. MT-D* Lite incremental step — THE decision maker
    const planner = MTDStarLitePlanner.deserialize(session.graph, session.plannerState);
    startBackendM1Candidate();
    const stepStart = Date.now();
    const result = planner.step(aId, tId, costChanges);
    const selectedTraversal = result.success
      ? planner.extractPathWithEdges()
      : { path: [], edges: [] };
    const selectedEdges =
      selectedTraversal.path.length === result.path.length &&
      selectedTraversal.path.every((point, index) =>
        point.lat === result.path[index].lat && point.lng === result.path[index].lng)
      ? selectedTraversal.edges
      : [];
    const stepMs = Date.now() - stepStart;
    truthPlannerAttempted = true;
    truthPlannerSucceeded = result.success && result.path.length >= 2;
    truthRawPlannerPath = result.path;
    const rawPlannerJump = analyzePathJump(result.path);

    // 6. MT-D* Lite DECIDES: success + non-empty path → use it, otherwise → replan
    // result.path=[] with success=true means broken parent chain (extractPath failed)
    if (!result.success || result.path.length < 2) {
      // ─── MT-D* can't find path in corridor → replan via Mapbox ────────────
      log.warn({ sessionId, success: result.success, pathLen: result.path.length }, 'INVALID_ROAD_GEOMETRY');
      log.info({ sessionId, reason: 'planner_failed' }, 'GRAPH_UNRELIABLE_REFETCH');

      const plannerFailedReason = 'planner_failed';
      const plannerFailedMapboxDecision = shouldCallMapbox({
        targetCoveredBySessionGraph,
        plannerFailed: true,
      });
      const plannerFailedRefetchSuppressed =
        plannerFailedMapboxDecision.allowed && shouldSuppressRefetch(session, plannerFailedReason, targetPos);
      if (!plannerFailedMapboxDecision.allowed || plannerFailedRefetchSuppressed) {
        log.warn({
          sessionId, reason: plannerFailedReason,
          consecutiveRefetchCount: session.consecutiveRefetchCount,
          mapboxPolicyReason: plannerFailedMapboxDecision.reason,
          policyDenied: !plannerFailedMapboxDecision.allowed,
        }, plannerFailedMapboxDecision.allowed ? 'REFETCH_SUPPRESSED_LOOP_DETECTED' : 'MAPBOX_DENIED_BY_POLICY');
        const blockMs = Date.now() - t0;
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: 'NO_ROUTE', replanType: 'blocked', mapboxApiCalled: false,
          stepMs, totalMs: blockMs,
          pathLen: 0, totalCost: Infinity,
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: plannerFailedReason,
          responsePathSource: 'error_empty',
          pathReachesTarget: false,
          terminatesEarly: true,
        };
        log.info(metric, 'NAV_METRIC');
        logNavPathTruth({
          session, status: 'NO_ROUTE', replanType: 'blocked', mapboxApiCalled: false,
          refetchReason: plannerFailedReason, pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(blockMs);
        return json({
          success: false,
          path: [],
          totalCost: Infinity,
          status: 'NO_ROUTE',
          suggestedPollIntervalMs: pollMs,
          refetchReason: plannerFailedReason,
          pathReachesTarget: false,
          terminatesEarly: true,
          lastMetric: metric,
        });
      }

      recordRefetch(session, plannerFailedReason);
      try {
        const refetch = await refetchRoute(
          session, smoothAgent, targetPos, gps,
          'MT-D* Lite path failure — replanning',
          lockToken,
        );
        const prepared = prepareRenderablePath({
          path: refetch.path,
          smoothAgent,
          source: 'planner_failed_refetch',
          reason: 'planner_failed',
        });
        if (!prepared.ok) {
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            stepMs, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: 'planner_failed',
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: 'planner_failed',
            refetchSuccess: refetch.success,
            preparedOk: false,
            responseSuccess: false,
            responsePathLen: 0,
            pathSource: 'error_empty',
          });
          logNavPathTruth({
            session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: 'planner_failed', pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'NO_ROUTE',
            suggestedPollIntervalMs: pollMs,
            refetchReason: 'planner_failed',
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
          });
        }
        const totalMs = Date.now() - t0;
        const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
        const responseSuccess = refetchStatus === 'OK';
        const preparedCost = pathCost(prepared.path);
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          stepMs, totalMs,
          pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
          maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: 'planner_failed',
          responsePathSource: refetch.responsePathSource,
        };
        log.info(metric, 'NAV_METRIC');
        logRefetchResponseContractFixed({
          reason: 'planner_failed',
          refetchSuccess: refetch.success,
          preparedOk: prepared.ok,
          responseSuccess,
          responsePathLen: responseSuccess ? prepared.path.length : 0,
          pathSource: refetch.responsePathSource,
        });
        logNavPathTruth({
          session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: 'planner_failed', pathSource: refetch.responsePathSource,
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMs);
        return json({
          success: responseSuccess,
          path: responseSuccess ? prepared.path : [],
          maneuvers: responseSuccess
            ? maneuversForPath(refetch.selectedEdges, prepared.path)
            : [],
          totalCost: Math.round(preparedCost),
          status: refetchStatus,
          suggestedPollIntervalMs: pollMs,
          estimatedTimeSeconds: Math.round(refetch.totalDuration),
          lastMetric: metric,
        });
      } catch (replanErr) {
        // M4-F1: refetchRoute() (above) has its OWN internal commitOrThrow()
        // call that can throw one of the four specialized session-commit
        // error classes. Rethrow them immediately, unconverted, before any
        // generic refetch-failure logging/response below — same pattern as
        // the attachment_invalid catch (M4-E6), applied here because this
        // catch does not attempt any commit of its own (M4-F0 audit).
        if (
          replanErr instanceof SessionLockLostError ||
          replanErr instanceof SessionLockCapabilityUnavailableError ||
          replanErr instanceof SessionLockBackendUnavailableError ||
          replanErr instanceof SessionCommitOutcomeAmbiguousError
        ) {
          throw replanErr;
        }

        log.error({ err: String(replanErr) }, 'Replan refetch failed');
        logNavPathTruth({
          session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: 'planner_failed', pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        return json({
          success: false, path: [], totalCost: Infinity,
          status: 'ERROR', suggestedPollIntervalMs: 5000,
        });
      }
    }

    const agentMovedFromLastM = haversine(
      smoothAgent.lat, smoothAgent.lng,
      session.lastAgentPos.lat, session.lastAgentPos.lng,
    );
    // ─── MT-D* success → prepare renderable path through the common pipeline ───
    // Path ends at nearest road node — no walking connector, no direct target append.
    const preparedIncremental = prepareRenderablePath({
      path: result.path,
      smoothAgent,
      source: 'incremental_success',
      reason: 'incremental',
    });

    // ── TRIM_DEBUG: summary with session context (detail is inside TRIM_PROGRESS_DEBUG) ──
    log.info({
      sessionId,
      originalPathLen:   result.path.length,
      trimmedPathLen:    preparedIncremental.trimmedPathLen,
      agentMovedFromLastM: Math.round(agentMovedFromLastM),
      smoothAgent,
      pathFirstNode:     result.path[0],
      newFirstPoint:     preparedIncremental.path.length > 0 ? preparedIncremental.path[0] : null,
      pathLastPoint:     result.path[result.path.length - 1],
      newLastPoint:      preparedIncremental.path.length > 0 ? preparedIncremental.path[preparedIncremental.path.length - 1] : null,
      firstPointDistanceM: Number.isFinite(preparedIncremental.firstPointDistanceM)
        ? Math.round(preparedIncremental.firstPointDistanceM)
        : null,
      aId,
    }, 'TRIM_DEBUG');

    if (!preparedIncremental.ok) {
      const blockMs = Date.now() - t0;
      const blockMetric: NavMetric = {
        timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
        status: 'NO_ROUTE', replanType: 'incremental', mapboxApiCalled: false,
        stepMs, totalMs: blockMs,
        pathLen: 0, totalCost: Infinity,
        maxPathJumpM: 0, agentCorridorM: Math.round(agentDist),
        targetCorridorM: Math.round(targetDist),
        targetForwardDistM: Math.round(targetForwardDistM),
        refetchReason: 'incremental_renderable_path_blocked',
        pathReachesTarget: false,
        terminatesEarly: true,
      };
      log.info(blockMetric, 'NAV_METRIC');
      logNavPathTruth({
        session, status: 'NO_ROUTE', replanType: 'incremental', mapboxApiCalled: false,
        refetchReason: 'incremental_renderable_path_blocked', pathSource: 'error_empty',
        plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
        rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
        targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
        targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
        maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
      });
      appendMetric(session, blockMetric, mkTruth());
      await commitOrThrow(sessionId, lockToken, session);
      metrics.recordLatency(blockMs);
      return json({
        success: false,
        path: [],
        totalCost: Infinity,
        status: 'NO_ROUTE',
        suggestedPollIntervalMs: pollMs,
        refetchReason: 'incremental_renderable_path_blocked',
        pathReachesTarget: false,
        terminatesEarly: true,
        lastMetric: blockMetric,
      });
    }

    // ── TRIM_PROGRESS_STALLED: agent moved but path first point didn't advance ──
    // Fires when no trimming happened at all (trimmedLen = originalLen) despite movement.
    // Normal case: trimmedLen < originalLen (path shrinks as agent advances).
    if (agentMovedFromLastM > 15 && preparedIncremental.trimmedPathLen >= result.path.length) {
      log.warn({
        sessionId,
        agentMovedFromLastM:  Math.round(agentMovedFromLastM),
        originalPathLen:      result.path.length,
        trimmedPathLen:       preparedIncremental.trimmedPathLen,
        smoothAgent,
        pathFirstNode:        result.path[0],
        trimmedFirstPoint:    preparedIncremental.path[0],
      }, 'TRIM_PROGRESS_STALLED');
    }

    let finalPath = preparedIncremental.path;
    let remainingM = pathCost(finalPath);
    const jump = getMaxPathJump(finalPath);
    const pathJumpTrace = result.jumpTrace ?? null;
    truthMaxPathJumpM = jump.maxJumpM;

    // Telemetry: log jump analysis on both raw planner path and prepared/trimmed path
    // before the path_jump_threshold decision so every tick is observable.
    const preparedJump = analyzePathJump(finalPath);
    log.info({
      sessionId,
      updateCount: session.updateCount,
      stage: 'incremental',
      rawPlannerJump: {
        maxJumpM:    Math.round(rawPlannerJump.maxJumpM),
        maxJumpIndex: rawPlannerJump.maxJumpIndex,
        fromPoint:   rawPlannerJump.fromPoint,
        toPoint:     rawPlannerJump.toPoint,
        pathLen:     rawPlannerJump.pathLen,
      },
      preparedJump: {
        maxJumpM:    Math.round(preparedJump.maxJumpM),
        maxJumpIndex: preparedJump.maxJumpIndex,
        fromPoint:   preparedJump.fromPoint,
        toPoint:     preparedJump.toPoint,
        pathLen:     preparedJump.pathLen,
      },
      thresholdM:                  MAX_PATH_JUMP_M,
      plannerSucceeded:            truthPlannerSucceeded,
      rawPlannerPathLen:           result.path.length,
      preparedPathLen:             finalPath.length,
      targetCoveredBySessionGraph,
      targetCoverageReason,
      targetProjectionDistanceM:   targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
      targetCorridorM:             Math.round(targetDist),
      agentCorridorM:              Math.round(agentDist),
      jumpTrace:                   pathJumpTrace,
      jumpClassification:          pathJumpTrace?.jumpClassification ?? result.jumpClassification ?? 'unknown',
      jumpEdgeId:                  pathJumpTrace?.edgeId ?? null,
      jumpEdgeSource:              pathJumpTrace?.edgeSource ?? null,
      jumpGeometryPointCount:      pathJumpTrace?.geometryPointCount ?? null,
      jumpAllowed:                 null,
      responsePathSource:          'planner_prepared',
    }, 'NAV_PATH_JUMP_TRACE');

    // Path jump check — mode-aware.
    // long_distance: Mapbox routes have sparse intersections (large segments are expected).
    // local_hybrid: strict validation, any abnormal jump = graph unreliable = refetch.
    // sparseGeometryJumpAllowed: jump came from a Mapbox-sparse 2-point edge — do NOT refetch.
    let sparseGeometryJumpAllowed = false;
    if (navMode === 'long_distance') {
      log.info({
        maxJumpM: Math.round(jump.maxJumpM),
        navMode,
      }, 'PATH_VALIDATION_SKIPPED_LONG_DISTANCE');
    } else if (isSparseGeometryJumpAllowed({
      navMode,
      maxJumpM: jump.maxJumpM,
      maxPathJumpM: MAX_PATH_JUMP_M,
      pathUsesSparseGeometry: result.pathUsesSparseGeometry,
      sparseGeometryMaxJumpM: result.sparseGeometryMaxJumpM,
    })) {
      // Jump comes from a Mapbox-sparse 2-point edge (bestDistanceM=0, sliceLen=2) and
      // the observed jump matches the sparse edge's known gap (within 10m tolerance).
      // Refetching would return the same sparse Mapbox geometry — allow the path as-is.
      sparseGeometryJumpAllowed = true;
      log.info({
        sessionId,
        maxJumpM:                Math.round(jump.maxJumpM),
        thresholdM:              MAX_PATH_JUMP_M,
        jumpTrace:               withJumpAllowed(pathJumpTrace ?? undefined, true),
        jumpClassification:      pathJumpTrace?.jumpClassification ?? 'sparse_geometry',
        edgeId:                  pathJumpTrace?.edgeId ?? null,
        edgeSource:              pathJumpTrace?.edgeSource ?? null,
        geometryPointCount:      pathJumpTrace?.geometryPointCount ?? null,
        allowed:                 true,
        sparseGeometryMaxJumpM:  Math.round(result.sparseGeometryMaxJumpM!),
        sparseGeometryEdgeCount: result.sparseGeometryEdgeCount,
        responsePathSource:      'sparse_geometry_allowed',
      }, 'SPARSE_GEOMETRY_JUMP_ALLOWED');
    } else if (jump.maxJumpM > MAX_PATH_JUMP_M) {
      log.warn({
        maxJumpM:                Math.round(jump.maxJumpM),
        maxJumpIdx:              jump.maxJumpIdx,
        aroundJump:              jump.aroundJump,
        threshold:               MAX_PATH_JUMP_M,
        pathUsesSparseGeometry:  result.pathUsesSparseGeometry,
        sparseGeometryMaxJumpM:  result.sparseGeometryMaxJumpM !== null
                                   ? Math.round(result.sparseGeometryMaxJumpM) : null,
        sparseGeometryEdgeCount: result.sparseGeometryEdgeCount,
        jumpTrace:               withJumpAllowed(pathJumpTrace ?? undefined, false),
        jumpClassification:      pathJumpTrace?.jumpClassification ?? 'unknown',
        edgeId:                  pathJumpTrace?.edgeId ?? null,
        edgeSource:              pathJumpTrace?.edgeSource ?? null,
        geometryPointCount:      pathJumpTrace?.geometryPointCount ?? null,
        allowed:                 false,
      }, 'INVALID_ROAD_GEOMETRY');

      const jumpReason = 'path_jump_threshold';
      const pathJumpMapboxDecision = shouldCallMapbox({
        targetCoveredBySessionGraph,
        pathJump: true,
        pathUsesSparseGeometry: result.pathUsesSparseGeometry,
      });
      const pathJumpRefetchSuppressed =
        pathJumpMapboxDecision.allowed && shouldSuppressRefetch(session, jumpReason, targetPos);
      if (!pathJumpMapboxDecision.allowed || pathJumpRefetchSuppressed) {
        log.warn({
          sessionId, reason: jumpReason,
          consecutiveRefetchCount: session.consecutiveRefetchCount,
          mapboxPolicyReason: pathJumpMapboxDecision.reason,
          policyDenied: !pathJumpMapboxDecision.allowed,
        }, pathJumpMapboxDecision.allowed ? 'REFETCH_SUPPRESSED_LOOP_DETECTED' : 'MAPBOX_DENIED_BY_POLICY');
        const totalMsSuppressed = Date.now() - t0;
        const suppressedMetric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: 'NO_ROUTE', replanType: 'blocked', mapboxApiCalled: false,
          stepMs, totalMs: totalMsSuppressed,
          pathLen: 0, totalCost: Infinity,
          maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: jumpReason,
          responsePathSource: 'error_empty',
          pathReachesTarget: false,
          terminatesEarly: true,
          jumpClassification: pathJumpTrace?.jumpClassification ?? 'unknown',
          jumpEdgeId: pathJumpTrace?.edgeId ?? null,
          jumpEdgeSource: pathJumpTrace?.edgeSource ?? null,
          jumpGeometryPointCount: pathJumpTrace?.geometryPointCount ?? null,
          jumpAllowed: false,
        };
        log.info(suppressedMetric, 'NAV_METRIC');
        logNavPathTruth({
          session, status: 'NO_ROUTE', replanType: 'blocked', mapboxApiCalled: false,
          refetchReason: jumpReason, pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, suppressedMetric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMsSuppressed);
        return json({
          success: false,
          path: [],
          totalCost: Infinity,
          status: 'NO_ROUTE',
          suggestedPollIntervalMs: pollMs,
          refetchReason: jumpReason,
          pathReachesTarget: false,
          terminatesEarly: true,
          maxJumpM: Math.round(jump.maxJumpM),
          jumpClassification: pathJumpTrace?.jumpClassification ?? 'unknown',
          edgeId: pathJumpTrace?.edgeId ?? null,
          edgeSource: pathJumpTrace?.edgeSource ?? null,
          pathUsesSparseGeometry: result.pathUsesSparseGeometry,
          sparseGeometryMaxJumpM: result.sparseGeometryMaxJumpM,
          sparseGeometryEdgeCount: result.sparseGeometryEdgeCount,
          geometryPointCount: pathJumpTrace?.geometryPointCount ?? null,
          allowed: false,
          lastMetric: suppressedMetric,
        });
      }

      log.info({ sessionId, reason: jumpReason }, 'GRAPH_UNRELIABLE_REFETCH');
      recordRefetch(session, jumpReason);
      try {
        const refetch = await refetchRoute(
          session, smoothAgent, targetPos, gps,
          `path jump detected (${Math.round(jump.maxJumpM)}m > ${MAX_PATH_JUMP_M}m)`,
          lockToken,
        );
        if (refetch.path.length >= 2) {
          const postJump = getMaxPathJump(refetch.path);
          if (postJump.maxJumpM > MAX_PATH_JUMP_M) {
            log.warn({
              maxJumpM:                          Math.round(postJump.maxJumpM),
              maxJumpIdx:                        postJump.maxJumpIdx,
              aroundJump:                        postJump.aroundJump,
              refetchPathUsesSparseGeometry:     refetch.pathUsesSparseGeometry,
              refetchSparseGeometryMaxJumpM:     refetch.sparseGeometryMaxJumpM !== null
                                                   ? Math.round(refetch.sparseGeometryMaxJumpM) : null,
              refetchSparseGeometryEdgeCount:    refetch.sparseGeometryEdgeCount,
            }, 'PATH_JUMP_AFTER_REFETCH');
          }
        }
        const prepared = prepareRenderablePath({
          path: refetch.path,
          smoothAgent,
          source: 'path_jump_refetch',
          reason: jumpReason,
        });
        if (!prepared.ok) {
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            stepMs, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: jumpReason,
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: jumpReason,
            refetchSuccess: refetch.success,
            preparedOk: false,
            responseSuccess: false,
            responsePathLen: 0,
            pathSource: 'error_empty',
          });
          logNavPathTruth({
            session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: jumpReason, pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'NO_ROUTE',
            suggestedPollIntervalMs: pollMs,
            refetchReason: jumpReason,
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
          });
        }
        const totalMs = Date.now() - t0;
        const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
        const responseSuccess = refetchStatus === 'OK';
        const preparedCost = pathCost(prepared.path);
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          stepMs, totalMs,
          pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
          maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: jumpReason,
          responsePathSource: refetch.responsePathSource,
          pathUsesSparseGeometry:  refetch.pathUsesSparseGeometry,
          sparseGeometryMaxJumpM:  refetch.sparseGeometryMaxJumpM,
          sparseGeometryEdgeCount: refetch.sparseGeometryEdgeCount,
        };
        log.info(metric, 'NAV_METRIC');
        logRefetchResponseContractFixed({
          reason: jumpReason,
          refetchSuccess: refetch.success,
          preparedOk: prepared.ok,
          responseSuccess,
          responsePathLen: responseSuccess ? prepared.path.length : 0,
          pathSource: refetch.responsePathSource,
          refetchPathUsesSparseGeometry:  refetch.pathUsesSparseGeometry,
          refetchSparseGeometryMaxJumpM:  refetch.sparseGeometryMaxJumpM,
          refetchSparseGeometryEdgeCount: refetch.sparseGeometryEdgeCount,
        });
        logNavPathTruth({
          session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: jumpReason, pathSource: refetch.responsePathSource,
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMs);
        return json({
          success: responseSuccess,
          path: responseSuccess ? prepared.path : [],
          maneuvers: responseSuccess
            ? maneuversForPath(refetch.selectedEdges, prepared.path)
            : [],
          totalCost: Math.round(preparedCost),
          status: refetchStatus,
          suggestedPollIntervalMs: pollMs,
          estimatedTimeSeconds: Math.round(refetch.totalDuration),
          lastMetric: metric,
        });
      } catch (jumpRefetchErr) {
        // M4-F1: refetchRoute() (above) has its OWN internal commitOrThrow()
        // call that can throw one of the four specialized session-commit
        // error classes. Rethrow them immediately, unconverted, before any
        // generic refetch-failure logging/response below — same pattern as
        // the attachment_invalid catch (M4-E6), applied here because this
        // catch does not attempt any commit of its own (M4-F0 audit).
        if (
          jumpRefetchErr instanceof SessionLockLostError ||
          jumpRefetchErr instanceof SessionLockCapabilityUnavailableError ||
          jumpRefetchErr instanceof SessionLockBackendUnavailableError ||
          jumpRefetchErr instanceof SessionCommitOutcomeAmbiguousError
        ) {
          throw jumpRefetchErr;
        }

        log.error({ err: String(jumpRefetchErr) }, 'Refetch failed (path jump)');
        logNavPathTruth({
          session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: jumpReason, pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        return json({
          success: false, path: [], totalCost: Infinity,
          status: 'ERROR', suggestedPollIntervalMs: 5000,
        });
      }
    }

    // ── 7a. Semantic validation ────────────────────────────────────────────────
    // Geometry valid ≠ navigation semantics correct.
    // roadTargetGapM: road-to-road distance — haversine(path.last(), graph.nodes[tId]).
    // Should be ~0 when extractPath works correctly (path ends at sgoal=tId by design).
    // targetGpsToRouteEndM: GPS patient position to path end — diagnostic only, NOT a refetch trigger
    //   (includes building offset; always larger than roadTargetGapM in indoor/campus scenarios).
    const pathEndpoint = finalPath[finalPath.length - 1];
    const roadTargetGapM = tNode
      ? haversine(pathEndpoint.lat, pathEndpoint.lng, tNode.lat, tNode.lng)
      : -1;
    const targetGpsToRouteEndM = haversine(
      targetPos.lat, targetPos.lng,
      pathEndpoint.lat, pathEndpoint.lng,
    );

    const semanticThreshold = navMode === 'long_distance'
      ? SEMANTIC_TARGET_GAP_THRESHOLD_LONG_M
      : SEMANTIC_TARGET_GAP_THRESHOLD_M;
    const changedNodeThreshold = navMode === 'long_distance'
      ? SEMANTIC_CHANGED_NODE_THRESHOLD_LONG_M
      : SEMANTIC_CHANGED_NODE_THRESHOLD_M;
    // When snapped node changed apply tighter threshold — route tail must update faster.
    const effectiveThreshold = goalChanged ? changedNodeThreshold : semanticThreshold;

    log.info({
      roadTargetGapM:              roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
      targetGpsToRouteEndM:        Math.round(targetGpsToRouteEndM),
      targetSnapDistanceM:         Math.round(tSnapDist),
      snappedTargetNodeChanged:    goalChanged,
      snappedTargetNodeId:         tId,
      previousSnappedTargetNodeId: prevGoal !== tId ? prevGoal : null,
      effectiveThreshold,
      semanticThreshold,
      navMode,
    }, 'PATH_ENDPOINT_SEMANTIC_DISTANCE');

    // Non-trivial sub-threshold mismatch — useful for diagnosing stale parent chains
    if (roadTargetGapM > 5 && roadTargetGapM <= effectiveThreshold) {
      log.info({
        sessionId,
        roadTargetGapM:   Math.round(roadTargetGapM),
        effectiveThreshold,
        tId,
        prevGoal,
        goalChanged,
      }, 'EXTRACTPATH_ENDPOINT_MISMATCH');
    }

    log.info(
      { tId, prevGoal, tSnapDistM: Math.round(tSnapDist) },
      goalChanged ? 'TARGET_SNAP_NODE_CHANGED' : 'TARGET_SNAP_NODE_REUSED',
    );

    // When snapped node changes, log that we are revalidating with the tighter changedNodeThreshold.
    // This makes it explicit that the effectiveThreshold is now stricter.
    if (goalChanged) {
      log.info({
        sessionId,
        tId,
        prevGoal,
        roadTargetGapM:       roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
        changedNodeThreshold,
        effectiveThreshold,
        navMode,
      }, 'TARGET_NODE_CHANGED_REVALIDATE');
    }

    if (roadTargetGapM >= 0 && roadTargetGapM > effectiveThreshold) {
      log.warn({
        sessionId,
        roadTargetGapM:       Math.round(roadTargetGapM),
        targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
        targetSnapDistanceM:  Math.round(tSnapDist),
        effectiveThreshold,
        goalChanged,
        navMode,
        tId,
      }, 'GRAPH_SEMANTICALLY_STALE');

      const semanticReason = 'semantic_target_mismatch';
      const semanticMapboxDecision = shouldCallMapbox({
        targetCoveredBySessionGraph,
        semanticStale: true,
      });
      // semantic_target_mismatch is never suppressible — see shouldSuppressRefetch()
      log.warn({
        sessionId,
        tId, prevGoal, goalChanged,
        roadTargetGapM:      Math.round(roadTargetGapM),
        effectiveThreshold,
        changedNodeThreshold,
        semanticThreshold,
        navMode,
        mapboxPolicyReason: semanticMapboxDecision.reason,
      }, 'SEMANTIC_TARGET_MISMATCH_REFETCH');
      recordRefetch(session, semanticReason);
      try {
        const refetch = await refetchRoute(
          session, smoothAgent, targetPos, gps,
          `graph semantically stale — road gap ${Math.round(roadTargetGapM)}m > threshold ${effectiveThreshold}m (navMode=${navMode}, goalChanged=${goalChanged})`,
          lockToken,
        );

        // ── Post-refetch target verification ──────────────────────────────────
        const smNewTId   = findNearestNode(targetPos, session.graph.nodes);
        const smNewTNode = smNewTId ? session.graph.nodes[smNewTId] : null;
        if (refetch.path.length >= 2 && smNewTNode) {
          const smLastPt    = refetch.path[refetch.path.length - 1];
          const smPostGapM  = haversine(smLastPt.lat, smLastPt.lng, smNewTNode.lat, smNewTNode.lng);
          const smVerifyLog = {
            sessionId, postRefetchRoadGapM: Math.round(smPostGapM),
            effectiveThreshold, refetchReason: semanticReason, navMode,
            prevRoadTargetGapM: Math.round(roadTargetGapM),
          };
          if (smPostGapM <= effectiveThreshold) {
            log.info(smVerifyLog, 'TARGET_REFETCH_VERIFIED');
          } else {
            log.warn(smVerifyLog, 'TARGET_REFETCH_STILL_STALE');
            // Semantic mismatch persists after refetch — block the stale result.
            log.warn({ sessionId: session.sessionId, postRefetchRoadGapM: Math.round(smPostGapM), effectiveThreshold, navMode }, 'STALE_REFETCH_RESULT_BLOCKED');
            const smBlockMs = Date.now() - t0;
            const smBlockMetric: NavMetric = {
              timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
              status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              stepMs, totalMs: smBlockMs,
              pathLen: 0, totalCost: Infinity,
              maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
              targetCorridorM: Math.round(targetDist),
              targetForwardDistM: Math.round(targetForwardDistM),
              refetchReason: semanticReason,
              targetGapM: Math.round(roadTargetGapM),
              responsePathSource: 'error_empty',
              pathReachesTarget: false,
              terminatesEarly: true,
              roadTargetGapM: Math.round(roadTargetGapM),
              targetSnapDistanceM: Math.round(tSnapDist),
              snappedTargetNodeChanged: goalChanged,
              targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
              snappedTargetNodeId: tId,
              previousSnappedTargetNodeId: prevGoal !== tId ? prevGoal : null,
            };
            log.info(smBlockMetric, 'NAV_METRIC');
            logRefetchResponseContractFixed({
              reason: semanticReason,
              refetchSuccess: refetch.success,
              preparedOk: false,
              responseSuccess: false,
              responsePathLen: 0,
              pathSource: 'error_empty',
            });
            logNavPathTruth({
              session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
              refetchReason: semanticReason, pathSource: 'error_empty',
              plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
              rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
              targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
              targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
              maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
            });
            appendMetric(session, smBlockMetric, mkTruth());
            await commitOrThrow(sessionId, lockToken, session);
            metrics.recordLatency(smBlockMs);
            return json({
              success: false,
              path: [],
              totalCost: Infinity,
              status: 'NO_ROUTE',
              suggestedPollIntervalMs: pollMs,
              refetchReason: semanticReason,
              pathReachesTarget: false,
              terminatesEarly: true,
              lastMetric: smBlockMetric,
              roadTargetGapM: Math.round(roadTargetGapM),
              targetSnapDistanceM: Math.round(tSnapDist),
              snappedTargetNodeChanged: goalChanged,
              targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
            });
          }
        }

        const prepared = prepareRenderablePath({
          path: refetch.path,
          smoothAgent,
          source: 'semantic_target_mismatch_refetch',
          reason: semanticReason,
        });
        if (!prepared.ok) {
          const blockMs = Date.now() - t0;
          const blockMetric: NavMetric = {
            timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
            status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            stepMs, totalMs: blockMs,
            pathLen: 0, totalCost: Infinity,
            maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
            targetCorridorM: Math.round(targetDist),
            targetForwardDistM: Math.round(targetForwardDistM),
            refetchReason: semanticReason,
            targetGapM: Math.round(roadTargetGapM),
            responsePathSource: 'error_empty',
            pathReachesTarget: false,
            terminatesEarly: true,
            roadTargetGapM: Math.round(roadTargetGapM),
            targetSnapDistanceM: Math.round(tSnapDist),
            snappedTargetNodeChanged: goalChanged,
            targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
            snappedTargetNodeId: tId,
            previousSnappedTargetNodeId: prevGoal !== tId ? prevGoal : null,
          };
          log.info(blockMetric, 'NAV_METRIC');
          logRefetchResponseContractFixed({
            reason: semanticReason,
            refetchSuccess: refetch.success,
            preparedOk: false,
            responseSuccess: false,
            responsePathLen: 0,
            pathSource: 'error_empty',
          });
          logNavPathTruth({
            session, status: 'NO_ROUTE', replanType: 'refetch', mapboxApiCalled: true,
            refetchReason: semanticReason, pathSource: 'error_empty',
            plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
            rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
            targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
            targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
            maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
          });
          appendMetric(session, blockMetric, mkTruth());
          await commitOrThrow(sessionId, lockToken, session);
          metrics.recordLatency(blockMs);
          return json({
            success: false,
            path: [],
            totalCost: Infinity,
            status: 'NO_ROUTE',
            suggestedPollIntervalMs: pollMs,
            refetchReason: semanticReason,
            pathReachesTarget: false,
            terminatesEarly: true,
            lastMetric: blockMetric,
            roadTargetGapM: Math.round(roadTargetGapM),
            targetSnapDistanceM: Math.round(tSnapDist),
            snappedTargetNodeChanged: goalChanged,
            targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
          });
        }

        const totalMs = Date.now() - t0;
        const refetchStatus = prepared.path.length >= 2 ? 'OK' : 'NO_ROUTE';
        const responseSuccess = refetchStatus === 'OK';
        const preparedCost = pathCost(prepared.path);
        const metric: NavMetric = {
          timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
          status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          stepMs, totalMs,
          pathLen: prepared.path.length, totalCost: Math.round(preparedCost),
          maxPathJumpM: Math.round(jump.maxJumpM), agentCorridorM: Math.round(agentDist),
          targetCorridorM: Math.round(targetDist),
          targetForwardDistM: Math.round(targetForwardDistM),
          refetchReason: semanticReason,
          targetGapM: Math.round(roadTargetGapM),
          responsePathSource: refetch.responsePathSource,
          pathReachesTarget: false,
          roadTargetGapM: Math.round(roadTargetGapM),
          targetSnapDistanceM: Math.round(tSnapDist),
          snappedTargetNodeChanged: goalChanged,
          targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
          snappedTargetNodeId: tId,
          previousSnappedTargetNodeId: prevGoal !== tId ? prevGoal : null,
        };
        log.info(metric, 'NAV_METRIC');
        logRefetchResponseContractFixed({
          reason: semanticReason,
          refetchSuccess: refetch.success,
          preparedOk: prepared.ok,
          responseSuccess,
          responsePathLen: responseSuccess ? prepared.path.length : 0,
          pathSource: refetch.responsePathSource,
        });
        logNavPathTruth({
          session, status: refetchStatus, replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: semanticReason, pathSource: refetch.responsePathSource,
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: prepared.path, responsePath: prepared.path,
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        appendMetric(session, metric, mkTruth());
        await commitOrThrow(sessionId, lockToken, session);
        metrics.recordLatency(totalMs);
        return json({
          success: responseSuccess,
          path: responseSuccess ? prepared.path : [],
          maneuvers: responseSuccess
            ? maneuversForPath(refetch.selectedEdges, prepared.path)
            : [],
          totalCost: Math.round(preparedCost),
          status: refetchStatus,
          suggestedPollIntervalMs: pollMs,
          estimatedTimeSeconds: Math.round(refetch.totalDuration),
          lastMetric: metric,
          roadTargetGapM: Math.round(roadTargetGapM),
          targetSnapDistanceM: Math.round(tSnapDist),
          snappedTargetNodeChanged: goalChanged,
          targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
        });
      } catch (semanticRefetchErr) {
        // M4-F1: refetchRoute() (above) has its OWN internal commitOrThrow()
        // call that can throw one of the four specialized session-commit
        // error classes. Rethrow them immediately, unconverted, before any
        // generic refetch-failure logging/response below — same pattern as
        // the attachment_invalid catch (M4-E6), applied here because this
        // catch does not attempt any commit of its own (M4-F0 audit).
        if (
          semanticRefetchErr instanceof SessionLockLostError ||
          semanticRefetchErr instanceof SessionLockCapabilityUnavailableError ||
          semanticRefetchErr instanceof SessionLockBackendUnavailableError ||
          semanticRefetchErr instanceof SessionCommitOutcomeAmbiguousError
        ) {
          throw semanticRefetchErr;
        }

        log.error({ err: String(semanticRefetchErr) }, 'Semantic refetch failed');
        logNavPathTruth({
          session, status: 'ERROR', replanType: 'refetch', mapboxApiCalled: true,
          refetchReason: semanticReason, pathSource: 'error_empty',
          plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
          rawPlannerPath: truthRawPlannerPath, preparedPath: null, responsePath: [],
          targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
          targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
          maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
        });
        return json({
          success: false, path: [], totalCost: Infinity,
          status: 'ERROR', suggestedPollIntervalMs: 5000,
        });
      }
    }

    // 7b. Save — geometry valid + semantic alignment confirmed
    log.info({ sessionId, pathLen: finalPath.length, maxJumpM: Math.round(jump.maxJumpM) }, 'PATH_RENDERABLE_CONFIRMED');

    // ── Target endpoint telemetry (Phase 1 instrumentation — no behavior change) ─
    // Fires on every update where target moved meaningfully or gap is notable.
    // Used to diagnose why route endpoint does/does not refresh after target movement.
    if (targetMovedM > 5 || targetGpsToRouteEndM > 10 || goalChanged) {
      log.info({
        sessionId,
        targetMovedM:          Math.round(targetMovedM * 10) / 10,
        previousTargetPos:     session.lastTargetPos,
        currentTargetPos:      targetPos,
        previousTId:           prevGoal,
        currentTId:            tId,
        goalChanged,
        targetCorridorM:       Math.round(targetDist),
        targetForwardDistM:    Math.round(targetForwardDistM),
        targetGpsToRouteEndM:  Math.round(targetGpsToRouteEndM),
        roadTargetGapM:        roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
        pathReachesTarget:     roadTargetGapM >= 0 ? roadTargetGapM <= effectiveThreshold : null,
        lastMileMode:          'none' as const,
        mapboxApiCalled:       false,
        refetchReason:         null,
        replanType:            'incremental',
        pathLen:               finalPath.length,
        routeEndpoint:         pathEndpoint,
      }, 'TARGET_ENDPOINT_TRACE');
    }

    // Candidate log: conditions that would merit a route-endpoint refresh in a future phase.
    // Does NOT change any behavior — purely observational.
    {
      const candidateReasons: string[] = [];
      if (targetMovedM >= 15)         candidateReasons.push('target_moved');
      if (targetGpsToRouteEndM > 30)  candidateReasons.push('target_gap_large');
      if (goalChanged)                candidateReasons.push('target_node_changed');
      if (candidateReasons.length > 0) {
        log.info({
          sessionId,
          reason:               candidateReasons,
          targetMovedM:         Math.round(targetMovedM * 10) / 10,
          targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
          previousTId:          prevGoal,
          currentTId:           tId,
          targetCorridorM:      Math.round(targetDist),
          targetForwardDistM:   Math.round(targetForwardDistM),
        }, 'TARGET_ROAD_ENDPOINT_REFRESH_CANDIDATE');
      }
    }

    // Skip log: explains why no refetch/replan fired despite target movement.
    if (targetMovedM > 5) {
      const skipReasons: string[] = [];
      if (targetMovedM < 15)                            skipReasons.push('movement_below_threshold');
      if (!goalChanged)                                 skipReasons.push('same_target_node');
      if (targetDist <= TARGET_CORRIDOR_THRESHOLD)      skipReasons.push('corridor_still_valid');
      if (targetForwardDistM <= targetForwardThresholdM) skipReasons.push('existing_threshold_not_met');
      if (skipReasons.length === 0)                     skipReasons.push('no_refetch_required_by_current_policy');
      log.info({
        sessionId,
        reason:               skipReasons,
        targetMovedM:         Math.round(targetMovedM * 10) / 10,
        targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
        currentTId:           tId,
        previousTId:          prevGoal,
        targetCorridorM:      Math.round(targetDist),
        targetForwardDistM:   Math.round(targetForwardDistM),
        currentPolicyThresholds: {
          targetCorridorThresholdM:  TARGET_CORRIDOR_THRESHOLD,
          targetForwardThresholdM,
          semanticThreshold,
          effectiveThreshold,
          navMode,
        },
      }, 'TARGET_ROAD_ENDPOINT_REFRESH_SKIPPED');
    }

    // ── PATCH 6B / 6D / 6E: Road Attachment Semantic Layer ───────────────────
    // Replaces nearest-node-only routing with road attachment point routing.
    // planner.step(aId, tId) and semantic validation above are unchanged.
    // Only the final path tail and session attachment fields are affected.
    //
    // Decision tree:
    //   wouldUseProjection (≤30m)       → EDGE_PROJECTION: trim or extend tail to p
    //     path ends near edgeTo         → trimPathTailToProjection() (PATCH 6B)
    //     path ends near edgeFrom       → extendPathToProjection()   (PATCH 6D)
    //   covered, projection > 30m       → NODE_SNAP: freeze session, route stays at tId
    //   not covered, frozenValid        → LAST_ROAD_ATTACHMENT: routeGoalPoint=frozenP (PATCH 6E)
    //   not covered, no valid frozen p  → OFF_ROAD_UNREACHABLE
    type RouteGoalType = 'EDGE_PROJECTION' | 'NODE_SNAP' | 'LAST_ROAD_ATTACHMENT' | 'OFF_ROAD_UNREACHABLE';
    let routeGoalType: RouteGoalType;
    let routeGoalPoint: Coordinate | null;
    let offRoadDistanceM: number | null;
    let pathTrimmedToProjection  = false;
    let pathExtendedToProjection = false;
    const routeGoalNodeId: string | null       = tId;
    let routeGoalEdgeFrom: string | null       = null;
    let routeGoalEdgeTo: string | null         = null;
    let routeGoalProjectedRatio: number | null = null;

    // Pre-compute frozen attachment validity once — used in decision tree and log
    const frozenAttachmentValid = frozenAttachmentIsValid(session, targetPos);
    const frozenDistanceM: number | null = (frozenAttachmentValid && session.lastTargetRoadAttachmentPoint)
      ? Math.round(haversine(
          targetPos.lat, targetPos.lng,
          session.lastTargetRoadAttachmentPoint.lat,
          session.lastTargetRoadAttachmentPoint.lng,
        ))
      : null;
    const targetGpsPoint: Coordinate = targetPos;

    if (wouldUseProjection && targetProjection !== null) {
      // Measure how close the current path endpoint is to each edge endpoint.
      // This determines whether to trim (path ends at edgeTo) or extend (path ends at edgeFrom).
      const pathEnd = finalPath[finalPath.length - 1];
      const edgeFromNode = session.graph.nodes[targetProjection.edgeFrom];
      const edgeToNode   = session.graph.nodes[targetProjection.edgeTo];

      const distToEdgeFrom = edgeFromNode
        ? haversine(pathEnd.lat, pathEnd.lng, edgeFromNode.lat, edgeFromNode.lng)
        : Infinity;
      const distToEdgeTo = edgeToNode
        ? haversine(pathEnd.lat, pathEnd.lng, edgeToNode.lat, edgeToNode.lng)
        : Infinity;

      const originalPathLen      = finalPath.length;
      const originalLastPoint    = finalPath[finalPath.length - 1];

      if (distToEdgeTo <= distToEdgeFrom) {
        // Path ends nearer to edgeTo (ratio ≥ 0.5 case) → TRIM
        const trimResult = trimPathTailToProjection(finalPath, targetProjection.projectedPoint, log);
        // PATCH 6G: use reference identity, not length — trim on the last segment returns same length
        if (trimResult !== finalPath) {
          finalPath  = trimResult;
          remainingM = pathCost(finalPath);
          pathTrimmedToProjection = true;
          log.info({
            sessionId,
            projectedEdgeFrom:   targetProjection.edgeFrom,
            projectedEdgeTo:     targetProjection.edgeTo,
            projectedPoint:      targetProjection.projectedPoint,
            projectionDistanceM: Math.round(targetProjection.distanceM),
            originalPathLen,
            trimmedPathLen:      finalPath.length,
            oldLastPoint:        originalLastPoint,
            newLastPoint:        finalPath[finalPath.length - 1],
          }, 'TARGET_TAIL_TRIMMED_TO_PROJECTION');
        }
      } else {
        // Path ends nearer to edgeFrom (ratio < 0.5 case) → EXTEND
        const extendResult = extendPathToProjection(
          finalPath,
          targetProjection.projectedPoint,
          targetProjection.edgeFrom,
          targetProjection.edgeTo,
          session.graph,
          log,
        );
        if (extendResult.length > finalPath.length) {
          finalPath  = extendResult;
          remainingM = pathCost(finalPath);
          pathExtendedToProjection = true;
          log.info({
            sessionId,
            routeGoalType:       'EDGE_PROJECTION',
            edgeFrom:            targetProjection.edgeFrom,
            edgeTo:              targetProjection.edgeTo,
            projectedRatio:      targetProjection.projectedRatio,
            originalPathLen,
            extendedPathLen:     finalPath.length,
            oldLastPoint:        originalLastPoint,
            newLastPoint:        finalPath[finalPath.length - 1],
            projectionDistanceM: Math.round(targetProjection.distanceM),
          }, 'TARGET_TAIL_EXTENDED_TO_PROJECTION');
        } else {
          log.warn({
            sessionId,
            reason:                     'extend_returned_no_change',
            edgeFrom:                   targetProjection.edgeFrom,
            edgeTo:                     targetProjection.edgeTo,
            projectedRatio:             targetProjection.projectedRatio,
            endpointDistanceToEdgeFrom: Math.round(distToEdgeFrom),
            endpointDistanceToEdgeTo:   Math.round(distToEdgeTo),
          }, 'EXTEND_PATH_TO_PROJECTION_SKIPPED');
        }
      }

      // Update session attachment — only when projection is valid (≤30m)
      session.lastTargetRoadAttachmentPoint    = targetProjection.projectedPoint;
      session.lastTargetRoadAttachmentEdgeFrom = targetProjection.edgeFrom;
      session.lastTargetRoadAttachmentEdgeTo   = targetProjection.edgeTo;
      session.lastTargetProjectionDistanceM    = targetProjection.distanceM;
      routeGoalType        = 'EDGE_PROJECTION';
      routeGoalPoint       = targetProjection.projectedPoint;
      offRoadDistanceM     = Math.round(targetProjection.distanceM);
      routeGoalEdgeFrom    = targetProjection.edgeFrom;
      routeGoalEdgeTo      = targetProjection.edgeTo;
      routeGoalProjectedRatio = targetProjection.projectedRatio;
    } else if (frozenAttachmentValid) {
      // M4-E2: attachment invalid (projection missing or beyond the ATTACHED
      // band, see targetAttachmentValid above) — do NOT trust NODE_SNAP as if
      // the target were currently attached. Prefer the last confirmed road
      // exit point instead, checked before falling back to NODE_SNAP.
      routeGoalType    = 'LAST_ROAD_ATTACHMENT';
      routeGoalPoint   = session.lastTargetRoadAttachmentPoint!;
      offRoadDistanceM = frozenDistanceM;
    } else if (targetCoveredBySessionGraph) {
      // No valid frozen attachment yet (e.g. first tick this session) — fall
      // back to the pre-M4-E2 node-snap behavior as the safe last resort.
      routeGoalType    = 'NODE_SNAP';
      routeGoalPoint   = tNode ?? null;
      offRoadDistanceM = tNode !== null ? Math.round(tSnapDist) : null;
    } else {
      // No coverage and no valid frozen attachment
      routeGoalType    = 'OFF_ROAD_UNREACHABLE';
      routeGoalPoint   = null;
      offRoadDistanceM = null;
    }

    // LAST_ROAD_ATTACHMENT = target is reachable by road via frozen p; only OFF_ROAD_UNREACHABLE is not
    const reachableByRoad = routeGoalType !== 'OFF_ROAD_UNREACHABLE';

    // ── PATCH 6G: Endpoint verification + enforcement ──────────────────────────
    // Guarantee: EDGE_PROJECTION => finalPath.last() ≈ routeGoalPoint (within 1m)
    let endpointEnforced   = false;
    let endpointTrimmed    = false;
    const endpointExtended = false;
    let endpointDistanceM: number | null = null;
    let preEnforcementEndpointDistanceM: number | null = null;

    if (routeGoalType === 'EDGE_PROJECTION' && routeGoalPoint !== null) {
      const ep     = finalPath[finalPath.length - 1];
      const epDist = haversine(ep.lat, ep.lng, routeGoalPoint.lat, routeGoalPoint.lng);
      preEnforcementEndpointDistanceM = Math.round(epDist);
      endpointDistanceM = preEnforcementEndpointDistanceM;

      if (epDist > 1) {
        // Primary enforcement: re-run trim with reference-identity guard
        const enforced = trimPathTailToProjection(finalPath, routeGoalPoint, log);
        if (enforced !== finalPath) {
          finalPath       = enforced;
          remainingM      = pathCost(finalPath);
          endpointEnforced = true;
          endpointTrimmed  = true;
          log.info({
            sessionId,
            epDistBeforeM:  endpointDistanceM,
            newLastPoint:   finalPath[finalPath.length - 1],
            newPathLen:     finalPath.length,
          }, 'ENDPOINT_ENFORCED_TRIM');
        } else if (epDist <= 50) {
          // p is on the road edge and close to path end; trim could not reach it
          // (bestDist > 50 or bestT=1 on last segment after trim already ran).
          // Safe to replace last point: p is confirmed on-road, same edge as path end.
          finalPath       = [...finalPath.slice(0, -1), routeGoalPoint];
          remainingM      = pathCost(finalPath);
          endpointEnforced = true;
          endpointTrimmed  = true;
          log.warn({
            sessionId,
            epDistBeforeM:  endpointDistanceM,
            newLastPoint:   finalPath[finalPath.length - 1],
            newPathLen:     finalPath.length,
            reason:         'trim_unreachable_last_point_replaced',
          }, 'ENDPOINT_ENFORCED_REPLACE_LAST');
        } else {
          log.warn({
            sessionId,
            epDistM:  endpointDistanceM,
            reason:   'enforcement_failed_dist_too_large',
          }, 'ENDPOINT_ENFORCEMENT_FAILED');
        }
      }
    }

    const finalPathEndpoint = finalPath.length > 0 ? finalPath[finalPath.length - 1] : null;
    const finalEndpointDistanceM =
      finalPathEndpoint !== null && routeGoalPoint !== null
        ? Math.round(haversine(finalPathEndpoint.lat, finalPathEndpoint.lng, routeGoalPoint.lat, routeGoalPoint.lng))
        : null;
    const targetDistanceToGraphCenterM = session.graphCenterPos
      ? Math.round(haversine(targetPos.lat, targetPos.lng, session.graphCenterPos.lat, session.graphCenterPos.lng))
      : null;
    const outsideGraphCount = (session.metrics ?? []).filter(
      m => m.targetCoveredBySessionGraph === false || m.targetCoverageReason === 'OUTSIDE_GRAPH',
    ).length + (targetCoveredBySessionGraph ? 0 : 1);
    const endpointEnforcementFailed =
      routeGoalType === 'EDGE_PROJECTION' &&
      finalEndpointDistanceM !== null &&
      finalEndpointDistanceM > 1;
    markBackendM1CandidateReady();

    log.info({
      sessionId,
      routeGoalType,
      routeGoalPoint,
      targetGpsPoint,
      pathEndpoint: finalPathEndpoint,
      offRoadDistanceM,
      reachableByRoad,
      frozenAttachmentValid,
      frozenDistanceM,
      tId,
      coverageReason:      targetCoverageReason,
      tSnapDistM:          Math.round(tSnapDist),
      wouldUseProjection,
      projectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
      finalPathLen:        finalPath.length,
      preEnforcementEndpointDistanceM,
      finalEndpointDistanceM,
      endpointEnforced,
      endpointTrimmed,
      endpointExtended,
      finalPathLength:     finalPath.length,
    }, 'ROUTE_GOAL_SEMANTIC');

    // ── Phase 1: TARGET_EDGE_PROJECTION_WOULD_APPLY (retained for log continuity) ─
    if (wouldUseProjection && targetProjection !== null) {
      log.info({
        sessionId,
        projectedEdgeFrom:          targetProjection.edgeFrom,
        projectedEdgeTo:            targetProjection.edgeTo,
        projectedPoint:             targetProjection.projectedPoint,
        distanceM:                  Math.round(targetProjection.distanceM),
        currentSnappedTargetNodeId: tId,
        goalChanged,
        targetGpsToRouteEndM:       Math.round(targetGpsToRouteEndM),
      }, 'TARGET_EDGE_PROJECTION_WOULD_APPLY');
    }

    resetRefetchTracking(session);
    session.plannerState = planner.serialize();
    session.gpsFilterState = gps.serialize();
    session.lastAgentPos = smoothAgent;
    session.lastTargetPos = targetPos;
    session.updateCount++;
    const totalMs = Date.now() - t0;
    const metric: NavMetric = {
      timestamp: Date.now(), sessionId: session.sessionId, mode: 'hybrid',
      status: 'OK', replanType: 'incremental', mapboxApiCalled: false,
      stepMs, totalMs,
      pathLen: finalPath.length, totalCost: Math.round(remainingM),
      maxPathJumpM: Math.round(jump.maxJumpM),
      agentCorridorM: Math.round(agentDist),
      targetCorridorM: Math.round(targetDist),
      targetForwardDistM: Math.round(targetForwardDistM),
      targetGapM: roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
      pathReachesTarget: roadTargetGapM >= 0 ? roadTargetGapM <= effectiveThreshold : null,
      roadTargetGapM: roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
      targetSnapDistanceM: Math.round(tSnapDist),
      snappedTargetNodeChanged: goalChanged,
      targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
      snappedTargetNodeId: tId,
      previousSnappedTargetNodeId: prevGoal !== tId ? prevGoal : null,
      targetProjectionAttempted: true,
      targetProjectionAvailable: targetProjection !== null,
      targetProjectionDistanceM: targetProjection !== null ? Math.round(targetProjection.distanceM) : null,
      projectedTargetPoint: targetProjection?.projectedPoint ?? null,
      projectedEdgeFrom: targetProjection?.edgeFrom ?? null,
      projectedEdgeTo: targetProjection?.edgeTo ?? null,
      projectedDistanceAlongEdgeM: targetProjection !== null ? Math.round(targetProjection.distanceAlongEdgeM) : null,
      projectedTargetFallbackReason: projectionFallbackReason,
      wouldUseProjectedTarget: wouldUseProjection,
      responsePathSource: sparseGeometryJumpAllowed ? 'sparse_geometry_allowed' : 'planner_prepared',
      graphCreatedAt:    session.graph.createdAt,
      graphNodeCount:    Object.keys(session.graph.nodes).length,
      graphEdgeCount:    Object.values(session.graph.edges).reduce((s, arr) => s + arr.length, 0),
      graphCenterPos:    session.graphCenterPos ?? null,
      graphRadiusM:      session.graphRadiusM ?? null,
      targetDistanceToGraphCenterM,
      outsideGraphCount,
      pathUsesSparseGeometry:  result.pathUsesSparseGeometry,
      sparseGeometryMaxJumpM:  result.sparseGeometryMaxJumpM,
      sparseGeometryEdgeCount: result.sparseGeometryEdgeCount,
      jumpClassification: pathJumpTrace?.jumpClassification ?? result.jumpClassification ?? 'unknown',
      jumpEdgeId: pathJumpTrace?.edgeId ?? null,
      jumpEdgeSource: pathJumpTrace?.edgeSource ?? null,
      jumpGeometryPointCount: pathJumpTrace?.geometryPointCount ?? null,
      jumpAllowed: true,
      // ─── PATCH 6G: endpoint enforcement telemetry ───────────────────────────
      pathEndpoint: finalPathEndpoint,
      routeGoalType,
      routeGoalPoint,
      targetGpsPoint,
      offRoadDistanceM,
      reachableByRoad,
      preEnforcementEndpointDistanceM,
      finalEndpointDistanceM,
      endpointDistanceM,
      endpointEnforced: endpointEnforced ? true : null,
      endpointTrimmed,
      endpointExtended,
      frozenAttachmentValid,
      lastTargetRoadAttachmentPoint: session.lastTargetRoadAttachmentPoint ?? null,
      lastTargetProjectionDistanceM: session.lastTargetProjectionDistanceM ?? null,
      frozenDistanceM,
      endpointEnforcementFailed,
      responsePathLen: finalPath.length,
      pathSource: sparseGeometryJumpAllowed ? 'sparse_geometry_allowed' : 'planner_prepared',
      targetAttachmentValid,
      targetAttachmentBand,
      targetAttachmentInvalidReason,
      targetAttachmentInvalidStreak,
    };
    log.info(metric, 'NAV_METRIC');
    logNavPathTruth({
      session, status: 'OK', replanType: 'incremental', mapboxApiCalled: false,
      refetchReason: null, pathSource: sparseGeometryJumpAllowed ? 'sparse_geometry_allowed' : 'planner_prepared',
      plannerAttempted: truthPlannerAttempted, plannerSucceeded: truthPlannerSucceeded,
      rawPlannerPath: truthRawPlannerPath, preparedPath: finalPath, responsePath: finalPath,
      targetForwardDriftDetected: targetForwardDistM > targetForwardThresholdM,
      targetForwardDriftSuppressed, targetCoveredBySessionGraph, targetCoverageReason,
      maxPathJumpM: truthMaxPathJumpM, jumpThresholdM: MAX_PATH_JUMP_M,
    });
    appendMetric(session, metric, mkTruth());
    await commitOrThrow(sessionId, lockToken, session);

    metrics.recordLatency(totalMs);
    log.info({
      sessionId,
      updateCount: session.updateCount,
      replanType: 'incremental',
      stepMs,
      totalMs,
      pathLen: finalPath.length,
      totalCost: Math.round(remainingM),
      goalChanged,
      agentCorridorM: Math.round(agentDist),
      targetCorridorM: Math.round(targetDist),
      targetMovedM: Math.round(targetMovedM),
      targetForwardDistM: Math.round(targetForwardDistM),
      maxPathJumpM: Math.round(jump.maxJumpM),
    }, 'BENCHMARK');

    if (process.env.DEBUG_NAV) {
      let maxJump = 0; let maxJumpIdx = -1;
      for (let i = 1; i < finalPath.length; i++) {
        const d = haversine(finalPath[i-1].lat, finalPath[i-1].lng,
                            finalPath[i].lat,   finalPath[i].lng);
        if (d > maxJump) { maxJump = d; maxJumpIdx = i; }
      }
      log.warn({
        pathLen: finalPath.length,
        maxJumpM: Math.round(maxJump),
        maxJumpIdx,
        aroundJump: maxJumpIdx > 0
          ? finalPath.slice(Math.max(0, maxJumpIdx - 1), maxJumpIdx + 2)
          : [],
        first5: finalPath.slice(0, 5),
        last5: finalPath.slice(-5),
      }, 'PATH_JUMP_DEBUG');
    }

    return json({
      success: true,
      path: finalPath,
      maneuvers: maneuversForPath(selectedEdges, finalPath),
      totalCost: Math.round(remainingM),
      status: 'OK',
      suggestedPollIntervalMs: pollMs,
      estimatedTimeSeconds: Math.round(remainingM / 8.33),
      lastMetric: metric,
      roadTargetGapM: roadTargetGapM >= 0 ? Math.round(roadTargetGapM) : null,
      targetSnapDistanceM: Math.round(tSnapDist),
      snappedTargetNodeChanged: goalChanged,
      targetGpsToRouteEndM: Math.round(targetGpsToRouteEndM),
      jumpClassification: pathJumpTrace?.jumpClassification ?? result.jumpClassification ?? 'unknown',
      jumpEdgeId: pathJumpTrace?.edgeId ?? null,
      jumpEdgeSource: pathJumpTrace?.edgeSource ?? null,
      jumpGeometryPointCount: pathJumpTrace?.geometryPointCount ?? null,
      jumpAllowed: true,
      routeGoalType,
      routeGoalPoint,
      targetGpsPoint,
      offRoadDistanceM,
      reachableByRoad,
      routeGoalNodeId,
      routeGoalEdgeFrom,
      routeGoalEdgeTo,
      routeGoalProjectedRatio,
      pathExtendedToProjection,
      pathTrimmedToProjection,
      pathEndpoint: finalPathEndpoint,
      preEnforcementEndpointDistanceM,
      finalEndpointDistanceM,
      endpointDistanceM,
      endpointEnforced,
      endpointTrimmed,
      endpointExtended,
    });

  } catch (err) {
    metrics.recordLatency(Date.now() - t0);
    metrics.recordError();
    if (err instanceof SessionLockLostError) {
      // Commit-time fencing rejected a write mid-request (lock reassigned to
      // another holder, e.g. after a TTL lapse) — ordinary, expected
      // contention. All later saves in this request are automatically
      // skipped by this thrown-error unwind — no partial/stale commit can
      // follow. Same frontend-safe shape as the lock-busy response
      // (M4-B1.2.1 §11); the frontend does not need to distinguish the two
      // cases, only the backend logs do.
      log.warn({ sessionId: err.sessionId }, 'SESSION_LOCK_LOST_REQUEST_ABORTED');
      return lockFailureResponse('session_locked');
    }
    if (err instanceof SessionLockCapabilityUnavailableError) {
      // M4-B1.5: distinct from SessionLockLostError — this is an
      // infrastructure/deployment condition (Lua EVAL confirmed unsupported),
      // not ordinary contention. Detailed capability-detection logs already
      // fired inside session.store.ts (SESSION_LOCK_CAPABILITY_UNAVAILABLE /
      // SESSION_LOCK_CAPABILITY_LOST_AT_RUNTIME); this just marks that THIS
      // request was aborted for that reason.
      log.warn({ sessionId: err.sessionId }, 'SESSION_LOCK_CAPABILITY_UNAVAILABLE_REQUEST_ABORTED');
      return lockFailureResponse('session_lock_capability_unavailable');
    }
    if (err instanceof SessionLockBackendUnavailableError) {
      // M4-B1.5: the capability probe was inconclusive (network/DNS/timeout,
      // not a confirmed EVAL rejection) or the acquire's SET NX call itself
      // threw — a plausibly transient infra condition, distinct from both
      // ordinary contention and a confirmed permanent capability failure.
      log.warn({ sessionId: err.sessionId }, 'SESSION_LOCK_BACKEND_UNAVAILABLE_REQUEST_ABORTED');
      return lockFailureResponse('session_lock_backend_unavailable');
    }
    if (err instanceof SessionCommitOutcomeAmbiguousError) {
      // M4-B1.5: the atomic commit's one allowed retry never resolved
      // cleanly — server-side outcome is genuinely unknown, not a definite
      // lock-lost rejection. Detailed SESSION_LOCK_COMMIT_OUTCOME_AMBIGUOUS
      // log already fired inside session.store.ts.
      log.warn({ sessionId: err.sessionId }, 'SESSION_COMMIT_OUTCOME_AMBIGUOUS_REQUEST_ABORTED');
      return lockFailureResponse('session_commit_outcome_ambiguous');
    }
    if (err instanceof AppError) {
      log.error({ code: err.code }, err.message);
      // session not in scope — best-effort truth log with null fields
      log.info({
        sessionId: null, updateCount: null,
        status: 'ERROR', replanType: null, mapboxApiCalled: null,
        refetchReason: err.message ?? null, pathSource: 'error_empty',
        plannerAttempted: null, plannerSucceeded: null,
        rawPlannerPathLen: null, rawPlannerPathSignature: null,
        preparedPathLen: null, preparedPathSignature: null,
        responsePathLen: 0, responsePathSignature: 'empty',
        targetForwardDriftDetected: null, targetForwardDriftSuppressed: null,
        targetCoveredBySessionGraph: null, targetCoverageReason: null,
        maxPathJumpM: null, jumpThresholdM: MAX_PATH_JUMP_M,
        graphCreatedAt: null, graphNodeCount: null, graphEdgeCount: null,
      }, 'NAV_PATH_TRUTH');
      return json(
        { success: false, path: [], totalCost: Infinity, status: 'ERROR' as const },
        { status: err.statusCode },
      );
    }
    log.error({ err: String(err) }, 'Unexpected error');
    // session not in scope — best-effort truth log with null fields
    log.info({
      sessionId: null, updateCount: null,
      status: 'ERROR', replanType: null, mapboxApiCalled: null,
      refetchReason: String(err) ?? null, pathSource: 'error_empty',
      plannerAttempted: null, plannerSucceeded: null,
      rawPlannerPathLen: null, rawPlannerPathSignature: null,
      preparedPathLen: null, preparedPathSignature: null,
      responsePathLen: 0, responsePathSignature: 'empty',
      targetForwardDriftDetected: null, targetForwardDriftSuppressed: null,
      targetCoveredBySessionGraph: null, targetCoverageReason: null,
      maxPathJumpM: null, jumpThresholdM: MAX_PATH_JUMP_M,
      graphCreatedAt: null, graphNodeCount: null, graphEdgeCount: null,
    }, 'NAV_PATH_TRUTH');
    return json(
      { success: false, path: [], totalCost: Infinity, status: 'ERROR' as const },
      { status: 500 },
    );
  } finally {
    // Runs on every exit path: success return, busy return, SessionLockLostError,
    // AppError, and unexpected errors (M4-B1.2 §6/§8). No-op if the lock was
    // never acquired (lockToken stays null on the busy-response early-return).
    if (lockToken && lockedSessionId) {
      await releaseSessionLock(lockedSessionId, lockToken);
    }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const context = researchContextFromRequestBody(req.body, 'update');
  return withBackendResearchContext(context, () => handleRequest(req, res));
}

// ─── Phase 7F-3B: truth context enriched into every stored metric ─────────────

interface AppendMetricTruth {
  targetCoveredBySessionGraph: boolean;
  targetCoverageReason: string | null;
  plannerAttempted: boolean;
  plannerSucceeded: boolean | null;
}

function deriveNavigationState(m: NavMetric): string {
  if (m.status === 'ARRIVED') return 'ARRIVED';
  if (m.refetchReason === 'same_node_no_alternate') return 'SAME_NODE';
  if (m.mapboxApiCalled) return 'OUTSIDE_GRAPH';
  if (m.status === 'OK') return 'INSIDE_GRAPH';
  return 'NO_ROUTE';
}

function appendMetric(session: SessionData, metric: NavMetric, truth: AppendMetricTruth): void {
  const arr = session.metrics ?? [];
  const enriched: NavMetric = {
    ...metric,
    targetCoveredBySessionGraph: truth.targetCoveredBySessionGraph,
    targetCoverageReason:        truth.targetCoverageReason,
    plannerAttempted:            truth.plannerAttempted,
    plannerSucceeded:            truth.plannerSucceeded,
    navigationState:             deriveNavigationState(metric),
  };
  const withDefaults = withMetricDefaults(enriched, MAX_PATH_JUMP_M);
  session.metrics = arr.length >= 500 ? [...arr.slice(-499), withDefaults] : [...arr, withDefaults];
}

// ─── Path truth helpers (Patch 1 — evidence telemetry only, no behavior change) ──

function logNavPathTruth(p: NavPathTruthInput): void {
  log.info(buildNavPathTruthLog(p), 'NAV_PATH_TRUTH');
}

function withResponseDefaults(body: UpdateResponse): UpdateResponse {
  const withDefaults = withUpdateResponseDefaults(body, MAX_PATH_JUMP_M);
  log.info({
    status: withDefaults.status,
    refetchReason: withDefaults.refetchReason,
    targetGapM: withDefaults.targetGapM,
    roadTargetGapM: withDefaults.roadTargetGapM,
    targetSnapDistanceM: withDefaults.targetSnapDistanceM,
    snappedTargetNodeChanged: withDefaults.snappedTargetNodeChanged,
    targetGpsToRouteEndM: withDefaults.targetGpsToRouteEndM,
    lastMileMode: withDefaults.lastMileMode,
  }, 'UPDATE_RESPONSE_CONTRACT_DEFAULTS');
  return withDefaults;
}
