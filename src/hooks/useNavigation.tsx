'use client';

/* eslint-disable react-hooks/exhaustive-deps */

import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { NavigationService, LatLng, NavigationMode } from '@/lib/services/navigation.service';
import type { NavigationManeuver, RouteProvenance } from '@/lib/navigation/types';
import { getRecordingResearchRunId } from '@/lib/research/provenanceEvents';

const STORAGE_KEY = 'afe_navigation_session';
const SESSION_TTL_MS = 15 * 60 * 1000;
const RESTORE_AGENT_MAX_DISTANCE_M = 1000;
const RESTORE_GPS_MAX_AGE_MS = 15_000;
const RESTORE_GPS_TIMEOUT_MS = 8_000;

interface NavigationSessionData {
  sessionId: string;
  agentPos: LatLng;
  targetPos: TargetReference;
  timestamp: number;
}

export type TargetReference = LatLng & {
  targetSampleId: string | null;
};

type StartResult = {
  sessionId: string;
  pathLen: number;
  applied: boolean;
};

export type RouteUxState =
  | 'idle'
  | 'initializing'
  | 'navigating'
  | 'recalculating'
  | 'routeTemporarilyUnavailable'
  | 'arrived'
  | 'initNoRoute'
  | 'error';

export type EndpointDiagnostics = {
  responsePathLast: LatLng | null;
  pathEndpoint: LatLng | null;
  routeGoalPoint: LatLng | null;
  targetGpsPoint: LatLng | null;
  preEnforcementEndpointDistanceM: number | null;
  finalEndpointDistanceM: number | null;
  endpointTrimmed: boolean | null;
  endpointExtended: boolean | null;
  endpointEnforced: boolean | null;
  routeVersion: number;
};

export type ManeuverRouteSnapshot = {
  path: LatLng[];
  maneuvers: NavigationManeuver[];
};

type NavigationContextType = {
  sessionId: string | null;
  path: LatLng[];
  maneuvers: NavigationManeuver[];
  maneuverRoute: ManeuverRouteSnapshot | null;
  status: 'idle' | 'loading' | 'active' | 'arrived' | 'error';
  routeUxState: RouteUxState;
  start: (
    agent: LatLng,
    target: TargetReference,
    mode?: NavigationMode,
    gpsAgeMs?: number | null,
    announceFreshStart?: boolean,
  ) => Promise<StartResult | void>;
  stop: () => void;
  markArrived: () => void;
  clearNavigationSession: (reason?: string) => void;
  eta: number;
  distance: number;
  corridorNodeCount: number;
  updatePositions: (agent: LatLng, target: TargetReference) => void;
  routeVersion: number; // increments each time a valid path is successfully applied
  routeSourceKey: number; // stable Mapbox Source key — only increments on first route + Mapbox API refetch
  endpointDiagnostics: EndpointDiagnostics | null;
  restoreChecked: boolean;
  freshStartSequence: number;
  routeCandidateProvenance: RouteProvenance | null;
};

const NavigationContext = createContext<NavigationContextType | null>(null);
const EMPTY_MANEUVERS: NavigationManeuver[] = [];

function createManeuverRouteSnapshot(
  path: LatLng[],
  maneuvers: NavigationManeuver[] | undefined,
): ManeuverRouteSnapshot {
  return {
    path: path.map((point) => ({ lat: point.lat, lng: point.lng })),
    maneuvers: Array.isArray(maneuvers)
      ? maneuvers.map((maneuver) => ({
          ...maneuver,
          location: { lat: maneuver.location.lat, lng: maneuver.location.lng },
        }))
      : EMPTY_MANEUVERS,
  };
}

