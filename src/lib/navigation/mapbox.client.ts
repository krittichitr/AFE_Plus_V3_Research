import type { Coordinate, MapboxDirectionsResponse } from '@/lib/navigation/types';
import { CircuitBreaker } from './circuit-breaker';
import { createLogger, MapboxApiError } from './logger';
import { env } from '@/config/navigation-env';
import { recordMapboxHttpAttempt } from '@/lib/research/backendResearch';

const log = createLogger('mapbox-client');

const breaker = new CircuitBreaker({
  name: 'mapbox-directions',
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  maxRetries: 2,
});

// Dedicated breaker for bubble rays — isolated from corridor breaker.
// More permissive thresholds: bubble failures are opportunistic and non-critical.
// A bubble outage must never disable corridor routing.
const bubbleBreaker = new CircuitBreaker({
  name: 'mapbox-bubble',
  failureThreshold: 5,
  resetTimeoutMs: 15_000,
  requestTimeoutMs: 4_000,
  maxRetries: 1,
});

type DirectionsOptions = {
  profile?: 'driving' | 'walking' | 'cycling';
  alternatives?: boolean;
};

export async function fetchDirections(
  origin: Coordinate,
  destination: Coordinate,
  options?: DirectionsOptions,
): Promise<MapboxDirectionsResponse> {
  const token = env.MAPBOX_ACCESS_TOKEN;
  const profile = options?.profile ?? env.MAPBOX_PROFILE;
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;

  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}`,
  );
  url.searchParams.set('access_token', token);
  url.searchParams.set('steps', 'true');
  url.searchParams.set('geometries', 'polyline6');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('annotations', 'distance,duration');
  if (options?.alternatives) {
    url.searchParams.set('alternatives', 'true');
  }

  log.info({ origin, destination, profile, alternatives: options?.alternatives ?? false }, 'Fetching Mapbox directions');

  const response = await breaker.execute(async () => {
    // AbortSignal.timeout สำหรับ hard timeout 5s
    recordMapboxHttpAttempt(`profile/corridor:${profile}`);
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MapboxApiError(
        `Mapbox ${res.status}: ${body.slice(0, 200)}`,
        res.status >= 500 ? 502 : 400,
      );
    }

    return res.json() as Promise<MapboxDirectionsResponse>;
  });

  if (response.code !== 'Ok' || response.routes.length === 0) {
    throw new MapboxApiError(`Mapbox code: ${response.code}`);
  }

  const route = response.routes[0];
  log.info({
    distance: route.distance,
    duration: route.duration,
    steps: route.legs[0]?.steps.length ?? 0,
  }, 'Directions fetched');

  return response;
}

export async function fetchMultiProfileDirections(
  start: Coordinate,
  end: Coordinate,
): Promise<MapboxDirectionsResponse[]> {
  let drivingMs = 0;
  let walkingMs = 0;

  const [drivingResult, walkingResult] = await Promise.allSettled([
    (async () => {
      const ts = Date.now();
      const res = await fetchDirections(start, end, { profile: 'driving', alternatives: true });
      drivingMs = Date.now() - ts;
      return res;
    })(),
    (async () => {
      const ts = Date.now();
      const res = await fetchDirections(start, end, { profile: 'walking', alternatives: true });
      walkingMs = Date.now() - ts;
      return res;
    })(),
  ]);

  const drivingResponse = drivingResult.status === 'fulfilled' ? drivingResult.value : null;
  const walkingResponse = walkingResult.status === 'fulfilled' ? walkingResult.value : null;

  if (drivingResult.status === 'rejected') {
    log.error({ err: String(drivingResult.reason) }, 'Driving profile fetch failed');
  }
  if (walkingResult.status === 'rejected') {
    log.error({ err: String(walkingResult.reason) }, 'Walking profile fetch failed');
  }

  log.info({
    drivingRoutes: drivingResponse?.routes?.length ?? 0,
    walkingRoutes: walkingResponse?.routes?.length ?? 0,
    drivingMs,
    walkingMs,
  }, 'MULTI_PROFILE_FETCH');

  const results: MapboxDirectionsResponse[] = [];
  if (drivingResponse) results.push(drivingResponse);
  if (walkingResponse) results.push(walkingResponse);

  if (results.length === 0) {
    throw new MapboxApiError('All direction profiles failed');
  }

  return results;
}

export function getMapboxCircuitState() {
  return breaker.getState();
}

/**
 * Walking-profile Directions fetch for bubble graph rays.
 * Uses bubbleBreaker — fully isolated from the corridor circuit breaker.
 * Failures propagate to the caller; fetchBubbleRays() in bubble.graph.ts
 * catches them via Promise.allSettled and never throws into navigation.
 */
export async function fetchDirectionsBubble(
  origin: Coordinate,
  destination: Coordinate,
): Promise<MapboxDirectionsResponse> {
  const token = env.MAPBOX_ACCESS_TOKEN;
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/walking/${coords}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('steps', 'true');
  url.searchParams.set('geometries', 'polyline6');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('annotations', 'distance,duration');

  const response = await bubbleBreaker.execute(async () => {
    recordMapboxHttpAttempt('target_ray/bubble');
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new MapboxApiError(`Bubble Mapbox ${res.status}: ${body.slice(0, 200)}`, res.status >= 500 ? 502 : 400);
    }
    return res.json() as Promise<MapboxDirectionsResponse>;
  });

  if (response.code !== 'Ok' || response.routes.length === 0) {
    throw new MapboxApiError(`Bubble Mapbox code: ${response.code}`);
  }
  return response;
}
