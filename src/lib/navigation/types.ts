// ─── Coordinate ───────────────────────────────────────────────────────────────
export interface Coordinate {
  lat: number;
  lng: number;
}

export interface RouteProvenance {
  route_update_id: string;
  target_sample_id: string | null;
  target_ref_lat: number;
  target_ref_lng: number;
  research_run_id?: string;
  research_request_phase?: 'init' | 'restore' | 'incremental';
}

export type BackendResearchEvent = {
  event: 'route_update_start' | 'route_update_end' | 'mapbox_http_attempt';
  research_run_id: string;
  route_update_id: string;
  target_sample_id: string | null;
  target_ref_lat: number;
  target_ref_lng: number;
  source: 'backend';
  server_wall_clock_ms: number;
  backend_mono_ms: number;
  [key: string]: unknown;
};

// ─── Graph (Corridor) ─────────────────────────────────────────────────────────
export interface GraphNode {
  id: string;
  lat: number;
  lng: number;
}

export interface GraphEdgeManeuver {
  type: string;
  modifier?: string;
  location: Coordinate;
  sourceStepIndex: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  cost: number; // meters
  geometry?: Coordinate[]; // Detailed path coordinates
  edgeSource?: 'within_step' | 'boundary_edge' | 'virtual_node_agent' | 'unknown';
  edgeGeomSource?: 'slice' | 'fallback_direct' | 'no_step_geometry' | 'boundary_connector' | 'virtual_node_agent';
  isBoundaryEdge?: boolean;
  /** true when Mapbox provided only 2 matched geometry points for this segment */
  sparseGeometry?: boolean;
  sparseGeometryReason?: string; // 'mapbox_sparse_step_geometry'
  /** true when a long 2-point boundary_edge was densified at graph build time to stay below MAX_PATH_JUMP_M */
  boundaryEdgeDensified?: boolean;
  /** Directional Mapbox metadata; observational only and never used for routing. */
  maneuver?: GraphEdgeManeuver;
  /** Prevent geometry-only guidance where the edge provenance is not voice-safe. */
  maneuverGeometryFallbackExcluded?: 'target_ray' | 'complex_semantic';
  /** True only for a synthetic reverse direction lacking Mapbox authority. */
  maneuverGeometryFallbackEligible?: true;
}

export type NavigationManeuverType =
  | 'TURN_LEFT'
  | 'TURN_RIGHT'
  | 'SLIGHT_LEFT'
  | 'SLIGHT_RIGHT'
  | 'UTURN';

export interface NavigationManeuver {
  type: NavigationManeuverType;
  location: Coordinate;
  source: 'mapbox' | 'geometry-fallback';
  sourceStepIndex?: number;
}

export interface SerializableGraph {
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge[]>;
  corridorPolyline: Coordinate[];
  /** Full Mapbox route geometry decoded from polyline — follows actual roads */
  routePolyline: Coordinate[];
  totalDistance: number;
  totalDuration: number;
  createdAt: number;
}

// ─── MT-D* Lite ───────────────────────────────────────────────────────────────
export interface HeapEntry {
  id: string;
  key: [number, number];
}

/** Map → Array serialization สำหรับ Redis */
export interface PlannerState {
  g: [string, number][];
  rhs: [string, number][];
  parent: [string, string | null][];
  openHeap: HeapEntry[];
  km: number;
  sstart: string;
  sgoal: string;
  iterationCount: number;
}

export interface PathResult {
  success: boolean;
  path: Coordinate[];
  totalCost: number;
  // Sparse geometry scan — populated by step(), not by extractPath()
  pathUsesSparseGeometry: boolean;
  sparseGeometryMaxJumpM: number | null;
  sparseGeometryEdgeCount: number;
  jumpClassification?: JumpClassification;
  jumpTrace?: PathJumpTrace;
}

export type JumpClassification =
  | 'sparse_geometry'
  | 'boundary_edge'
  | 'junction_gap'
  | 'unknown_two_point'
  | 'missing_geometry'
  | 'unknown';

export interface PathJumpTrace {
  maxJumpM: number;
  jumpClassification: JumpClassification;
  edgeId: string | null;
  edgeSource: string | null;
  pathUsesSparseGeometry: boolean;
  sparseGeometryMaxJumpM: number | null;
  sparseGeometryEdgeCount: number;
  geometryPointCount: number | null;
  allowed: boolean;
}

// ─── GPS Filter ───────────────────────────────────────────────────────────────
export interface KalmanState {
  x: number;
  p: number;
}

