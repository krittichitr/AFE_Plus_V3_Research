/**
 * POST /api/navigate/init
 * Mapbox fetch → Corridor Graph → MT-D* Lite init → Redis save
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { createLogger, metrics, AppError } from '@/lib/navigation/logger';
import { validateBody, InitRequestSchema } from '@/lib/navigation/validate';
import { fetchMultiProfileDirections } from '@/lib/navigation/mapbox.client';
import { buildCorridorGraph, findNearestNode } from '@/lib/navigation/corridor.builder';
import { buildTargetCenteredGraph, TARGET_GRAPH_RADIUS_M, countConnectedComponents } from '@/lib/navigation/bubble.graph';
import { MTDStarLitePlanner } from '@/lib/navigation/mtdstar-lite';
import { GPSKalmanFilter, haversine } from '@/lib/navigation/gps.smooth';
import { generateSessionId, saveSession, getActiveSessionCount } from '@/lib/navigation/session.store';
import { maneuversForPath } from '@/lib/navigation/maneuver.extractor';
import type { InitResponse, NavDistanceMode, RouteProvenance } from '@/lib/navigation/types';
import {
  getBackendResearchEvents,
  researchContextFromRequestBody,
  withBackendResearchContext,
} from '@/lib/research/backendResearch';

const log = createLogger('api/navigate/init');
// Target-centered graph is always enabled — target is graph center, not the agent.

type InitResponsePathSource = Exclude<InitResponse['responsePathSource'], undefined>;
type InitNavigationState = NonNullable<InitResponse['navigationState']>;
type InitFailureReason = Exclude<InitResponse['initFailureReason'], undefined>;

function logInitResponseContract(input: {
  sessionId: string;
  status: InitResponse['status'];
  success: boolean;
  pathLen: number;
  plannerAttempted: boolean;
  plannerSucceeded: boolean | null;
  responsePathSource: InitResponsePathSource;
  initFailureReason: InitFailureReason;
  mapboxApiCalled: boolean;
  graphNodeCount: number | null;
  graphEdgeCount: number | null;
}): void {
  log.info(input, 'INIT_RESPONSE_CONTRACT');
}

function logInitPlannerPathTruth(input: {
  sessionId: string;
  status: InitResponse['status'];
  success: boolean;
  pathLen: number;
  rawPlannerPathLen: number | null;
  responsePathLen: number;
  plannerAttempted: boolean;
  plannerSucceeded: boolean | null;
  responsePathSource: InitResponsePathSource;
  initFailureReason: InitFailureReason;
  mapboxApiCalled: boolean;
  graphNodeCount: number | null;
  graphEdgeCount: number | null;
}): void {
  log.info(input, 'INIT_PLANNER_PATH_TRUTH');
}

function buildInitResponse(input: {
  sessionId: string;
  path: InitResponse['path'];
  totalCost: number;
  status: InitResponse['status'];
  success: boolean;
  navigationState: InitNavigationState;
  responsePathSource: InitResponsePathSource;
  plannerAttempted: boolean;
  plannerSucceeded: boolean | null;
  mapboxApiCalled: boolean;
  graphCreatedAt: number | null;
  graphNodeCount: number | null;
  graphEdgeCount: number | null;
  initFailureReason: InitFailureReason;
  corridorNodeCount?: number;
  estimatedTimeSeconds?: number;
  rawPlannerPathLen?: number | null;
  maneuvers?: InitResponse['maneuvers'];
  routeProvenance: RouteProvenance | null;
}): InitResponse {
  logInitResponseContract({
    sessionId: input.sessionId,
    status: input.status,
    success: input.success,
    pathLen: input.path.length,
    plannerAttempted: input.plannerAttempted,
    plannerSucceeded: input.plannerSucceeded,
    responsePathSource: input.responsePathSource,
    initFailureReason: input.initFailureReason,
    mapboxApiCalled: input.mapboxApiCalled,
    graphNodeCount: input.graphNodeCount,
    graphEdgeCount: input.graphEdgeCount,
  });
  logInitPlannerPathTruth({
    sessionId: input.sessionId,
    status: input.status,
    success: input.success,
    pathLen: input.path.length,
    rawPlannerPathLen: input.rawPlannerPathLen ?? null,
    responsePathLen: input.path.length,
    plannerAttempted: input.plannerAttempted,
    plannerSucceeded: input.plannerSucceeded,
    responsePathSource: input.responsePathSource,
    initFailureReason: input.initFailureReason,
    mapboxApiCalled: input.mapboxApiCalled,
    graphNodeCount: input.graphNodeCount,
    graphEdgeCount: input.graphEdgeCount,
  });

  return {
    sessionId: input.sessionId,
    path: input.path,
    maneuvers: input.maneuvers ?? [],
    totalCost: input.totalCost,
    status: input.status,
    corridorNodeCount: input.corridorNodeCount,
    estimatedTimeSeconds: input.estimatedTimeSeconds,
    success: input.success,
    navigationState: input.navigationState,
    responsePathSource: input.responsePathSource,
    plannerAttempted: input.plannerAttempted,
    plannerSucceeded: input.plannerSucceeded,
    mapboxApiCalled: input.mapboxApiCalled,
    graphCreatedAt: input.graphCreatedAt,
    graphNodeCount: input.graphNodeCount,
    graphEdgeCount: input.graphEdgeCount,
    initFailureReason: input.initFailureReason,
    routeProvenance: input.routeProvenance,
    research_events: getBackendResearchEvents(),
  };
}

async function handleRequest(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).json({
      error: 'Method not allowed',
    });
    return;
  }

  const t0 = Date.now();
  let mapboxApiCalled = false;
  let routeProvenance: RouteProvenance | null = null;
  try {
    const body: unknown = req.body;
    const parsed = validateBody(InitRequestSchema, body);
    const { agentPos, targetPos } = parsed;
    routeProvenance = parsed.routeProvenance ?? null;

    // Determine navigation mode from direct distance
    const directDistM = haversine(agentPos.lat, agentPos.lng, targetPos.lat, targetPos.lng);
    const navMode: NavDistanceMode = directDistM > 50_000 ? 'long_distance' : 'local_hybrid';
    log.info({ navMode, directDistM: Math.round(directDistM), agentPos, targetPos }, 'NAVIGATION_MODE_SELECTED');

    // 1. Mapbox driving route + target-centered walking graph in parallel.
    //    Target is the graph center — rays radiate FROM target so the road network
    //    around the target is densely covered. responses[0] stays the corridor route.
    log.info({ targetPos, radiusM: TARGET_GRAPH_RADIUS_M }, 'INIT_TARGET_GRAPH_START');

    mapboxApiCalled = true;
    const [mbResponses, targetCenteredData] = await Promise.all([
      fetchMultiProfileDirections(agentPos, targetPos),
      buildTargetCenteredGraph(targetPos, TARGET_GRAPH_RADIUS_M),
    ]);

    // Target graph rays appended after corridor — responses[0] must remain the corridor
    // so buildCorridorGraph uses it as primaryRoute for totalDistance/totalDuration/routePolyline.
    const allResponses = [...mbResponses, ...targetCenteredData.rays];

    // 2. Unified graph: corridor backbone + target-centered walking network
    const graph = buildCorridorGraph(allResponses, agentPos, targetPos, {
      targetRayResponseStartIndex: mbResponses.length,
    });

    const graphNodeCount = Object.keys(graph.nodes).length;
    const graphEdgeCount = Object.values(graph.edges).reduce((s, arr) => s + arr.length, 0);

    log.info({
      graphNodeCount,
      graphEdgeCount,
      graphCreatedAt:      graph.createdAt,
      baseResponseCount:   mbResponses.length,
      totalResponseCount:  allResponses.length,
      successfulRayCount:  targetCenteredData.successfulRayCount,
      failedRayCount:      targetCenteredData.failedRayCount,
      graphCenterPos:      targetCenteredData.graphCenterPos,
      graphRadiusM:        TARGET_GRAPH_RADIUS_M,
      connectedComponents: countConnectedComponents(graph),
    }, 'INIT_TARGET_GRAPH_BUILT');

    // 3. Snap positions
    const agentNodeId = findNearestNode(agentPos, graph.nodes);
    let targetNodeId = findNearestNode(targetPos, graph.nodes);
    if (!agentNodeId || !targetNodeId) {
      res.status(200).json(buildInitResponse({
        sessionId: '', path: [], totalCost: Infinity,
        status: 'NO_ROUTE',
        success: false,
        navigationState: 'NO_ROUTE',
        responsePathSource: 'error_empty',
        plannerAttempted: false,
        plannerSucceeded: null,
        mapboxApiCalled,
        graphCreatedAt: graph.createdAt,
        graphNodeCount,
        graphEdgeCount,
        initFailureReason: 'graph_invalid',
        routeProvenance,
      }));
      return;
    }

    // Same-node snap: handle all three cases before entering the planner.
    // threshold = 30m (matches SAME_NODE_ARRIVAL_THRESHOLD_M in update/route.ts)
    const initGpsDistM = haversine(agentPos.lat, agentPos.lng, targetPos.lat, targetPos.lng);
    if (agentNodeId === targetNodeId) {
      log.info({
        agentNodeId, targetNodeId, initGpsDistM: Math.round(initGpsDistM), graphNodeCount,
        sameNodeSnapDetected: true, sameNodeGpsDistanceM: Math.round(initGpsDistM),
      }, 'SAME_NODE_SNAP_INIT_DETECTED');

      if (initGpsDistM <= 30) {
        // Agent is near target — do NOT fall back to routePolyline
        log.info({
          agentNodeId, initGpsDistM: Math.round(initGpsDistM), sameNodeResolution: 'near_target_no_plan',
        }, 'SAME_NODE_NEAR_TARGET_INIT_NO_ROUTE');
        res.status(200).json(buildInitResponse({
          sessionId: '', path: [], totalCost: 0, status: 'ARRIVED',
          success: true,
          navigationState: 'ARRIVED',
          responsePathSource: 'same_node_arrived',
          plannerAttempted: false,
          plannerSucceeded: null,
          mapboxApiCalled,
          graphCreatedAt: graph.createdAt,
          graphNodeCount,
          graphEdgeCount,
          initFailureReason: 'same_node_arrived',
          routeProvenance,
        }));
        return;
      }

      const alt = findNearestNode(targetPos, graph.nodes, { excludeNodeId: agentNodeId });
      if (!alt) {
        log.warn({
          agentNodeId, initGpsDistM: Math.round(initGpsDistM), sameNodeResolution: 'no_alternate',
        }, 'SAME_NODE_NO_ALTERNATE_INIT');
        res.status(200).json(buildInitResponse({
          sessionId: '', path: [], totalCost: Infinity, status: 'NO_ROUTE',
          success: false,
          navigationState: 'SNAP_AMBIGUITY',
          responsePathSource: 'error_empty',
          plannerAttempted: false,
          plannerSucceeded: null,
          mapboxApiCalled,
          graphCreatedAt: graph.createdAt,
          graphNodeCount,
          graphEdgeCount,
          initFailureReason: 'same_node_no_alternate',
          routeProvenance,
        }));
        return;
      }
      log.info({
        oldTargetNodeId: targetNodeId, newTargetNodeId: alt, initGpsDistM: Math.round(initGpsDistM),
        sameNodeResolution: 'alternate_target_selected',
      }, 'SAME_NODE_TARGET_SNAP_ALTERNATE_SELECTED_INIT');
      targetNodeId = alt;
    }

    // 4. MT-D* Lite — THE path decision maker
    const planner = new MTDStarLitePlanner(graph);
    planner.initialize(agentNodeId, targetNodeId);
    const success = planner.computePath();

    // 5. Extract path: MT-D* decides route → extractPath maps to road geometry
    const selectedTraversal = success
      ? planner.extractPathWithEdges()
      : { path: [], edges: [] };
    const path = selectedTraversal.path;
    const rawPlannerPathLen = path.length;
    const responsePathSource: InitResponsePathSource =
      success && path.length >= 2 ? 'planner_prepared' : 'error_empty';
    const initFailureReason: InitFailureReason =
      success ? (path.length < 2 ? 'extract_path_empty' : null) : 'planner_failed';

    // Guard: computePath=true but extractPath=[] means broken parent chain
    if (!success || path.length < 2) {
      log.warn({
        sessionId: 'pre-save',
        success,
        pathLen: path.length,
        fallbackPathLen: graph.routePolyline.length,
      }, 'INVALID_PATH_TOO_SHORT_BLOCKED');
      log.warn({
        pathLen: path.length,
        routePolylineLen: graph.routePolyline.length,
        plannerSucceeded: false,
        responsePathSource: 'error_empty',
        initFailureReason,
      }, 'INIT_ROUTEPOLYLINE_FALLBACK_FORBIDDEN');
      res.status(200).json(buildInitResponse({
        sessionId: '', path: [], totalCost: Infinity, status: 'NO_ROUTE' as const,
        success: false,
        navigationState: 'NO_ROUTE',
        responsePathSource: 'error_empty',
        plannerAttempted: true,
        plannerSucceeded: false,
        mapboxApiCalled,
        graphCreatedAt: graph.createdAt,
        graphNodeCount,
        graphEdgeCount,
        initFailureReason,
        rawPlannerPathLen,
        routeProvenance,
      }));
      return;
    }

    const totalCost = graph.totalDistance;

    // 6. GPS filter (prime)
    const gps = new GPSKalmanFilter();
    gps.update(agentPos.lat, agentPos.lng, 5);

    // 7. Save session
    const sessionId = generateSessionId();
    await saveSession({
      sessionId,
      graph,
      plannerState: planner.serialize(),
      gpsFilterState: gps.serialize(),
      lastAgentPos: agentPos,
      lastTargetPos: targetPos,
      lastRefetchTargetPos: targetPos,
      graphCenterPos: targetCenteredData.graphCenterPos,
      graphRadiusM: TARGET_GRAPH_RADIUS_M,
      navigationMode: navMode,
      consecutiveRefetchCount: 0,
      lastRefetchReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateCount: 0,
      mapboxUsage: {
        mapboxCallsTotal:      mbResponses.length + targetCenteredData.rays.length,
        mapboxInitCalls:       mbResponses.length + targetCenteredData.rays.length,
        mapboxRefetchCalls:    0,
        mapboxBubbleCalls:     0,
        mapboxCorridorCalls:   mbResponses.length,
        mapboxTargetGraphCalls: targetCenteredData.rays.length,
        updateTicks:           0,
      },
    });

    // 8. Metrics
    const lat = Date.now() - t0;
    metrics.recordLatency(lat);
    metrics.setActiveSessions(await getActiveSessionCount());

    log.info({
      sessionId, pathLen: path.length, totalCost: Math.round(totalCost),
      nodes: Object.keys(graph.nodes).length, ms: lat,
    }, 'Session created');

    res.status(200).json(buildInitResponse({
      sessionId,
      path,
      maneuvers: maneuversForPath(selectedTraversal.edges, path),
      totalCost: Math.round(totalCost),
      status: 'OK',
      corridorNodeCount: Object.keys(graph.nodes).length,
      estimatedTimeSeconds: Math.round(mbResponses[0].routes[0]?.duration ?? 0),
      success: true,
      navigationState: 'NAVIGATING',
      responsePathSource,
      plannerAttempted: true,
      plannerSucceeded: responsePathSource === 'planner_prepared',
      mapboxApiCalled,
      graphCreatedAt: graph.createdAt,
      graphNodeCount,
      graphEdgeCount,
      initFailureReason: responsePathSource === 'planner_prepared' ? null : initFailureReason,
      rawPlannerPathLen,
      routeProvenance,
    }));
    return;

  } catch (err) {
    metrics.recordLatency(Date.now() - t0);
    metrics.recordError();
    if (err instanceof AppError) {
      log.error({ code: err.code }, err.message);
      res.status(err.statusCode).json(
        buildInitResponse({
          sessionId: '',
          path: [],
          totalCost: Infinity,
          status: 'ERROR',
          success: false,
          navigationState: 'ERROR',
          responsePathSource: 'error_empty',
          plannerAttempted: false,
          plannerSucceeded: null,
          mapboxApiCalled,
          graphCreatedAt: null,
          graphNodeCount: null,
          graphEdgeCount: null,
          initFailureReason: 'graph_invalid',
          routeProvenance,
        }),
      );
      return;
    }
    log.error({ err: String(err) }, 'Unexpected error');
    res.status(500).json(
      buildInitResponse({
        sessionId: '',
        path: [],
        totalCost: Infinity,
        status: 'ERROR',
        success: false,
        navigationState: 'ERROR',
        responsePathSource: 'error_empty',
        plannerAttempted: false,
        plannerSucceeded: null,
        mapboxApiCalled,
        graphCreatedAt: null,
        graphNodeCount: null,
        graphEdgeCount: null,
        initFailureReason: 'graph_invalid',
        routeProvenance,
      }),
    );
    return;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const context = researchContextFromRequestBody(req.body, 'init');
  return withBackendResearchContext(context, () => handleRequest(req, res));
}
