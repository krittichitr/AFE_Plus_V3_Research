/**
 * Bubble Graph — production utilities for target-local road graph augmentation.
 *
 * Generates 8 Mapbox walking-profile direction rays from a target position and
 * merges results into the corridor responses array passed to buildCorridorGraph().
 * Uses a dedicated circuit breaker (mapbox-bubble) so ray failures cannot
 * contaminate the main corridor circuit breaker (mapbox-directions).
 *
 * Integration point: refetchRoute() in app/api/navigate/update/route.ts
 * Feature flag:      ENABLE_BUBBLE_GRAPH=true
 */
import type { Coordinate, MapboxDirectionsResponse, SerializableGraph } from '@/lib/navigation/types';
import { fetchDirectionsBubble } from './mapbox.client';
import { createLogger } from './logger';

const log = createLogger('bubble-graph');

/** Radius of the target-centered walking graph around the target position. */
export const TARGET_GRAPH_RADIUS_M = 300;
/** Backward-compat alias — prefer TARGET_GRAPH_RADIUS_M for new code. */
export const BUBBLE_RADIUS_M = TARGET_GRAPH_RADIUS_M;
export const BUBBLE_RAY_COUNT = 8;

export type AnchorPoint = { direction: string; pos: Coordinate };

export function generateAnchorPoints(center: Coordinate, radiusM: number): AnchorPoint[] {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.cos(center.lat * Math.PI / 180));
  const d45  = Math.SQRT1_2;

  return [
    { direction: 'N',  pos: { lat: center.lat + dLat,        lng: center.lng              } },
    { direction: 'S',  pos: { lat: center.lat - dLat,        lng: center.lng              } },
    { direction: 'E',  pos: { lat: center.lat,               lng: center.lng + dLng       } },
    { direction: 'W',  pos: { lat: center.lat,               lng: center.lng - dLng       } },
    { direction: 'NE', pos: { lat: center.lat + dLat * d45,  lng: center.lng + dLng * d45 } },
    { direction: 'NW', pos: { lat: center.lat + dLat * d45,  lng: center.lng - dLng * d45 } },
    { direction: 'SE', pos: { lat: center.lat - dLat * d45,  lng: center.lng + dLng * d45 } },
    { direction: 'SW', pos: { lat: center.lat - dLat * d45,  lng: center.lng - dLng * d45 } },
  ];
}

// BFS over bidirectional graph.edges — counts isolated subgraphs.
export function countConnectedComponents(graph: SerializableGraph): number {
  const visited = new Set<string>();
  let components = 0;

  for (const nodeId of Object.keys(graph.nodes)) {
    if (visited.has(nodeId)) continue;
    components++;
    const queue: string[] = [nodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const edge of graph.edges[cur] ?? []) {
        if (!visited.has(edge.to)) queue.push(edge.to);
      }
    }
  }

  return components;
}

/**
 * Fire 8 walking-profile Mapbox Direction rays from targetPos outward at BUBBLE_RADIUS_M.
 * Returns only fulfilled responses — failures are logged and swallowed.
 * Empty array is a valid return value (all rays failed); callers must handle gracefully.
 */
export async function fetchBubbleRays(
  targetPos: Coordinate,
  radiusM: number = TARGET_GRAPH_RADIUS_M,
): Promise<MapboxDirectionsResponse[]> {
  const anchors = generateAnchorPoints(targetPos, radiusM);

  const settled = await Promise.allSettled(
    anchors.map(({ pos, direction }) => fetchDirectionsBubble(targetPos, pos, direction)),
  );

  const responses: MapboxDirectionsResponse[] = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      responses.push(result.value);
    } else {
      log.warn({ direction: anchors[i].direction, err: String(result.reason) }, 'BUBBLE_RAY_FAILED');
    }
  }

  return responses;
}

/**
 * Build target-centered augmentation data.
 * Fires BUBBLE_RAY_COUNT walking-profile rays from targetPos outward at radiusM.
 * Target position is the graph center — rays radiate FROM target so the road
 * network immediately surrounding the target is maximally covered.
 *
 * Returns rays to be merged with corridor responses in buildCorridorGraph(),
 * plus center metadata for session storage and debug display.
 */
export async function buildTargetCenteredGraph(
  targetPos: Coordinate,
  radiusM: number,
): Promise<{
  rays: MapboxDirectionsResponse[];
  graphCenterPos: Coordinate;
  graphRadiusM: number;
  successfulRayCount: number;
  failedRayCount: number;
}> {
  const rays = await fetchBubbleRays(targetPos, radiusM);
  return {
    rays,
    graphCenterPos: targetPos,
    graphRadiusM: radiusM,
    successfulRayCount: rays.length,
    failedRayCount: BUBBLE_RAY_COUNT - rays.length,
  };
}