export interface GPSFilterState {
  latState: KalmanState | null;
  lngState: KalmanState | null;
  lastTimestamp: number;
  speedEstimate: number;
  lastCoord: Coordinate | null;
}

// ─── Nav Metric ───────────────────────────────────────────────────────────────
export interface NavMetric {
  timestamp: number;
  sessionId: string;
  mode: 'hybrid' | 'mapbox_only';
  status: 'OK' | 'ARRIVED' | 'NO_ROUTE' | 'ERROR';
  replanType: 'incremental' | 'refetch' | 'mapbox_call' | 'blocked';
  mapboxApiCalled: boolean;
  stepMs: number;
  totalMs: number;
  pathLen: number;
  totalCost: number;
  maxPathJumpM: number;
  maxPathJumpThresholdM?: number;
  agentCorridorM: number;
  targetCorridorM: number;
  targetForwardDistM: number;
  refetchReason?: string | null;
  responsePathLen?: number | null;
  pathSource?: string | null;
  refetchSuccess?: boolean | null;
  responsePathSource?:
    | 'planner_prepared'
    | 'error_empty'
    | 'same_node_arrived'
    | 'same_node_alternate'
    | 'sparse_geometry_allowed'
    | 'refetch_planner_failed_no_fallback'
    | 'manual_reroute'
    | 'unknown'
    | null;
  consecutiveRefetchCount?: number;
  targetGapM?: number | null;
  pathReachesTarget?: boolean | null;
  terminatesEarly?: boolean | null;
  lastMileMode?: 'none' | 'direct' | 'walking';
  lastMileDistanceM?: number;
  lastMileMapboxCalled?: boolean;
  // ─── Semantic navigation metrics ───────────────────────────────────────────
  roadTargetGapM?: number | null;              // haversine(path.last(), graph.nodes[tId]) — road-to-road
  targetSnapDistanceM?: number | null;         // haversine(targetPos, snapped road node)
  snappedTargetNodeChanged?: boolean | null;   // did tId change from previous tick?
  targetGpsToRouteEndM?: number | null;        // haversine(targetPos, path.last()) — diagnostic only
  snappedTargetNodeId?: string | null;         // current tId
  previousSnappedTargetNodeId?: string | null; // tId from previous tick
  // ─── Phase 1: Target edge projection telemetry (dry-run, no behavior change) ──
  targetProjectionAttempted?: boolean | null;
  targetProjectionAvailable?: boolean | null;
  targetProjectionDistanceM?: number | null;
  projectedTargetPoint?: Coordinate | null;
  projectedEdgeFrom?: string | null;
  projectedEdgeTo?: string | null;
  projectedDistanceAlongEdgeM?: number | null;
  projectedTargetFallbackReason?: string | null;
  wouldUseProjectedTarget?: boolean | null;
  // ─── Graph identity (Patch 5 — evidence telemetry) ─────────────────────────
  graphCreatedAt?: number | null;
  graphNodeCount?: number | null;
  graphEdgeCount?: number | null;
  graphCenterPos?: Coordinate | null;
  graphRadiusM?: number | null;
  targetDistanceToGraphCenterM?: number | null;
  outsideGraphCount?: number | null;
  // ─── Sparse geometry (Mapbox 2-point segments allowed past jump gate) ────────
  pathUsesSparseGeometry?: boolean | null;
  sparseGeometryMaxJumpM?: number | null;
  sparseGeometryEdgeCount?: number | null;
  jumpClassification?: JumpClassification | null;
  jumpEdgeId?: string | null;
  jumpEdgeSource?: string | null;
  jumpGeometryPointCount?: number | null;
  jumpAllowed?: boolean | null;
  // ─── PATCH 6G: Endpoint enforcement telemetry ────────────────────────────────
  pathEndpoint?: Coordinate | null;
  routeGoalType?: 'EDGE_PROJECTION' | 'NODE_SNAP' | 'LAST_ROAD_ATTACHMENT' | 'OFF_ROAD_UNREACHABLE' | null;
  routeGoalPoint?: Coordinate | null;
  targetGpsPoint?: Coordinate | null;
  offRoadDistanceM?: number | null;
  reachableByRoad?: boolean | null;
  preEnforcementEndpointDistanceM?: number | null;
  finalEndpointDistanceM?: number | null;
  endpointDistanceM?: number | null;
  endpointEnforced?: boolean | null;
  endpointTrimmed?: boolean | null;
  endpointExtended?: boolean | null;
  frozenAttachmentValid?: boolean | null;
  lastTargetRoadAttachmentPoint?: Coordinate | null;
  lastTargetProjectionDistanceM?: number | null;
  frozenDistanceM?: number | null;
  endpointEnforcementFailed?: boolean | null;
  // ─── Phase 7F-3B: Navigation truth fields for Field Test Monitor ──────────────
  // Derived and stored by appendMetric — do NOT set in NavMetric literals directly.
  navigationState?: string | null;              // INSIDE_GRAPH | OUTSIDE_GRAPH | ARRIVED | SAME_NODE | NO_ROUTE
  plannerAttempted?: boolean | null;            // true if planner.step() was called this tick
  plannerSucceeded?: boolean | null;            // true if planner produced a renderable path
  targetCoveredBySessionGraph?: boolean | null; // from evaluateGraphCoverage()
  targetCoverageReason?: string | null;         // EDGE_PROJECTION | NODE_SNAP | OFF_ROAD_NEAR_GRAPH | OUTSIDE_GRAPH | UNREACHABLE
  // ─── M4-E2: target attachment validity (distinct from geographic coverage above) ──
  targetAttachmentValid?: boolean | null;       // from evaluateTargetAttachment() — true only in ATTACHED band
  targetAttachmentBand?: 'ATTACHED' | 'GRACE' | 'SUSPECT' | 'OUTSIDE' | null;
  targetAttachmentInvalidReason?: 'no_projection' | 'distance_band' | null;
  targetAttachmentInvalidStreak?: number | null;
}