// Approximate meter distance using cosine-corrected projection.
function approxDistM(a: LatLng, b: LatLng): number {
  const dlat = (b.lat - a.lat) * 111320;
  const dlng = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

function isValidCoordinate(point: unknown): point is LatLng {
  if (!point || typeof point !== 'object') return false;
  const coord = point as Partial<LatLng>;
  return Number.isFinite(coord.lat) && Number.isFinite(coord.lng) && !(coord.lat === 0 && coord.lng === 0);
}

function createRouteProvenance(
  target: TargetReference,
  researchRequestPhase: NonNullable<RouteProvenance['research_request_phase']>,
): RouteProvenance {
  const researchRunId = getRecordingResearchRunId();
  return Object.freeze({
    route_update_id: crypto.randomUUID(),
    target_sample_id: target.targetSampleId,
    target_ref_lat: target.lat,
    target_ref_lng: target.lng,
    ...(researchRunId ? {
      research_run_id: researchRunId,
      research_request_phase: researchRequestPhase,
    } : {}),
  });
}

function getFreshGpsPosition(): Promise<{ position: LatLng; ageMs: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation_unavailable'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ageMs = Date.now() - pos.timestamp;
        if (ageMs > RESTORE_GPS_MAX_AGE_MS) {
          reject(new Error('gps_stale'));
          return;
        }
        resolve({
          position: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          ageMs,
        });
      },
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        timeout: RESTORE_GPS_TIMEOUT_MS,
        maximumAge: 0,
      },
    );
  });
}

// Shared route validity guard — used in all three apply paths (init, restore, polling).
// Returns false → caller must NOT call setPath or increment routeVersion.
function canApplyRoutePath(
  path: unknown,
  status?: string,
  success?: boolean,
): boolean {
  if (!Array.isArray(path) || path.length < 2) return false;
  if (status === 'NO_ROUTE' || status === 'ERROR') return false;
  if (success === false) return false;
  return true;
}

function isBackendArrivedResponse(data: {
  status?: string;
}): boolean {
  return data.status === 'ARRIVED';
}

function isSnapAmbiguityResponse(data: {
  navigationState?: string | null;
  refetchReason?: string | null;
  lastMetric?: { refetchReason?: string | null } | null;
}): boolean {
  return data.navigationState === 'SNAP_AMBIGUITY'
    || data.refetchReason === 'same_node_no_alternate'
    || data.lastMetric?.refetchReason === 'same_node_no_alternate';
}

// ── Route geometry signatures (FNV-1a 32-bit) ─────────────────────────────────
// fullSignature: FNV-1a hash of EVERY coordinate in the path.
//   Any single point change → different hash. Used for exact-duplicate detection.
// bodySignature: endpoint-side identity used only to decide whether routeVersion
// should remount the Mapbox Source. Agent-side trim must not change this.
// Material same-endpoint geometry changes still flow through setPath; the page-level
// stable Source pipeline decides whether setData is needed without remounting.
function fnv1aRoute(path: LatLng[], startIdx = 0): number {
  let h = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = startIdx; i < path.length; i++) {
    const lat = Math.round(path[i].lat * 1e6) | 0;
    const lng = Math.round(path[i].lng * 1e6) | 0;
    h = (Math.imul(h ^ lat, 16777619)) >>> 0;
    h = (Math.imul(h ^ lng, 16777619)) >>> 0;
  }
  return h;
}

function computeRouteFullSignature(path: LatLng[]): string {
  if (path.length < 2) return 'empty';
  const h     = fnv1aRoute(path);
  const first = path[0];
  const last  = path[path.length - 1];
  return `${path.length}:${h}:${first.lat.toFixed(5)},${first.lng.toFixed(5)}:${last.lat.toFixed(5)},${last.lng.toFixed(5)}`;
}

function computeRouteBodySignature(path: LatLng[]): string {
  if (path.length < 2) return 'empty';
  const last = path[path.length - 1];
  return `endpoint:${Math.round(last.lat * 1e6)},${Math.round(last.lng * 1e6)}`;
}

