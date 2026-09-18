import type { NavigationManeuver, RouteProvenance } from '@/lib/navigation/types';
import { appendBackendResearchEvents } from '@/lib/research/provenanceEvents';

export interface LatLng {
  lat: number;
  lng: number;
}

export type NavigationMode = 'mapbox_only' | 'hybrid';

export type ReplanType =
  | 'initial'
  | 'incremental'
  | 'refetch'
  | 'mapbox_call'
  | 'blocked';

export interface UpdateMetric {
  timestamp:       number;
  mode:            NavigationMode;
  replanType:      ReplanType;
  mapboxApiCalled: boolean;
  stepMs:          number;
  totalMs:         number;
  pathLength:      number;
  totalCost:       number;
  targetMovedM:    number;
  agentMovedM:     number;
  refetchReason?:  string | null;
  responsePathSource?: string | null;
  pathReachesTarget?: boolean | null;
  targetCoveredBySessionGraph?: boolean | null;
  targetCoverageReason?: string | null;
  graphNodeCount?:     number | null;
  graphEdgeCount?:     number | null;
  targetProjectionM?: number | null;
  targetProjectionDistanceM?: number | null;
  targetAttachmentEdgeId?: string | null;
  targetAttachmentSource?: string | null;
  jumpClassification?: string | null;
  jumpEdgeId?: string | null;
  jumpEdgeSource?: string | null;
  jumpGeometryPointCount?: number | null;
  jumpAllowed?: boolean | null;
  pathEndpoint?: LatLng | null;
  routeGoalPoint?: LatLng | null;
  finalEndpointDistanceM?: number | null;
  endpointTrimmed?: boolean | null;
  endpointExtended?: boolean | null;
  endpointEnforced?: boolean | null;
}

interface InitResponse {
  sessionId: string;
  path: LatLng[];
  maneuvers: NavigationManeuver[];
  totalCost: number;
  status: 'OK' | 'ARRIVED' | 'NO_ROUTE' | 'ERROR';
  success?: boolean;
  navigationState?: 'INITIALIZING' | 'NAVIGATING' | 'ARRIVED' | 'NO_ROUTE' | 'SNAP_AMBIGUITY' | 'ERROR';
  responsePathSource?: string | null;
  plannerAttempted?: boolean;
  plannerSucceeded?: boolean | null;
  mapboxApiCalled?: boolean;
  initFailureReason?: string | null;
  corridorNodeCount: number;
  estimatedTimeSeconds: number;
  routeProvenance?: RouteProvenance | null;
}

interface ApiError {
  error: boolean;
  status: number;
  rateLimit?: boolean;
  message?: string;
}

interface UpdateResponse {
  success: boolean;
  path: LatLng[];
  maneuvers: NavigationManeuver[];
  totalCost: number;
  status: 'OK' | 'ARRIVED' | 'NO_ROUTE' | 'ERROR';
  suggestedPollIntervalMs: number;
  estimatedTimeSeconds?: number;
  navigationState?: 'INITIALIZING' | 'NAVIGATING' | 'UPDATING_ROUTE' | 'REBUILDING_GRAPH' | 'ARRIVED' | 'NO_ROUTE' | 'SNAP_AMBIGUITY' | 'ERROR';
  pathReachesTarget?: boolean | null;
  refetchReason?: string | null;
  maxJumpM?: number | null;
  jumpClassification?: string | null;
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
  pathEndpoint?: LatLng | null;
  routeGoalPoint?: LatLng | null;
  targetGpsPoint?: LatLng | null;
  preEnforcementEndpointDistanceM?: number | null;
  finalEndpointDistanceM?: number | null;
  endpointDistanceM?: number | null;
  endpointTrimmed?: boolean | null;
  endpointExtended?: boolean | null;
  endpointEnforced?: boolean | null;
  lastMetric?: UpdateMetric;
  routeProvenance?: RouteProvenance | null;
}

async function extractResearchEvents(response: Response, researchRunId: string | null): Promise<void> {
  if (!researchRunId) return;
  try {
    const body: unknown = await response.clone().json();
    if (body && typeof body === 'object') {
      appendBackendResearchEvents(
        (body as { research_events?: unknown }).research_events,
        researchRunId,
      );
    }
  } catch {
    // Research extraction is observational and never changes navigation handling.
  }
}

export class NavigationService {
  private apiBase: string;

  constructor() {
    this.apiBase = '';
  }

  async init(
    agentPos: LatLng,
    targetPos: LatLng,
    mode: NavigationMode = 'hybrid',
    routeProvenance: RouteProvenance | null = null,
  ): Promise<InitResponse | ApiError> {
    try {
      const url = `${this.apiBase}/api/navigate/init`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentPos, targetPos, mode, routeProvenance })
      });
      const researchRunId = routeProvenance?.research_run_id ?? null;
      
      if (res.status === 429) {
        await extractResearchEvents(res, researchRunId);
        return { error: true, status: 429, rateLimit: true };
      }
      if (!res.ok) {
        await extractResearchEvents(res, researchRunId);
        return { error: true, status: res.status };
      }
      
      const body = await res.json();
      appendBackendResearchEvents(body?.research_events, researchRunId);
      return body;
    } catch (err: unknown) {
      return { error: true, status: 500, message: getErrorMessage(err) };
    }
  }

  async update(
    sessionId: string,
    agentPos: LatLng,
    targetPos: LatLng,
    signal?: AbortSignal,
    routeProvenance: RouteProvenance | null = null,
  ): Promise<(UpdateResponse & { sessionExpired?: boolean }) | ApiError> {
    try {
      const url = `${this.apiBase}/api/navigate/update`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          agentPos,
          targetPos,
          routeProvenance,
        }),
        signal,
      });
      const researchRunId = routeProvenance?.research_run_id ?? null;

      if (res.status === 404) {
        await extractResearchEvents(res, researchRunId);
        return { sessionExpired: true } as UpdateResponse & { sessionExpired: true };
      }
      if (res.status === 429) {
        await extractResearchEvents(res, researchRunId);
        return { error: true, status: 429, rateLimit: true };
      }
      if (!res.ok) {
        await extractResearchEvents(res, researchRunId);
        return { error: true, status: res.status };
      }

      const body = await res.json();
      appendBackendResearchEvents(body?.research_events, researchRunId);
      return body;
    } catch (err: unknown) {
      // Rethrow AbortError so the caller can distinguish intentional cancellation
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return { error: true, status: 500, message: getErrorMessage(err) };
    }
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Network error';
}