// ─── Session ──────────────────────────────────────────────────────────────────
export interface SessionData {
  sessionId: string;
  graph: SerializableGraph;
  plannerState: PlannerState;
  gpsFilterState: GPSFilterState;
  lastAgentPos: Coordinate;
  lastTargetPos: Coordinate;
  lastRefetchTargetPos?: Coordinate;
  /** Last confirmed road attachment point for target — projected point on edge geometry (≤30m from GPS). */
  lastTargetRoadAttachmentPoint?: Coordinate;
  lastTargetRoadAttachmentEdgeFrom?: string;
  lastTargetRoadAttachmentEdgeTo?: string;
  lastTargetProjectionDistanceM?: number;
  /** M4-E2: consecutive ticks target attachment has been non-ATTACHED. Reset to 0 on ATTACHED. Absent/undefined on old sessions — treat as 0. */
  targetAttachmentInvalidStreak?: number;
  /** Center of the target-centered graph (= targetPos at last graph build). */
  graphCenterPos?: Coordinate;
  /** Radius used when building the target-centered walking graph (meters). */
  graphRadiusM?: number;
  metrics?: NavMetric[];
  navigationMode?: NavDistanceMode;
  lastRefetchReason?: string | null;
  consecutiveRefetchCount?: number;
  createdAt: number;
  updatedAt: number;
  updateCount: number;
  mapboxUsage?: {
    mapboxCallsTotal: number;
    mapboxInitCalls: number;
    mapboxRefetchCalls: number;
    mapboxBubbleCalls: number;
    mapboxCorridorCalls: number;
    mapboxTargetGraphCalls: number;
    updateTicks: number;
  };
}

// ─── Mapbox Directions Response ───────────────────────────────────────────────
export interface MapboxIntersection {
  location: [number, number];
  bearings: number[];
  entry: boolean[];
}

export interface MapboxStep {
  distance: number;
  duration: number;
  geometry: string;
  name: string;
  intersections: MapboxIntersection[];
  maneuver: {
    type: string;
    modifier?: string;
    location: [number, number];
    bearing_before: number;
    bearing_after: number;
  };
}

export interface MapboxLeg {
  distance: number;
  duration: number;
  steps: MapboxStep[];
  summary: string;
}

export interface MapboxRoute {
  distance: number;
  duration: number;
  geometry: string;
  legs: MapboxLeg[];
  weight: number;
  weight_name: string;
}

export interface MapboxDirectionsResponse {
  code: string;
  routes: MapboxRoute[];
  waypoints: Array<{
    name: string;
    location: [number, number];
    distance: number;
  }>;
}

// ─── API Contracts ────────────────────────────────────────────────────────────
export interface CostChange {
  u: string;
  v: string;
  oldCost: number;
  newCost: number;
}

export interface InitRequest {
  agentPos: Coordinate;
  targetPos: Coordinate;
  routeProvenance?: RouteProvenance | null;
}