// tailSignature: hash of path[1..n] — excludes path[0] (agent-side trim point).
// Changes when MT-D* replans mid-route geometry even when endpoint stays the same.
// Does NOT change when only path[0] moves due to agent trim.
function computeRouteTailSignature(path: LatLng[]): string {
  if (path.length < 2) return 'empty';
  const h = fnv1aRoute(path, 1);
  return `${path.length - 1}:${h}`;
}

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [path, setPath] = useState<LatLng[]>([]);
  const [maneuverRoute, setManeuverRoute] = useState<ManeuverRouteSnapshot | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'active' | 'arrived' | 'error'>('idle');
  const [routeUxState, setRouteUxState] = useState<RouteUxState>('idle');
  const [pollMs, setPollMs] = useState(2000);
  const [eta, setEta] = useState<number>(0);
  const [distance, setDistance] = useState<number>(0);
  const [corridorNodeCount, setCorridorNodeCount] = useState<number>(0);
  const [routeVersion, setRouteVersion] = useState<number>(0);
  const [routeSourceKey, setRouteSourceKey] = useState<number>(0);
  const [endpointDiagnostics, setEndpointDiagnostics] = useState<EndpointDiagnostics | null>(null);
  const [restoreChecked, setRestoreChecked] = useState(false);
  // Observational only: increments after a successful user-visible /init.
  // Restore and silent server-session replacement never increment it.
  const [freshStartSequence, setFreshStartSequence] = useState(0);
  const [routeCandidateProvenance, setRouteCandidateProvenance] = useState<RouteProvenance | null>(null);

  const navService = useRef(new NavigationService()).current;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRestoringRef = useRef(false); // ✅ ป้องกัน infinite loop
  const isInitializingRef = useRef(false);

  // ─── Polling race-condition guards ────────────────────────────────────────
  const isUpdateInFlightRef = useRef(false);                         // true while /update in-flight
  const requestSeqRef       = useRef(0);                             // increments before each request
  const latestAppliedSeqRef = useRef(0);                             // seq of last applied response
  const abortControllerRef  = useRef<AbortController | null>(null);  // current in-flight controller

  const routeVersionRef = useRef(0);
  const routeSourceKeyRef = useRef<number>(0);
  // ─── Route geometry signature refs ───────────────────────────────────────
  // Seeded from init/restore so the first polling response can detect duplicates.
  // null = no route applied yet (forces apply + incrementRouteVersion on first response).
  const lastAppliedFullSigRef = useRef<string | null>(null);
  const lastAppliedBodySigRef = useRef<string | null>(null);
  const lastAppliedTailSigRef = useRef<string | null>(null);

  // Refs สำหรับเก็บตำแหน่งล่าสุดเพื่อหลีกเลี่ยง Stale Closure
  const agentRef = useRef<LatLng>({ lat: 0, lng: 0 });
  const targetRef = useRef<TargetReference>({ lat: 0, lng: 0, targetSampleId: null });

  useEffect(() => {
    routeVersionRef.current = routeVersion;
  }, [routeVersion]);

  const incrementRouteVersion = useCallback(() => {
    setRouteVersion(v => {
      const next = v + 1;
      routeVersionRef.current = next;
      return next;
    });
  }, []);

  const incrementRouteSourceKey = useCallback(() => {
    setRouteSourceKey(v => {
      const next = v + 1;
      routeSourceKeyRef.current = next;
      return next;
    });
  }, []);

  const updatePositions = useCallback((agent: LatLng, target: TargetReference) => {
    agentRef.current = agent;
    targetRef.current = target;
  }, []);

  const clearNavigationSession = useCallback((reason = 'fresh_start') => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    isUpdateInFlightRef.current = false;
    requestSeqRef.current       = 0;
    latestAppliedSeqRef.current = 0;
    lastAppliedFullSigRef.current = null;
    lastAppliedBodySigRef.current = null;
    lastAppliedTailSigRef.current = null;
    setSessionId(null);
    setStatus('idle');
    setRouteUxState('idle');
    setPath([]);
    setManeuverRoute(null);
    setEta(0);
    setDistance(0);
    setCorridorNodeCount(0);
    setEndpointDiagnostics(null);
    setRouteCandidateProvenance(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  // ✅ 1. Restore session จาก localStorage เมื่อ component mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) {
          setRestoreChecked(true);
          return;
        }

        const data: NavigationSessionData = JSON.parse(stored);
        data.targetPos = {
          lat: data.targetPos.lat,
          lng: data.targetPos.lng,
          targetSampleId:
            typeof data.targetPos.targetSampleId === 'string'
              ? data.targetPos.targetSampleId
              : null,
        };
        const ageMs = Date.now() - data.timestamp;

        const discardRestoredSession = (reason: string, extra?: Record<string, unknown>) => {
          localStorage.removeItem(STORAGE_KEY);
          setSessionId(null);
          setStatus('idle');
          setRouteUxState('idle');
          setPath([]);
          setManeuverRoute(null);
        };

        if (!data.sessionId || !isValidCoordinate(data.agentPos) || !isValidCoordinate(data.targetPos)) {
          discardRestoredSession('invalid_session');
          setRestoreChecked(true);
          return;
        }

        // ตรวจสอบว่า session เก่าเกินไปหรือไม่ (เกิน 15 นาที = session หมดอายุ)
        if (ageMs > SESSION_TTL_MS) {
          discardRestoredSession('expired');
          setRestoreChecked(true);
          return;
        }

        let gpsCheck: { position: LatLng; ageMs: number };
        try {
          gpsCheck = await getFreshGpsPosition();
        } catch (gpsErr) {
          discardRestoredSession('gps_unavailable', {
            gpsError: gpsErr instanceof Error ? gpsErr.message : String(gpsErr),
          });
          setRestoreChecked(true);
          return;
        }

        const restoredAgentDistanceM = approxDistM(gpsCheck.position, data.agentPos);
        if (restoredAgentDistanceM > RESTORE_AGENT_MAX_DISTANCE_M) {
          discardRestoredSession('gps_far_from_restored_agent', {
            currentGps: gpsCheck.position,
            restoredAgentPos: data.agentPos,
            distanceM: Math.round(restoredAgentDistanceM),
            thresholdM: RESTORE_AGENT_MAX_DISTANCE_M,
            gpsAgeMs: gpsCheck.ageMs,
          });
          setRestoreChecked(true);
          return;
        }

        if (isInitializingRef.current) {
          setRestoreChecked(true);
          return;
        }

        isRestoringRef.current = true;

        setSessionId(data.sessionId);
        setStatus('loading');
        setRouteUxState('initializing');

        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;

        // เรียก /update เพื่อดึง path ล่าสุด
        // หมายเหตุ: ตรงนี้ถ้า res.ok ไม่ผ่าน หรือเป็น 404 จะ return { sessionExpired: true }
        const routeProvenance = createRouteProvenance(data.targetPos, 'restore');
        const updateData = await navService.update(
          data.sessionId,
          gpsCheck.position,
          data.targetPos,
          controller.signal,
          routeProvenance,
        );

        if (controller.signal.aborted || isInitializingRef.current) {
          return;
        }

        if ('sessionExpired' in updateData && updateData.sessionExpired) {
          console.warn('🔄 Session expired on server, clearing stored session...');
          discardRestoredSession('invalid_session', { serverReason: 'session_expired' });
          return;
        }

        if ('success' in updateData && updateData.success) {
          if (!canApplyRoutePath(updateData.path, updateData.status, updateData.success)) {
            console.warn('[NAV] ROUTE_APPLY_BLOCKED_INVALID_RESPONSE', {
              source: 'restore', status: updateData.status, pathLen: (updateData.path as any)?.length ?? 0,
            });
            discardRestoredSession('invalid_session', {
              serverStatus: updateData.status,
              pathLen: (updateData.path as any)?.length ?? 0,
            });
            return;
          }
          const restoredPath = updateData.path.map((p: any) => ({ lat: p.lat, lng: p.lng }));
          agentRef.current = gpsCheck.position;
          targetRef.current = data.targetPos;
          setPath(restoredPath);
          setRouteCandidateProvenance(updateData.routeProvenance ?? null);
          setManeuverRoute(createManeuverRouteSnapshot(restoredPath, updateData.maneuvers));
          incrementRouteVersion();
          incrementRouteSourceKey();
          lastAppliedFullSigRef.current = computeRouteFullSignature(restoredPath);
          lastAppliedBodySigRef.current = computeRouteBodySignature(restoredPath);
          lastAppliedTailSigRef.current = computeRouteTailSignature(restoredPath);
          setDistance(updateData.totalCost || 0);
          setEta(updateData.estimatedTimeSeconds || 0);
          setStatus('active');
          setRouteUxState('navigating');
          {
          }
        } else {
          // Session หมดอายุหรือ error → ลบออกจาก localStorage
          console.warn('❌ Failed to restore session, clearing...');
          discardRestoredSession('invalid_session', { serverStatus: (updateData as any).status ?? null });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        console.error('❌ Restore session failed:', err);
        localStorage.removeItem(STORAGE_KEY);
        setStatus('idle');
        setRouteUxState('idle');
      } finally {
        isRestoringRef.current = false;
        setRestoreChecked(true);
      }
    };

    restoreSession();
  }, [navService, clearNavigationSession]);

  // ✅ 2. บันทึก sessionId ลง localStorage ทุกครั้งที่มีการเปลี่ยนแปลง
  useEffect(() => {
    if (!sessionId || isRestoringRef.current) return;

    const data: NavigationSessionData = {
      sessionId,
      agentPos: agentRef.current,
      targetPos: targetRef.current,
      timestamp: Date.now(),
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [sessionId]);

  // หยุดนำทาง + ล้าง timer + abort in-flight request
  const stop = useCallback(() => {
    clearNavigationSession('stop');
  }, [clearNavigationSession]);

  const markArrived = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    isUpdateInFlightRef.current = false;
    setStatus('arrived');
    setRouteUxState('arrived');
  }, [sessionId]);

  // เริ่มนำทาง (เรียก /init)
  const start = useCallback(async (
    agent: LatLng,
    target: TargetReference,
    mode: NavigationMode = 'hybrid',
    gpsAgeMs: number | null = null,
    announceFreshStart = true,
  ): Promise<StartResult | void> => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;

    clearNavigationSession('fresh_start_before_init');

    // Abort any in-flight /update request from a previous session before starting new one.
    // Without this, a late response from the old session could apply its path to the new session.
    abortControllerRef.current?.abort();
    abortControllerRef.current  = null;
    isUpdateInFlightRef.current = false;
    // Reset polling state — new session must start with clean seq counters
    requestSeqRef.current       = 0;
    latestAppliedSeqRef.current = 0;
    lastAppliedFullSigRef.current = null;
    lastAppliedBodySigRef.current = null;
    lastAppliedTailSigRef.current = null;

    setStatus('loading');
    setRouteUxState('initializing');
    try {
      const routeProvenance = createRouteProvenance(target, 'init');
      const data = await navService.init(agent, target, mode, routeProvenance);

      if ((data as any).error) {
        if ((data as any).rateLimit) {
          console.warn('⚠️ Rate limit exceeded (429), retrying in 2 seconds...');
          setTimeout(() => start(agent, target, mode, gpsAgeMs, announceFreshStart), 2000);
          return;
        }
        console.error('❌ Init failed:', (data as any).message || `Status ${(data as any).status}`);
        setStatus('error');
        setRouteUxState('error');
        return;
      }

      const initData = data as any;

      // Backend ARRIVED is a successful terminal state and intentionally has
      // no renderable route path. Handle it before route-path validation.
      if (isBackendArrivedResponse(initData)) {
        agentRef.current = agent;
        targetRef.current = target;
        setEta(0);
        setDistance(0);
        setStatus('arrived');
        setRouteUxState('arrived');
        return;
      }

      // Guard: use shared validator — catches NO_ROUTE, ERROR, path.length < 2
      if (!canApplyRoutePath(initData.path, initData.status)) {
        console.warn('[NAV] ROUTE_APPLY_BLOCKED_INVALID_RESPONSE', {
          source: 'init', status: initData.status, pathLen: initData.path?.length ?? 0,
        });
        console.warn('[NAV] NAV_INIT_APPLY_BLOCKED', {
          reason:     'canApplyRoutePath_failed',
          status:     initData.status    ?? null,
          success:    initData.success   ?? null,
          pathLen:    initData.path?.length ?? 0,
          sessionId:  initData.sessionId ?? null,
          rawSummary: { status: initData.status, pathLen: initData.path?.length ?? 0 },
        });
        if (initData.status === 'NO_ROUTE' || initData.success === false) {
          setStatus('idle');
          setRouteUxState('initNoRoute');
        } else {
          setStatus('error');
          setRouteUxState('error');
        }
        return;
      }

      setSessionId(initData.sessionId);
      setPath(initData.path);
      setRouteCandidateProvenance(initData.routeProvenance ?? null);
      setManeuverRoute(createManeuverRouteSnapshot(initData.path, initData.maneuvers));
      incrementRouteVersion();
      incrementRouteSourceKey();
      // Seed signatures so first polling response can detect duplicates/tail-only
      lastAppliedFullSigRef.current = computeRouteFullSignature(initData.path);
      lastAppliedBodySigRef.current = computeRouteBodySignature(initData.path);
      lastAppliedTailSigRef.current = computeRouteTailSignature(initData.path);
      setEta(initData.estimatedTimeSeconds || 0);
      setDistance(initData.totalCost || 0);
      setCorridorNodeCount(initData.corridorNodeCount || 0);
      setStatus('active');
      setRouteUxState('navigating');
      setPollMs(2000);

      // ✅ บันทึกตำแหน่งเริ่มต้น
      agentRef.current = agent;
      targetRef.current = target;
      if (announceFreshStart) {
        setFreshStartSequence((sequence) => sequence + 1);
      }

      return { sessionId: initData.sessionId, pathLen: initData.path.length, applied: true };
    } catch (err) {
      console.error('❌ Init error:', err);
      setStatus('error');
      setRouteUxState('error');
    } finally {
      isInitializingRef.current = false;
    }
  }, [navService, clearNavigationSession]);

  // Polling Loop (เรียก /update ทุก X วินาที)
  useEffect(() => {
    if (status !== 'active' || !sessionId) return;

    pollRef.current = setInterval(async () => {
      // ── In-flight guard: skip tick if previous request hasn't finished ──────
      if (isUpdateInFlightRef.current) {
        return;
      }

      const seq = ++requestSeqRef.current;
      const startedAt = Date.now();
      isUpdateInFlightRef.current = true;

      // Each request gets its own AbortController
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const agentPos = agentRef.current;
      const targetPos = targetRef.current;
      const routeProvenance = createRouteProvenance(targetPos, 'incremental');
      try {
        const data = await navService.update(
          sessionId,
          agentPos,
          targetPos,
          controller.signal,
          routeProvenance,
        );
        const durationMs = Date.now() - startedAt;

        // ── Stale response guard ─────────────────────────────────────────────
        if (seq <= latestAppliedSeqRef.current) {
          return;
        }

        // ── API error / 429 backoff ──────────────────────────────────────────
        // 'error' in data discriminates ApiError from UpdateResponse
        if ('error' in data) {
          if (data.rateLimit) {
            console.warn('[NAV] NAV_UPDATE_RATE_LIMIT_BACKOFF', { seq, sessionId, durationMs });
            setPollMs(15000);
          } else {
            console.error('[NAV] NAV_UPDATE_REQUEST_DONE (error)', {
              seq, sessionId, status: data.status, durationMs,
            });
            setRouteUxState('routeTemporarilyUnavailable');
          }
          return;
        }


        // ── Session expired → silent re-init ─────────────────────────────────
        if ('sessionExpired' in data && data.sessionExpired) {
          start(agentRef.current, targetRef.current, 'hybrid', null, false);
          return;
        }

        // By this point 'error' branch and sessionExpired branch have both returned.
        // TypeScript narrows data to UpdateResponse & { sessionExpired?: boolean }.
        const updateData = data;
        const responsePathLast =
          Array.isArray(updateData.path) && updateData.path.length > 0
            ? updateData.path[updateData.path.length - 1]
            : null;
        const endpointCompare: EndpointDiagnostics = {
          responsePathLast,
          pathEndpoint: updateData.pathEndpoint ?? null,
          routeGoalPoint: updateData.routeGoalPoint ?? null,
          targetGpsPoint: updateData.targetGpsPoint ?? null,
          preEnforcementEndpointDistanceM: updateData.preEnforcementEndpointDistanceM ?? null,
          finalEndpointDistanceM: updateData.finalEndpointDistanceM ?? null,
          endpointTrimmed: updateData.endpointTrimmed ?? null,
          endpointExtended: updateData.endpointExtended ?? null,
          endpointEnforced: updateData.endpointEnforced ?? null,
          routeVersion: routeVersionRef.current,
        };
        setEndpointDiagnostics(endpointCompare);

        // ── Backend terminal state: ARRIVED may intentionally carry path:[] ─────
        // Handle it before the route guard so arrival does not require renderable geometry.
        if (isBackendArrivedResponse(updateData)) {
          markArrived();
          return;
        }

        // ── Invariant guard (shared) ──────────────────────────────────────────
        if (!canApplyRoutePath(updateData.path, updateData.status, updateData.success)) {
          const nonFatalReason =
            updateData.status === 'NO_ROUTE'
              ? updateData.refetchReason ?? updateData.lastMetric?.refetchReason ?? 'no_route'
              : 'invalid_incoming_path';
          console.warn('[NAV] ROUTE_APPLY_BLOCKED_INVALID_RESPONSE', {
            seq, source: 'polling',
            status: updateData.status, success: updateData.success,
            pathLen: updateData.path?.length ?? 0,
            refetchReason: updateData.refetchReason ?? updateData.lastMetric?.refetchReason ?? null,
          });
          if (
            updateData.status === 'NO_ROUTE' ||
            isSnapAmbiguityResponse(updateData)
          ) {
            const nextRouteUxState: RouteUxState = isSnapAmbiguityResponse(updateData)
              ? 'recalculating'
              : 'routeTemporarilyUnavailable';
            setRouteUxState(nextRouteUxState);
          }
          return;
        }

        // ── Apply ────────────────────────────────────────────────────────────
        const updateMeta = updateData as any;
        latestAppliedSeqRef.current = seq;

        // ── Smart route apply decision ────────────────────────────────────────
        // Decision order (important — mapboxApiCalled must come BEFORE duplicate check):
        //  1. First route (no prior state) → apply + increment
        //  2. mapboxApiCalled=true OR refetchReason → force new body (skip duplicate check)
        //  3. incomingFull === prevFull → exact duplicate → skip
        //  4. incomingBody === prevBody → tail-only trim → setPath only
        //  5. else → new body geometry → setPath + increment
        const incomingPath     = updateData.path.map((p) => ({ lat: p.lat, lng: p.lng }));
        setManeuverRoute(createManeuverRouteSnapshot(incomingPath, updateData.maneuvers));
        const incomingFull     = computeRouteFullSignature(incomingPath);
        const incomingBody     = computeRouteBodySignature(incomingPath);
        const incomingTail     = computeRouteTailSignature(incomingPath);
        const prevFull         = lastAppliedFullSigRef.current;
        const prevBody         = lastAppliedBodySigRef.current;
        const prevTail         = lastAppliedTailSigRef.current;
        const mapboxCalledNow  = updateMeta.lastMetric?.mapboxApiCalled === true;
        const refetchReasonNow = updateMeta.lastMetric?.refetchReason ?? updateMeta.refetchReason ?? null;

        if (prevFull === null) {
          // Branch 1: First polling response for this session → always apply
          setPath(incomingPath);
          setRouteCandidateProvenance(updateData.routeProvenance ?? null);
          incrementRouteVersion();
          incrementRouteSourceKey();
          lastAppliedFullSigRef.current = incomingFull;
          lastAppliedBodySigRef.current = incomingBody;
          lastAppliedTailSigRef.current = incomingTail;
        } else if (mapboxCalledNow || refetchReasonNow != null) {
          // Branch 2: Mapbox API was called or explicit refetch — always new geometry.
          // Must come BEFORE duplicate check: a refetch could return same coords as
          // the previous path yet still require a Source remount (new tile data, etc.).
          setPath(incomingPath);
          setRouteCandidateProvenance(updateData.routeProvenance ?? null);
          incrementRouteVersion();
          incrementRouteSourceKey();
          lastAppliedFullSigRef.current = incomingFull;
          lastAppliedBodySigRef.current = incomingBody;
          lastAppliedTailSigRef.current = incomingTail;
        } else if (incomingFull === prevFull) {
          // Branch 3: Exact duplicate — skip apply entirely (no setPath, no increment)
        } else if (prevBody !== null && incomingBody === prevBody) {
          // Branch 4: Same endpoint — could be agent-side trim OR MT-D* mid-route change.
          // tailSignature (path[1..n]) distinguishes the two cases:
          //   tail unchanged → only path[0] moved (agent trim) → keep Source locked, no routeVersion increment
          //   tail changed   → MT-D* replanned mid-route geometry → increment routeVersion to force Source update
          const tailChanged = prevTail !== null && incomingTail !== prevTail;
          setPath(incomingPath);
          setRouteCandidateProvenance(updateData.routeProvenance ?? null);
          lastAppliedFullSigRef.current = incomingFull;
          lastAppliedTailSigRef.current = incomingTail;
          // prevBody stays the same — endpoint is unchanged
          if (tailChanged) {
            incrementRouteVersion();
            // Source key NOT incremented — MT-D* incremental replan must NOT remount Source
          } else {
          }
        } else {
          // Branch 5: Route body changed without Mapbox API call (MT-D* replanned on its own)
          // Source key NOT incremented — setData on existing Source is sufficient
          setPath(incomingPath);
          setRouteCandidateProvenance(updateData.routeProvenance ?? null);
          incrementRouteVersion();
          lastAppliedFullSigRef.current = incomingFull;
          lastAppliedBodySigRef.current = incomingBody;
          lastAppliedTailSigRef.current = incomingTail;
        }

        {
        }

        setDistance(updateData.totalCost || 0);
        setEta(updateData.estimatedTimeSeconds || 0);
        setRouteUxState('navigating');


        if (updateData.suggestedPollIntervalMs) {
          setPollMs(updateData.suggestedPollIntervalMs);
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          return;
        }
        console.error('[NAV] Polling error', { seq, sessionId, durationMs: Date.now() - startedAt, err });
        setRouteUxState('routeTemporarilyUnavailable');
      } finally {
        isUpdateInFlightRef.current = false;
      }
    }, pollMs);

    // Cleanup เมื่อ unmount หรือ status เปลี่ยน — abort any in-flight request
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      isUpdateInFlightRef.current = false;
    };
  }, [status, sessionId, pollMs, navService, start, markArrived]);

  return (
    <NavigationContext.Provider value={{
      path,
      maneuvers: maneuverRoute?.maneuvers ?? EMPTY_MANEUVERS,
      maneuverRoute,
      status,
      routeUxState,
      sessionId,
      start,
      stop,
      markArrived,
      clearNavigationSession,
      eta,
      distance,
      corridorNodeCount,
      updatePositions,
      routeVersion,
      routeSourceKey,
      endpointDiagnostics,
      restoreChecked,
      freshStartSequence,
      routeCandidateProvenance,
    }}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
}