export interface InitResponse {
  sessionId: string;
  path: Coordinate[];
  maneuvers?: NavigationManeuver[];
  totalCost: number;
  status: 'OK' | 'ARRIVED' | 'NO_ROUTE' | 'ERROR';
  corridorNodeCount?: number;
  estimatedTimeSeconds?: number;
  success?: boolean;
  navigationState?: 'INITIALIZING' | 'NAVIGATING' | 'UPDATING_ROUTE' | 'REBUILDING_GRAPH' | 'ARRIVED' | 'NO_ROUTE' | 'SNAP_AMBIGUITY' | 'ERROR';
  responsePathSource?:
    | 'planner_prepared'
    | 'error_empty'
    | 'same_node_arrived'
    | 'same_node_alternate'
    | 'sparse_geometry_allowed'
    | 'refetch_planner_failed_no_fallback'
    | 'manual_reroute'
    | 'unknown'
    | null;
  plannerAttempted?: boolean;
  plannerSucceeded?: boolean | null;
  mapboxApiCalled?: boolean;
  graphCreatedAt?: number | null;
  graphNodeCount?: number | null;
  graphEdgeCount?: number | null;
  initFailureReason?:
    | 'planner_failed'
    | 'extract_path_empty'
    | 'graph_invalid'
    | 'same_node_arrived'
    | 'same_node_no_alternate'
    | null;
  routeProvenance?: RouteProvenance | null;
  research_events?: BackendResearchEvent[];
}

export interface UpdateRequest {
  sessionId: string;
  agentPos: Coordinate;
  targetPos: Coordinate;
  costChanges?: CostChange[];
  routeProvenance?: RouteProvenance | null;
}

export interface UpdateResponse {
  success: boolean;
  path: Coordinate[];
  maneuvers?: NavigationManeuver[];
  totalCost: number;
  status: 'OK' | 'ARRIVED' | 'NO_ROUTE' | 'ERROR';
  navigationState?: 'INITIALIZING' | 'NAVIGATING' | 'UPDATING_ROUTE' | 'REBUILDING_GRAPH' | 'ARRIVED' | 'NO_ROUTE' | 'SNAP_AMBIGUITY' | 'ERROR';
  suggestedPollIntervalMs?: number;
  estimatedTimeSeconds?: number;
  lastMetric?: NavMetric;
  refetchReason?: string | null;
  consecutiveRefetchCount?: number;
  targetGapM?: number | null;
  pathReachesTarget?: boolean | null;
  terminatesEarly?: boolean | null;
  lastMileMode?: 'none' | 'direct' | 'walking';
  lastMileDistanceM?: number;
  lastMileMapboxCalled?: boolean;
  // ─── Semantic navigation metrics ───────────────────────────────────────────
  roadTargetGapM?: number | null;
  targetSnapDistanceM?: number | null;
  snappedTargetNodeChanged?: boolean | null;
  targetGpsToRouteEndM?: number | null;
  maxJumpM?: number | null;
  jumpClassification?: JumpClassification | null;
  edgeId?: string | null;
  edgeSource?: string | null;
  pathUsesSparseGeometry?: boolean | null;
  sparseGeometryMaxJumpM?: number | null;
  sparseGeometryEdgeCount?: number | null;
  geometryPointCount?: number | null;
  allowed?: boolean | null;
  jumpEdgeId?: string | null;
  jumpEdgeSource?: string | null;
  jumpGeometryPointCount?: number | null;
  jumpAllowed?: boolean | null;
  // ─── PATCH 6B: Road attachment policy ──────────────────────────────────────
  routeGoalType?: 'EDGE_PROJECTION' | 'NODE_SNAP' | 'LAST_ROAD_ATTACHMENT' | 'OFF_ROAD_UNREACHABLE' | null;
  routeGoalPoint?: Coordinate | null;
  targetGpsPoint?: Coordinate | null;
  offRoadDistanceM?: number | null;
  reachableByRoad?: boolean | null;
  // ─── PATCH 6D: Path extend/trim diagnostics ─────────────────────────────────
  routeGoalNodeId?: string | null;
  routeGoalEdgeFrom?: string | null;
  routeGoalEdgeTo?: string | null;
  routeGoalProjectedRatio?: number | null;
  pathExtendedToProjection?: boolean;
  pathTrimmedToProjection?: boolean;
  // ─── PATCH 6G: Endpoint enforcement diagnostics ─────────────────────────────
  pathEndpoint?: Coordinate | null;
  preEnforcementEndpointDistanceM?: number | null;
  finalEndpointDistanceM?: number | null;
  endpointDistanceM?: number | null;
  endpointEnforced?: boolean | null;
  endpointTrimmed?: boolean | null;
  endpointExtended?: boolean | null;
  routeProvenance?: RouteProvenance | null;
  research_events?: BackendResearchEvent[];
}

// ─── Navigation Mode ──────────────────────────────────────────────────────────
export type NavDistanceMode = 'long_distance' | 'local_hybrid';

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
