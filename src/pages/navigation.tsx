"use client";

/* eslint-disable @next/next/no-img-element */

import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from "react";
import Map, { Marker, Source, Layer, MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { ArrowUp, Compass, CornerUpLeft, CornerUpRight, MoveUpLeft, MoveUpRight, Undo2, Volume2, VolumeX, Navigation as NavIcon } from "lucide-react";
import { useRouter } from "next/router";
import { AdaptivePollingService } from "@/services/pollingService";
import { NavigationProvider, useNavigation } from "@/hooks/useNavigation";
import type { TargetReference } from "@/hooks/useNavigation";
import ResearchLogPanel from "@/components/research/ResearchLogPanel";
import {
    appendResearchProvenanceEvent,
    getResearchLoggerSnapshot,
    subscribeResearchLogger,
} from "@/lib/research/provenanceEvents";
import {
    resolveNavigationTopBarPresentation,
    resolveRouteUxBanner,
    useNavigationGuidance,
} from "@/hooks/useNavigationGuidance";
import { useNavigationVoice } from "@/hooks/useNavigationVoice";
import TopNavigationBanner from "@/components/TopNavigationBanner";
import CustomCompass from "@/components/CustomCompass";
import { MotionState, createInitialMotionState } from "@/lib/motion/MotionState";
import { evaluatePresentationTransactionIntegration } from "@/lib/presentation/presentationTransactionIntegration";
import type {
    PresentationTransactionIntegrationDependencies,
    ReadCurrentSourceOwnershipDependency,
    StageStrictTrimMutationDependency,
    CommitFrontendOwnershipDependency,
} from "@/lib/presentation/presentationTransactionIntegration";
import { executeStrictTrimMutation } from "@/lib/presentation/trimTransactionRuntime";
import type { TrimPaintMapAdapter } from "@/lib/presentation/trimTransactionRuntime";
import { createPresentationTransactionGateSnapshot } from "@/lib/presentation/transactionRuntimeModel";
import { decideProductionWiringAction } from "@/lib/presentation/presentationTransactionProductionPolicy";
import { isFieldTestSwitchEnabled } from "@/lib/presentation/presentationTransactionControlledEnablement";
import { hasRouteTrimGeometryBasisChanged, shouldApplyRouteTrimPaint } from "@/lib/presentation/routeTrimRebaseModel";
import { clipRoutePathAtProjection, shouldCommitFreshProjection } from "@/lib/presentation/routeDisplayClipModel";
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
// PR2a-1C-B2: build capability for the FUTURE route/trim transaction. Build-time
// value substitution only — Next.js replaces this with a literal at build time,
// so it is identical on server and client (no hydration timing) and is never
// re-read at runtime. Default is false whenever the env var is unset.
// No transaction exists yet: with the flag ON, the wrapper still publishes
// through applySourcePathLegacy via a temporary safety stub, so navigation
// behavior is equivalent regardless of this value.
const TRANSACTION_GATE_COMPILED = process.env.NEXT_PUBLIC_PRESENTATION_TRANSACTION_BUILD === "true";
// PR2a-1C-C4-B: Compiled Deployment Field-Test Switch. Evaluated at build
// time only (same NEXT_PUBLIC_* substitution as TRANSACTION_GATE_COMPILED
// above) — never runtime-toggleable, no query-string/localStorage path
// reads it. Changing this value requires a rebuild + redeploy, and an
// already-loaded client must reload to observe the new value. Default is
// false whenever the env var is unset, independent of TRANSACTION_GATE_COMPILED.
const FIELD_TEST_SWITCH_COMPILED = isFieldTestSwitchEnabled(process.env.NEXT_PUBLIC_PRESENTATION_FIELD_TEST_ENABLED);
type NavigationQueryIdentity = {
    usersId: number;
    takecareId: number;
    idlocation: string | null;
    auToken: string | null;
};

type NavigationQueryResult =
    | {
        ok: true;
        value: NavigationQueryIdentity;
    }
    | {
        ok: false;
        error: string;
    };

const NAVIGATION_QUERY_ERROR = 'ข้อมูลผู้ใช้งานสำหรับการนำทางไม่ถูกต้อง';

function parseNavigationQuery(
    query: Record<string, string | string[] | undefined>,
): NavigationQueryResult {
    const usersIdParam = query.users_id;
    const takecareIdParam = query.takecare_id;
    const idlocationParam = query.idlocation;
    const auTokenParam = query.auToken;

    if (typeof usersIdParam !== 'string' || typeof takecareIdParam !== 'string') {
        return { ok: false, error: NAVIGATION_QUERY_ERROR };
    }

    if (
        (idlocationParam !== undefined && typeof idlocationParam !== 'string') ||
        (auTokenParam !== undefined && typeof auTokenParam !== 'string')
    ) {
        return { ok: false, error: NAVIGATION_QUERY_ERROR };
    }

    const usersId = Number(usersIdParam);
    const takecareId = Number(takecareIdParam);

    if (
        !Number.isInteger(usersId) ||
        usersId <= 0 ||
        !Number.isInteger(takecareId) ||
        takecareId <= 0
    ) {
        return { ok: false, error: NAVIGATION_QUERY_ERROR };
    }

    return {
        ok: true,
        value: {
            usersId,
            takecareId,
            idlocation: idlocationParam ?? null,
            auToken: auTokenParam ?? null,
        },
    };
}

const NAV_FOLLOW_PITCH = 65;
const NAV_FOLLOW_ZOOM = 18;
const TOP_DOWN_ZOOM = 16;
const LOOK_AHEAD_M = 120;                    // camera center offset ahead of agent (m) — larger = marker lower on screen
const CAMERA_NAV_BOTTOM_PAD_PX = 300;         // Mapbox viewport bottom padding in navigation_follow (px) — shifts camera center up
const CAMERA_BEARING_DEAD_ZONE_DEG      = 6;   // ignore bearing deltas smaller than this (°)
const CAMERA_BEARING_EASE_MS            = 500; // smooth rotation duration (ms)
const CAMERA_TURN_SMOOTH_TIME_MS        = 300; // dt-based route-up camera turn smoothing time constant (ms) — M1: aligned with marker (was 550)
const CAMERA_TURN_DEAD_ZONE_DEG         = 0.75; // keep route-up camera bearing stable for tiny target deltas (°)
const USER_GESTURE_MOVE_THRESHOLD_PX      = 10; // touchmove distance before user camera override activates
const AGENT_PROJECTION_MAX_DIST_M           = 50;  // snap agent marker to route only when within this distance (m)
const AGENT_PROJECTION_RECOVERY_DIST_M      = 30;  // hysteresis guard: keep previous segment when still within this distance
const AGENT_PROJECTION_SWITCH_MARGIN_M      = 5;   // require a clear improvement before switching to a distant segment
const AGENT_PROJECTION_BACKTRACK_LIMIT      = 1;   // allow small GPS correction, but block large visual backtracking
const AGENT_PROJECTION_WINDOW_BACK          = 3;
const AGENT_PROJECTION_WINDOW_FORWARD       = 8;
const PROJECTION_POOR_FIT_DIST_M            = 20;  // poor-fit threshold — starts staged recovery counter
const PROJECTION_FORCE_FULL_SCAN_DIST_M     = 35;  // immediate full scan when projection distance exceeds this
const PROJECTION_POOR_FIT_MAX_COUNT         = 3;   // consecutive poor-fit frames before forced full scan
const MAX_BACKTRACK_M                       = 2.0; // max allowed same-segment backtrack in meters (replaces 0.02 fraction)
const DISPLAY_AGENT_MIN_MOVE_M              = 0.75; // 0.75m reduces visual lag; still blocks sub-meter GPS noise
const VISUAL_AGENT_SNAP_EPSILON_M           = 0.2;  // snap visual position to target when already this close
const VISUAL_AGENT_FAST_CATCHUP_DIST_M      = 25;   // snap immediately when visual is too far behind target
const VISUAL_AGENT_SMOOTH_TIME_MS           = 150;  // exponential smoothing time constant (ms) for dt-based visual lerp
const VISUAL_AGENT_MAX_SPEED_MPS            = 45;   // max marker movement speed (m/s ≈ 162 km/h) — supports highway/emergency driving up to ~120 km/h with GPS jitter buffer; prevents speed cap from bottlenecking real vehicle speed
const ROUTE_TAIL_ANCHOR_UPDATE_INTERVAL_MS  = 125;  // max 8fps route source updates — avoids flicker from rAF setData churn
const ROUTE_TAIL_ANCHOR_MIN_MOVE_M          = 0.75; // update route tail only after meaningful visual-anchor movement
const ROUTE_TAIL_ANCHOR_MAX_PROJECTION_DIST_M = 12; // visual anchor must project close to route geometry
const ROUTE_TRIM_PAINT_INTERVAL_MS          = 100;  // style-only trim updates; does not mutate GeoJSON Source data
const ROUTE_TRIM_MIN_ADVANCE_M              = 2;    // repaint trim after meaningful meter progress; works on long routes
const ROUTE_TRIM_MIN_PROGRESS_DELTA         = 0.00001; // fallback only — distance threshold is primary for long routes
const ROUTE_TRIM_MAX_PROJECTION_DIST_M      = 12;   // marker must project close to stable route source before trim advances
const ROUTE_SOURCE_ENDPOINT_MOVE_M          = 1.0;  // endpoint/body changes apply immediately above this threshold
const MIN_ROUTE_PRESENTATION_PTS            = 5;    // F2: hold visual route if incoming path has fewer pts during active nav
const ROUTE_SHRINK_HOLD_RATIO               = 0.30; // F2: hold if incoming pts < 30% of current visible pts (abrupt shrink)
const WRONG_WAY_MOVEMENT_MIN_M              = 1.25; // movement vector must be meaningful before wrong-way check
const WRONG_WAY_SPEED_MIN_MPS               = 0.8;  // GPS speed can qualify movement when available
const WRONG_WAY_DETECT_DELTA_DEG            = 120;  // movement points mostly opposite route
const WRONG_WAY_CLEAR_DELTA_DEG             = 80;   // hysteresis clear when movement aligns again
const WRONG_WAY_TICKS_REQUIRED              = 2;    // consecutive checks before toggling wrong-way state
const MARKER_BEARING_DEAD_ZONE_DEG     = 3;   // keep marker arrow stable for small tangent changes
const MOVEMENT_DISTANCE_THRESHOLD_M   = 15;  // distance fallback threshold — high enough to survive GPS cold-start jump
const MOVEMENT_ACCURACY_MAX_M         = 30;  // skip GPS samples with accuracy worse than this (m)
const MOVEMENT_CONSECUTIVE_REQUIRED   = 2;   // require N consecutive distance ticks before confirming movement
const CAMERA_CENTER_SMOOTH_TIME_MS    = 150; // exponential smoothing time constant for camera center (ms) — M3-D1: tightened from 250ms to reduce center lag during turns
const CAMERA_CENTER_EPSILON_M         = 0.3; // snap camera to target when already this close (m)
const CAMERA_CENTER_SNAP_DIST_M       = 50;  // snap immediately on large jump — avoids lag after route reset (m)
const CAMERA_CENTER_THROTTLE_EASE_MS  = 150; // max rate of center-only jumpTo during bearing easeTo (ms)
const PATIENT_MARKER_DEAD_ZONE_M      = 4;
// M1.5R: velocity integrator constants
// (INTEGRATOR_VELOCITY_SMOOTH_MS removed M1.5R-D — replaced by accel/decel clamp)
const INTEGRATOR_DECEL_WINDOW_SEC          = 0.3;  // slow down when < 0.3s from target at current speed
const INTEGRATOR_EPSILON_M                 = 0.15; // snap to target when this close (m)
const INTEGRATOR_STOP_SPEED_MPS            = 0.3;  // GPS speed below which agent is stationary
const INTEGRATOR_STALE_GPS_SEC             = 2.0;  // no GPS for this long → decelerate to stop
const INTEGRATOR_EXPECTED_GPS_INTERVAL_SEC = 1.0;  // ~1Hz GPS for speed estimation fallback
const INTEGRATOR_MAX_SPEED_MPS             = VISUAL_AGENT_MAX_SPEED_MPS;
// M1.5R-D1: motion dynamics refinement (accel clamp + heading dynamics + cruise stability)
const INTEGRATOR_MAX_ACCEL_MPS2        = 5.0;   // max acceleration (m/s²)
const INTEGRATOR_MAX_DECEL_MPS2        = 8.0;   // max deceleration (m/s²)
const INTEGRATOR_MAX_ANGULAR_VEL_DEG_S = 80.0;  // max heading rotation rate (°/s)
const INTEGRATOR_CRUISE_HYSTERESIS_MPS = 0.3;   // velocity band for cruise stability
// M1.5R-D2: turn dynamics diagnostics
const INTEGRATOR_TURN_LOOKAHEAD_M = 5.0;         // route lookahead for upcoming heading-delta sample (m)
const INTEGRATOR_TURN_DETECT_DEG  = 10.0;        // heading delta threshold to declare TURNING
const PATIENT_MARKER_INTERP_ALPHA     = 0.2;
const PATIENT_MARKER_MAX_JUMP_M       = 25;
const MARKER_BEARING_VISUAL_DEAD_ZONE_DEG = 1.5; // skip lerp when visual-to-target gap is tiny (°)
const MARKER_BEARING_SMOOTH_TIME_MS       = 300;  // time constant for visual marker bearing lerp (ms) — M1: aligned with camera (was 220)
const SOFT_FOLLOW_DURATION_MS = 2500; // ramp duration from current camera state to full navigation_follow (ms)
const NAV_ARRIVAL_NEAR_THRESHOLD_M = 50;
const NAV_ARRIVAL_REACHED_THRESHOLD_M = 5;
const LAST_MILE_LABEL_THRESHOLD_M = 20;
const ROUTE_BODY_LOCK_MIN_VISIBLE_PTS  = 8;   // F3: minimum stable visible pts to engage body lock
const ROUTE_BODY_LOCK_ENDPOINT_DELTA_M = 10;  // F3: endpoint move > this releases body lock (m)

type LatLngPoint = { lat: number; lng: number };

// PR2a-1C-B2: the only three same-identity accepted route-update reasons that
// may go through the transaction gate wrapper. Deliberately narrower than
// applySourcePathLegacy's `reason: string` so 'initial_seed' and the Mapbox
// replacement path cannot be passed to the wrapper even by mistake.
type PresentationTransactionEligibleReason =
    | 'route_version_changed'
    | 'route_endpoint_changed'
    | 'route_body_changed';

// F2: Route Presentation Guard — decides whether to update the visual route or hold the previous one
function shouldApplyPresentationPath(p: {
    status: string;
    incomingPathLength: number;
    currentVisiblePathLength: number;
    isIdentityChange: boolean;
}): { apply: boolean; reason: string } {
    // Identity change (Mapbox refetch / first route) — always apply regardless of length
    if (p.isIdentityChange) return { apply: true, reason: 'identity_change' };
    // Navigation ended — allow any path length
    if (p.status === 'idle' || p.status === 'arrived') return { apply: true, reason: 'nav_ended' };
    if (p.status === 'active') {
        // Guard 1: incoming path too short
        if (p.incomingPathLength < MIN_ROUTE_PRESENTATION_PTS
            && p.currentVisiblePathLength >= MIN_ROUTE_PRESENTATION_PTS) {
            return { apply: false, reason: 'short_path_held' };
        }
        // Guard 2: abrupt shrink — incoming is < 30% of visible and both above threshold
        if (p.currentVisiblePathLength >= 8
            && p.incomingPathLength < Math.round(p.currentVisiblePathLength * ROUTE_SHRINK_HOLD_RATIO)) {
            return { apply: false, reason: 'abrupt_shrink_held' };
        }
    }
    return { apply: true, reason: 'apply_normal' };
}

// F3: Route Body Lock — holds stable visual route body during static-target MT-D* incremental updates.
// Prevents visual route from shrinking (15→13→12→11...) when the target is not moving.
function shouldHoldRouteBodyLock(p: {
    status: string;
    isIdentityChange: boolean;
    currentVisiblePathLength: number;
    incomingPathLength: number;
    endpointDeltaM: number;
}): { hold: boolean; reason: string } {
    if (p.status !== 'active') return { hold: false, reason: 'not_active' };
    if (p.isIdentityChange) return { hold: false, reason: 'identity_change' };
    if (p.currentVisiblePathLength < ROUTE_BODY_LOCK_MIN_VISIBLE_PTS)
        return { hold: false, reason: 'visible_too_short' };
    if (p.incomingPathLength >= p.currentVisiblePathLength)
        return { hold: false, reason: 'incoming_not_shrinking' };
    if (p.incomingPathLength < MIN_ROUTE_PRESENTATION_PTS)
        return { hold: false, reason: 'f2_handles_short' };
    if (p.endpointDeltaM > ROUTE_BODY_LOCK_ENDPOINT_DELTA_M)
        return { hold: false, reason: 'endpoint_moved' };
    return { hold: true, reason: 'static_target_body_lock' };
}

function toRad(deg: number): number {
    return deg * Math.PI / 180;
}

function toDeg(rad: number): number {
    return rad * 180 / Math.PI;
}

function normalizeBearing(deg: number): number {
    return ((deg % 360) + 360) % 360;
}

function shortestBearingDelta(from: number, to: number): number {
    let delta = normalizeBearing(to) - normalizeBearing(from);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
}

function distanceMeters(a: LatLngPoint, b: LatLngPoint): number {
    const cosLat = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const LAT_M = 111320;
    const LNG_M = LAT_M * cosLat;
    const dlat = (a.lat - b.lat) * LAT_M;
    const dlng = (a.lng - b.lng) * LNG_M;
    return Math.sqrt(dlat * dlat + dlng * dlng);
}

// Bearing from one GPS point to another (0° = north, clockwise)
function bearingBetween(from: LatLngPoint, to: LatLngPoint): number {
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat   * Math.PI / 180;
    const dLng = (to.lng - from.lng) * Math.PI / 180;
    const x = Math.sin(dLng) * Math.cos(lat2);
    const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return normalizeBearing(Math.atan2(x, y) * 180 / Math.PI);
}

// M1.5R-B: compute arc-length progress (m) from route start to a projected point
function computeRouteProgressFromProjection(
    segmentIndex: number,
    t: number,
    routePath: LatLngPoint[],
): number {
    let dist = 0;
    const lastSeg = Math.min(segmentIndex, routePath.length - 2);
    for (let i = 0; i < lastSeg; i++) {
        dist += distanceMeters(routePath[i], routePath[i + 1]);
    }
    if (lastSeg >= 0 && lastSeg < routePath.length - 1) {
        dist += distanceMeters(routePath[lastSeg], routePath[lastSeg + 1]) * Math.max(0, Math.min(1, t));
    }
    return dist;
}

// M1.5R-B: sample position + route tangent bearing at a given arc distance along route polyline
function sampleRouteAtDistance(
    routePath: LatLngPoint[],
    distanceM: number,
): { position: LatLngPoint; bearing: number; segmentIndex: number } | null {
    if (routePath.length < 2) return null;
    let remaining = Math.max(0, distanceM);
    for (let i = 0; i < routePath.length - 1; i++) {
        const segLen = distanceMeters(routePath[i], routePath[i + 1]);
        if (segLen <= 0) continue;
        const isLast = i === routePath.length - 2;
        if (remaining <= segLen || isLast) {
            const t = segLen > 0 ? Math.min(1, remaining / segLen) : 0;
            const position: LatLngPoint = {
                lat: routePath[i].lat + t * (routePath[i + 1].lat - routePath[i].lat),
                lng: routePath[i].lng + t * (routePath[i + 1].lng - routePath[i].lng),
            };
            const bearing = bearingBetween(routePath[i], routePath[i + 1]);
            return { position, bearing, segmentIndex: i };
        }
        remaining -= segLen;
    }
    return null;
}

function computeRouteSourceSignature(routePath: LatLngPoint[]): string {
    if (routePath.length < 2) return 'empty';
    let hash = 2166136261;
    const fnv = (value: number) => {
        hash ^= value;
        hash = Math.imul(hash, 16777619) >>> 0;
    };
    for (const point of routePath) {
        fnv(Math.round(point.lat * 1e6));
        fnv(Math.round(point.lng * 1e6));
    }
    const first = routePath[0];
    const last = routePath[routePath.length - 1];
    return `${routePath.length}:${hash.toString(16)}:${first.lat.toFixed(6)},${first.lng.toFixed(6)}:${last.lat.toFixed(6)},${last.lng.toFixed(6)}`;
}

function computeRouteSourceBodySignature(routePath: LatLngPoint[]): string {
    if (routePath.length < 2) return 'empty';
    const last = routePath[routePath.length - 1];
    return `endpoint:${Math.round(last.lat * 1e6)},${Math.round(last.lng * 1e6)}`;
}

function computeLookAheadCenter(agentPos: LatLngPoint, bearingDeg: number, lookAheadM: number): LatLngPoint {
    const earthRadiusM = 6371000;
    const angularDistance = lookAheadM / earthRadiusM;
    const bearing = toRad(normalizeBearing(bearingDeg));
    const lat1 = toRad(agentPos.lat);
    const lng1 = toRad(agentPos.lng);

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance)
        + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const lng2 = lng1 + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

    return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

function computeBearingBetween(from: LatLngPoint, to: LatLngPoint): number {
    const lat1 = toRad(from.lat);
    const lat2 = toRad(to.lat);
    const deltaLng = toRad(to.lng - from.lng);
    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2)
        - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    return normalizeBearing(toDeg(Math.atan2(y, x)));
}

type MarkerBearingSource = 'gps' | 'route_tangent' | 'movement_bearing' | 'wrong_way_movement_bearing' | 'fallback';
type RouteUpBearingSource = 'locked_projection_segment' | 'rendered_route_tangent' | 'path_start_tangent' | 'wrong_way_movement_bearing' | 'gps' | 'fallback' | 'integrator';
type StableMarkerBearingInfo = {
    bearing: number;
    source: MarkerBearingSource;
    segmentIndex: number | null;
    rawBearing: number;
    delta: number;
    skippedSmallDelta: boolean;
};

// Route tangent is PRIMARY — keeps marker aligned with road geometry at all times.
// GPS heading is fallback when no route is available.
function computeMarkerBearing(
    hasGps: boolean,
    gpsH: number,
    routePath: LatLngPoint[],
    mapH: number,
): { bearing: number; source: MarkerBearingSource } {
    if (routePath.length >= 2) {
        return { bearing: computeBearingBetween(routePath[0], routePath[1]), source: 'route_tangent' };
    }
    if (hasGps && Number.isFinite(gpsH)) {
        return { bearing: gpsH, source: 'gps' };
    }
    return { bearing: mapH, source: 'fallback' };
}

type RouteProjection = {
    projectedPoint: LatLngPoint;
    segmentIndex: number;
    distanceM: number;
    t: number;
};

type StableProjectionSource =
    | 'initial_full_scan'
    | 'window_scan'
    | 'full_scan_recovery'
    | 'hysteresis_keep_previous'
    | 'fallback_raw';

type BacktrackClampDiag = {
    originalT: number;
    clampedT: number;
    maxBacktrackM: number;
    segmentLengthM: number;
};

type PendingTouchGesture = {
    active: boolean;
    startX: number;
    startY: number;
    startTime: number;
    touchCount: number;
};

type StableRouteProjection = RouteProjection & {
    source: StableProjectionSource;
    changedSegment: boolean;
    backtrackClamped?: BacktrackClampDiag;
};

type ProjectionLock = StableRouteProjection & {
    routeVersion: number;
    routePathLen: number;
    lastUpdatedAt: number;
};

type RouteTailAnchor = {
    point: LatLngPoint;
    segmentIndex: number;
    routeVersion: number;
    routePathLen: number;
    updatedAt: number;
    source: 'visual_projection';
};

type RouteTrimProgress = {
    progress: number;
    distanceAlongRouteM: number;
    distanceM: number;
    segmentIndex: number;
    projectedPoint: LatLngPoint;
    totalLengthM: number;
};

// Project a geographic point onto the nearest segment of a route polyline.
// Uses meter-space projection at the agent's latitude to avoid degree-space distortion.
// Returns null if routePath has fewer than 2 points.
function projectPointToRoute(point: LatLngPoint, routePath: LatLngPoint[]): RouteProjection | null {
    return projectPointToRouteRange(point, routePath, 0, routePath.length - 2);
}

function projectPointToRouteRange(
    point: LatLngPoint,
    routePath: LatLngPoint[],
    startSegmentIndex: number,
    endSegmentIndex: number,
): RouteProjection | null {
    if (routePath.length < 2) return null;

    const lastSegmentIndex = routePath.length - 2;
    const start = Math.max(0, Math.min(startSegmentIndex, lastSegmentIndex));
    const end = Math.max(start, Math.min(endSegmentIndex, lastSegmentIndex));

    const cosLat = Math.cos(point.lat * Math.PI / 180);
    const LAT_M  = 111320;
    const LNG_M  = LAT_M * cosLat;

    let bestSegIdx = 0;
    let bestT      = 0;
    let bestDist   = Infinity;

    for (let i = start; i <= end; i++) {
        const ax = routePath[i].lng * LNG_M,      ay = routePath[i].lat * LAT_M;
        const bx = routePath[i + 1].lng * LNG_M,  by = routePath[i + 1].lat * LAT_M;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;

        const t = lenSq === 0 ? 0
            : Math.max(0, Math.min(1, ((point.lng * LNG_M - ax) * dx + (point.lat * LAT_M - ay) * dy) / lenSq));

        const projLat = routePath[i].lat + t * (routePath[i + 1].lat - routePath[i].lat);
        const projLng = routePath[i].lng + t * (routePath[i + 1].lng - routePath[i].lng);
        const dlat = (point.lat - projLat) * LAT_M;
        const dlng = (point.lng - projLng) * LNG_M;
        const dist = Math.sqrt(dlat * dlat + dlng * dlng);

        if (dist < bestDist) {
            bestDist   = dist;
            bestSegIdx = i;
            bestT      = t;
        }
    }

    const a = routePath[bestSegIdx];
    const b = routePath[bestSegIdx + 1];
    const projectedPoint: LatLngPoint = {
        lat: a.lat + bestT * (b.lat - a.lat),
        lng: a.lng + bestT * (b.lng - a.lng),
    };
    return { projectedPoint, segmentIndex: bestSegIdx, distanceM: bestDist, t: bestT };
}

function computeRouteTrimProgress(
    point: LatLngPoint,
    routePath: LatLngPoint[],
    maxProjectionDistanceM: number,
): RouteTrimProgress | null {
    if (routePath.length < 2) return null;

    const projection = projectPointToRoute(point, routePath);
    if (!projection || projection.distanceM > maxProjectionDistanceM) return null;

    let totalLengthM = 0;
    let distanceBeforeSegmentM = 0;
    let projectedSegmentLengthM = 0;

    for (let i = 0; i < routePath.length - 1; i++) {
        const segmentLengthM = distanceMeters(routePath[i], routePath[i + 1]);
        if (!Number.isFinite(segmentLengthM) || segmentLengthM <= 0) continue;
        if (i < projection.segmentIndex) {
            distanceBeforeSegmentM += segmentLengthM;
        }
        if (i === projection.segmentIndex) {
            projectedSegmentLengthM = segmentLengthM;
        }
        totalLengthM += segmentLengthM;
    }

    if (!Number.isFinite(totalLengthM) || totalLengthM <= 0) return null;

    const distanceAlongRouteM = distanceBeforeSegmentM + projectedSegmentLengthM * projection.t;
    const progress = Math.max(0, Math.min(0.995, distanceAlongRouteM / totalLengthM));

    return {
        progress,
        distanceAlongRouteM,
        distanceM: projection.distanceM,
        segmentIndex: projection.segmentIndex,
        projectedPoint: projection.projectedPoint,
        totalLengthM,
    };
}

function withProjectionSource(
    proj: RouteProjection,
    previous: ProjectionLock | null,
    source: StableProjectionSource,
    backtrackClamped?: BacktrackClampDiag,
): StableRouteProjection {
    return {
        ...proj,
        source,
        changedSegment: previous ? proj.segmentIndex !== previous.segmentIndex : true,
        backtrackClamped,
    };
}

function projectPointToRouteStable(
    point: LatLngPoint,
    routePath: LatLngPoint[],
    previous: ProjectionLock | null,
    routeVersion: number,
): StableRouteProjection | null {
    if (routePath.length < 2) return null;

    const routeChanged = !previous
        || previous.routeVersion !== routeVersion
        || previous.routePathLen !== routePath.length;

    if (routeChanged) {
        const initial = projectPointToRoute(point, routePath);
        return initial ? withProjectionSource(initial, previous, 'initial_full_scan') : null;
    }

    const lastSegmentIndex = routePath.length - 2;
    const prevSegment = Math.min(Math.max(previous.segmentIndex, 0), lastSegmentIndex);
    const windowStart = Math.max(0, prevSegment - AGENT_PROJECTION_WINDOW_BACK);
    const windowEnd = Math.min(lastSegmentIndex, prevSegment + AGENT_PROJECTION_WINDOW_FORWARD);
    const windowCandidate = projectPointToRouteRange(point, routePath, windowStart, windowEnd);
    const previousSegmentCandidate = projectPointToRouteRange(point, routePath, prevSegment, prevSegment);

    if (!windowCandidate) {
        const recovered = projectPointToRoute(point, routePath);
        return recovered ? withProjectionSource(recovered, previous, 'full_scan_recovery') : null;
    }

    let candidate = windowCandidate;
    let source: StableProjectionSource = 'window_scan';
    let backtrackClampedDiag: BacktrackClampDiag | undefined;

    const isLargeBackwardJump = candidate.segmentIndex < previous.segmentIndex - AGENT_PROJECTION_BACKTRACK_LIMIT;
    if (isLargeBackwardJump && previousSegmentCandidate && previousSegmentCandidate.distanceM <= AGENT_PROJECTION_RECOVERY_DIST_M) {
        candidate = previousSegmentCandidate;
        source = 'hysteresis_keep_previous';
    }

    const isSameSegmentBacktrack = candidate.segmentIndex === previous.segmentIndex && candidate.t < previous.t - 0.05;
    if (isSameSegmentBacktrack && previousSegmentCandidate && previousSegmentCandidate.distanceM <= AGENT_PROJECTION_RECOVERY_DIST_M) {
        const a = routePath[previous.segmentIndex];
        const b = routePath[previous.segmentIndex + 1];
        // Compute segment length in meters to convert MAX_BACKTRACK_M into a t-fraction.
        // Guard against zero-length segments to avoid division by zero.
        const cosLat = Math.cos(point.lat * Math.PI / 180);
        const segLenM = Math.sqrt(
            Math.pow((b.lat - a.lat) * 111320, 2) +
            Math.pow((b.lng - a.lng) * 111320 * cosLat, 2),
        );
        const maxBacktrackT = segLenM > 0.5 ? MAX_BACKTRACK_M / segLenM : MAX_BACKTRACK_M;
        const originalT = candidate.t;
        const lockedT = Math.max(candidate.t, previous.t - maxBacktrackT);
        if (lockedT > originalT) {
            backtrackClampedDiag = { originalT, clampedT: lockedT, maxBacktrackM: MAX_BACKTRACK_M, segmentLengthM: segLenM };
        }
        candidate = {
            projectedPoint: {
                lat: a.lat + lockedT * (b.lat - a.lat),
                lng: a.lng + lockedT * (b.lng - a.lng),
            },
            segmentIndex: previous.segmentIndex,
            distanceM: previousSegmentCandidate.distanceM,
            t: lockedT,
        };
        source = 'hysteresis_keep_previous';
    }

    if (candidate.distanceM > AGENT_PROJECTION_RECOVERY_DIST_M) {
        const fullScan = projectPointToRoute(point, routePath);
        if (fullScan) {
            const isForwardWindow = fullScan.segmentIndex > previous.segmentIndex
                && fullScan.segmentIndex <= previous.segmentIndex + AGENT_PROJECTION_WINDOW_FORWARD;
            const isClearlyBetter = fullScan.distanceM + AGENT_PROJECTION_SWITCH_MARGIN_M < candidate.distanceM;
            const isLockedVeryBad = candidate.distanceM > AGENT_PROJECTION_RECOVERY_DIST_M;

            if (isForwardWindow || isClearlyBetter || isLockedVeryBad) {
                candidate = fullScan;
                source = 'full_scan_recovery';
                backtrackClampedDiag = undefined; // full scan supersedes backtrack clamp
            } else if (previousSegmentCandidate) {
                candidate = previousSegmentCandidate;
                source = 'hysteresis_keep_previous';
            }
        }
    }

    return withProjectionSource(candidate, previous, source, backtrackClampedDiag);
}

function NavigationScreen() {
    const router = useRouter();
    const mapRef = useRef<MapRef>(null);
    const researchLogger = useSyncExternalStore(
        subscribeResearchLogger,
        getResearchLoggerSnapshot,
        getResearchLoggerSnapshot,
    );

    const queryResult = router.isReady ? parseNavigationQuery(router.query) : null;
    const pollingUsersId = queryResult?.ok ? queryResult.value.usersId : null;
    const pollingTakecareId = queryResult?.ok ? queryResult.value.takecareId : null;

    // Production entry readiness.
    // Invalid 0/0 sentinels remain internal only and are never allowed to
    // start navigation or render the production map.
    const [hasRealGpsPosition, setHasRealGpsPosition] = useState(false);
    const hasRealGpsPositionRef = useRef(false);
    const [hasRealTargetPosition, setHasRealTargetPosition] = useState(false);
    const hasRealTargetPositionRef = useRef(false);
    const [gpsError, setGpsError] = useState(false);

    const [currentPosition, setCurrentPosition] = useState(() => {
        if (typeof window !== "undefined") {
            try {
                const stored = localStorage.getItem('afe_navigation_session');
                if (stored) {
                    const data = JSON.parse(stored);
                    if (data.agentPos && data.agentPos.lat) return data.agentPos;
                }
            } catch (e) {}
        }
        return { lat: 0, lng: 0 };
    });

    const [patientLocation, setPatientLocation] = useState<TargetReference>(() => {
        if (typeof window !== "undefined") {
            try {
                const stored = localStorage.getItem('afe_navigation_session');
                if (stored) {
                    const data = JSON.parse(stored);
                    if (data.targetPos && data.targetPos.lat) {
                        return {
                            lat: data.targetPos.lat,
                            lng: data.targetPos.lng,
                            targetSampleId:
                                typeof data.targetPos.targetSampleId === 'string'
                                    ? data.targetPos.targetSampleId
                                    : null,
                        };
                    }
                }
            } catch (e) {}
        }
        return { lat: 0, lng: 0, targetSampleId: null };
    });
    const [visualPatientLocation, setVisualPatientLocation] = useState<LatLngPoint>(patientLocation);
    const markerSmoothingDecisionRef = useRef<{
        deadZoneTriggered: boolean;
        animationState: 'initial' | 'dead_zone_hold' | 'snap_invalid' | 'snap_large_jump' | 'interpolating';
        previousVisual: LatLngPoint;
        nextVisual: LatLngPoint;
        rawToVisualBeforeM: number | null;
        rawToVisualAfterM: number | null;
    }>({
        deadZoneTriggered: false,
        animationState: 'initial',
        previousVisual: patientLocation,
        nextVisual: patientLocation,
        rawToVisualBeforeM: 0,
        rawToVisualAfterM: 0,
    });
    // --- State การทำงาน ---
    const [isSoundOn, setIsSoundOn] = useState(true);
    const [isCameraFollowing, setIsCameraFollowing] = useState(false);
    const [hasUserExploredMap, setHasUserExploredMap] = useState(false);
    const [mapHeading, setMapHeading] = useState(0);
    const mapHeadingRef = useRef(0); // synced from mapHeading state for use in closures/effects
    const [gpsHeading, setGpsHeading] = useState(0);
    const [hasStartedMoving, setHasStartedMoving] = useState(false);
    const [isWrongWay, setIsWrongWay] = useState(false);
    const [hasArrived, setHasArrived] = useState(false);
    const [arrivalDistance, setArrivalDistance] = useState<number | null>(null);
    // true หลังจาก watchPosition ส่ง heading ที่ valid มาครั้งแรก (speed > 0.5 && rawHeading !== null)
    const [hasGpsHeading, setHasGpsHeading] = useState(false);


    // ─── Camera perspective mode ───────────────────────────────────────────────
    type CameraMode = 'top_down' | 'navigation_follow';
    const [cameraMode, setCameraMode] = useState<CameraMode>('top_down');
    const cameraModeRef        = useRef<CameraMode>('top_down');
    const hasStartedMovingRef  = useRef(false);                               // avoids stale closure in watchPosition
    const prevPosForMoveRef    = useRef<{ lat: number; lng: number } | null>(null); // distance-based detection
    const ignoreFirstGpsSampleRef     = useRef(true);  // discard first valid GPS sample — use as baseline only
    const consecutiveMovementCountRef = useRef(0);     // consecutive distance ticks exceeding threshold
    const arrivalCandidateStartedAtRef = useRef(0);
    const arrivalCandidateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasArrivedRef = useRef(false);
    const lastArrivalResetKeyRef = useRef("");
    const initAttemptKeyRef = useRef<string | null>(null);
    const initInFlightRef = useRef(false);

    // --- 💡 State ข้อมูลนำทางจาก Mapbox Directions API (เก็บไว้เพื่อ UI) ---
    const [totalDistance, setTotalDistance] = useState(0);

    // --- 💡 State สำหรับ MT-D* Lite ---
    const { path, maneuverRoute, status, routeUxState, sessionId, start, stop, markArrived, eta, distance, updatePositions, routeVersion, routeSourceKey, endpointDiagnostics, restoreChecked, freshStartSequence, routeCandidateProvenance } = useNavigation();
    // ── Motion presentation state ───────────────────────────────────────────

    // displayAgentPosition: projected agent position on the route — drives marker rendering.
    // Updated only after projection stabilization accepts meaningful visual movement.
    // Raw GPS position (currentPosition) is always used for backend calls unchanged.
    const [displayAgentPosition, setDisplayAgentPosition] = useState<LatLngPoint>(() => {
        if (typeof window !== "undefined") {
            try {
                const stored = localStorage.getItem('afe_navigation_session');
                if (stored) {
                    const data = JSON.parse(stored);
                    if (data.agentPos && data.agentPos.lat) return data.agentPos;
                }
            } catch (e) {}
        }
        return { lat: 0, lng: 0 };
    });
    const lastDisplayAgentPositionRef = useRef<LatLngPoint>(displayAgentPosition);
    const lastProjectionRef = useRef<ProjectionLock | null>(null);
    const projectionPoorFitCountRef = useRef<number>(0);
    // M1: track GPS sample and route version last projected — gate per-frame projection
    const lastProjectedGpsAtRef              = useRef<number>(0);
    const lastProjectedRouteVersionRef       = useRef<number>(-1);
    // M1.5R-C: Motion Route SSOT — version counter increments when Motion Route (stableRouteSourcePath) changes
    const motionRouteVersionRef              = useRef<number>(0);
    const lastProjectedMotionRouteVersionRef = useRef<number>(-1);

    // ── Visual agent position layer (Phase 7F-1c) ────────────────────────────
    // visualAgentPosition: what the Marker actually renders — smoothly lerps toward
    // snappedAgentTargetRef each rAF frame, eliminating discrete 0.75m jumps.
    // displayAgentPosition remains the snapped threshold-gated position for route tail.
    const [visualAgentPosition, setVisualAgentPosition] = useState<LatLngPoint>(displayAgentPosition);
    const visualAgentPositionRef = useRef<LatLngPoint>(displayAgentPosition);
    const snappedAgentTargetRef  = useRef<LatLngPoint>(displayAgentPosition);  // snapped projection target
    const lastValidSnappedRef    = useRef<LatLngPoint | null>(null);            // last confirmed on-route position
    // M0.5A: MotionState — presentation-layer single source of truth (shadow-written; not yet authoritative)
    const motionStateRef         = useRef<MotionState>(createInitialMotionState(displayAgentPosition));
    // High-speed marker smoothing refs (Phase highway-hardening)
    const latestAgentSpeedMpsRef         = useRef<number>(0);            // effective speed for dynamic thresholds (GPS or estimated)
    const estimatedAgentSpeedMpsRef      = useRef<number>(0);            // speed estimated from GPS position deltas
    const lastGpsPositionForSpeedRef     = useRef<LatLngPoint | null>(null); // previous GPS pos for speed estimation
    const lastGpsPositionAtMsRef         = useRef<number>(0);            // timestamp of previous GPS pos
    // Continuous visual loop refs (Phase 7F-1c-fix)
    const visualAnimFrameRef     = useRef<number | null>(null);
    const lastVisualFrameTimeRef = useRef<number>(0);
    const isVisualLoopRunningRef = useRef<boolean>(false);
    const [routeTailAnchor, setRouteTailAnchor] = useState<RouteTailAnchor | null>(null);
    const routeTailAnchorRef = useRef<RouteTailAnchor | null>(null);
    const [stableRouteSourcePath, setStableRouteSourcePath] = useState<LatLngPoint[]>([]);
    const stableRouteSourcePathRef = useRef<LatLngPoint[]>([]);
    // [afe.web.route_flicker] Physically-clipped presentation geometry actually fed to the
    // Mapbox route Source. Unlike stableRouteSourcePath (full authoritative path, kept for
    // camera/marker fallback below), this never contains passed history — the passed frontier
    // is excluded from the array itself, not hidden via a separate mutable paint property.
    const [displayRouteSourcePath, setDisplayRouteSourcePath] = useState<LatLngPoint[]>([]);
    const displayRouteSourcePathRef = useRef<LatLngPoint[]>([]);
    const lastRouteSourceSignatureRef = useRef<string>('empty');
    const lastRouteSourceBodySignatureRef = useRef<string>('empty');
    const lastRouteSourceRouteVersionRef = useRef<number>(routeVersion);
    const routeTrimProgressRef = useRef<number>(0);
    const lastRouteTrimDistanceMRef = useRef<number>(0);
    const routeTrimRouteVersionRef = useRef<number>(routeVersion);
    const routeSourceKeyRef = useRef<number>(routeSourceKey);
    const routeTrimSourceKeyRef = useRef<number>(routeSourceKey);
    useEffect(() => { routeSourceKeyRef.current = routeSourceKey; }, [routeSourceKey]);
    const lastRouteTrimPaintAtRef = useRef<number>(0);
    const hasSeededInitialRouteTrimRef = useRef<boolean>(false);
    const seededRouteTrimVersionRef = useRef<number | null>(null);
    const prevRouteSourceKeyForInstRef = useRef<number>(routeSourceKey);
    const routeBodyLockActiveRef = useRef<boolean>(false);
    // Signature of the geometry the currently painted line-trim-offset was
    // computed against. Written next to the existing trim paint sites.
    const presentationShadowTrimBasisSignatureRef = useRef<string | null>(null);
    // PR2a-1C-C4-A: production-wiring generation counter. This counter increments
    // exactly once per ON-branch production attempt outcome (including a
    // trim-null clean hold and an unexpected construction error), and is never reset within the component's lifetime.
    const productionTransactionGenerationRef = useRef<number>(0);
    const routeActivationSeqRef = useRef<number>(0);
    // PR2a-1C-C4-A: session-scoped transaction auto-disable state. Reset only
    // when the navigation session identity (sessionId) changes — never on
    // routeSourceKey/routeVersion change, Mapbox replacement, or an
    // incremental route update. Unreachable while the compiled gate is OFF.
    const sessionTransactionAutoDisabledRef = useRef<boolean>(false);
    const sessionTransactionAutoDisableReasonRef = useRef<string | null>(null);
    const sessionTransactionAutoDisableGenerationRef = useRef<number | null>(null);
    const sessionTransactionAutoDisableSessionIdRef = useRef<string | null>(null);
    // ── Visual marker bearing layer (Phase 7F-1d) ────────────────────────────
    // targetMarkerBearingRef: bearing target updated from markerBearingInfo (React cadence).
    // visualMarkerBearingRef: actual rendered bearing — dt-based lerp toward target in rAF loop.
    // Decouples React render jitter from visual rotation so the arrow stays smooth.
    const targetMarkerBearingRef       = useRef<number>(0);
    const visualMarkerBearingRef       = useRef<number>(0);
    const [visualMarkerBearing, setVisualMarkerBearing] = useState<number>(0);
    const prevIsCameraFollowingForMarkerRef = useRef(isCameraFollowing);

    // renderedRoutePath is kept for marker/camera visual geometry only.
    // Mapbox Source is intentionally locked to stableRouteSourcePath below.
    // F2: when path is too short during active nav, fall back to stableRouteSourcePath for
    //     projection stability — marker/camera use the same dense geometry as the visible route.
    const renderedRoutePath: LatLngPoint[] = useMemo(() => {
        const usingFallback = (status === 'active' || status === 'loading')
            && path.length >= 2
            && (
                // F2: incoming path too short
                (path.length < MIN_ROUTE_PRESENTATION_PTS
                    && stableRouteSourcePath.length >= MIN_ROUTE_PRESENTATION_PTS)
                ||
                // F3: stable source has more pts than incoming — body lock active, use stable geometry
                (stableRouteSourcePath.length >= ROUTE_BODY_LOCK_MIN_VISIBLE_PTS
                    && stableRouteSourcePath.length > path.length
                    && path.length >= MIN_ROUTE_PRESENTATION_PTS)
            );
        const geomPath = usingFallback ? stableRouteSourcePath : path;

        if (geomPath.length < 2) return geomPath;

        // routeTailAnchor and lockedProjection are indexed against path — skip when using fallback
        const validTailAnchor = !usingFallback
            && !!routeTailAnchor
            && routeTailAnchor.routeVersion === routeVersion
            && routeTailAnchor.routePathLen === path.length
            && routeTailAnchor.segmentIndex < path.length - 1;

        if (validTailAnchor && routeTailAnchor) {
            const tail = path.slice(routeTailAnchor.segmentIndex + 1);
            if (tail.length > 0) {
                const rendered: LatLngPoint[] = [routeTailAnchor.point, ...tail];
                if (rendered.length >= 2) return rendered;
            }
        }

        const lockedProjection = lastProjectionRef.current;
        const canUseLockedSegment = !usingFallback
            && !!lockedProjection
            && lockedProjection.routeVersion === routeVersion
            && lockedProjection.routePathLen === path.length
            && lockedProjection.segmentIndex < path.length - 1
            && distanceMeters(displayAgentPosition, lockedProjection.projectedPoint) <= 5;

        const proj = canUseLockedSegment
            ? lockedProjection
            : projectPointToRoute(displayAgentPosition, geomPath);
        if (!proj || proj.distanceM > AGENT_PROJECTION_MAX_DIST_M) return geomPath;
        const tail = geomPath.slice(proj.segmentIndex + 1);
        if (tail.length === 0) return geomPath;
        const rendered: LatLngPoint[] = [proj.projectedPoint, ...tail];
        return rendered.length >= 2 ? rendered : geomPath;
    }, [displayAgentPosition, path, stableRouteSourcePath, routeVersion, routeTailAnchor, status]);

    // [afe.web.route_flicker] Mapbox Source uses only displayRouteSourcePath — the physically
    // clipped presentation geometry (see declaration above). stableRouteSourcePath (the full
    // authoritative path) is intentionally NOT used here anymore; it remains available for
    // camera/marker fallback elsewhere in this file, unchanged.
    const activeRouteSourcePath = displayRouteSourcePath;

    // แปลง displayRouteSourcePath เป็น GeoJSON — coordinates ต้องเป็น [lng, lat] (Mapbox convention)
    // Source data is locked against agent movement to avoid full LineString setData flicker.
    const routeGeoJSON: GeoJSON.LineString | null = useMemo(() => {
        if (activeRouteSourcePath.length < 2) return null;
        return { type: "LineString", coordinates: activeRouteSourcePath.map(p => [p.lng, p.lat] as [number, number]) };
    }, [activeRouteSourcePath]);

    // GeoJSON FeatureCollection สำหรับ Source — memoized แยกต่างหากเพื่อลด setData calls
    const routeSourceData: GeoJSON.FeatureCollection = useMemo(() => ({
        type: "FeatureCollection",
        features: routeGeoJSON
            ? [{ type: "Feature", properties: {}, geometry: routeGeoJSON }]
            : [],
    }), [routeGeoJSON]);

    useEffect(() => {
        if (path.length < 2) {
            if (status === 'idle' && stableRouteSourcePathRef.current.length >= 2) {
                stableRouteSourcePathRef.current = [];
                routeBodyLockActiveRef.current = false;
                lastRouteSourceSignatureRef.current = 'empty';
                lastRouteSourceBodySignatureRef.current = 'empty';
                lastRouteSourceRouteVersionRef.current = routeVersion;
                setStableRouteSourcePath([]);
                // [afe.web.route_flicker] clear the displayed/clipped geometry alongside the
                // authoritative one so the Source does not keep showing a stale route.
                displayRouteSourcePathRef.current = [];
                setDisplayRouteSourcePath([]);
            }
            return;
        }

        const candidate = path;
        const previousPath = stableRouteSourcePathRef.current;
        const previousSignature = lastRouteSourceSignatureRef.current;
        const previousBodySignature = lastRouteSourceBodySignatureRef.current;
        const nextSignature = computeRouteSourceSignature(candidate);
        const nextBodySignature = computeRouteSourceBodySignature(candidate);
        const routeVersionChanged = routeVersion !== lastRouteSourceRouteVersionRef.current;
        const sourceKeyChanged = routeSourceKey !== prevRouteSourceKeyForInstRef.current;
        const previousLast = previousPath.length >= 1 ? previousPath[previousPath.length - 1] : null;
        const nextLast = candidate[candidate.length - 1];
        const lastPointMoveM = previousLast ? distanceMeters(previousLast, nextLast) : Infinity;
        const sameSignature = previousSignature === nextSignature;
        const sameBody = previousBodySignature === nextBodySignature;
        const recordRouteActivation = () => {
            if (!routeCandidateProvenance) return;
            const routeActivationSeq = routeActivationSeqRef.current + 1;
            routeActivationSeqRef.current = routeActivationSeq;
            appendResearchProvenanceEvent({
                event: 'route_active',
                system_version: 'V3',
                ...routeCandidateProvenance,
                route_activation_seq: routeActivationSeq,
                route_version: routeVersion,
                route_signature: nextSignature,
            });
        };
        const applySourcePathLegacy = (reason: string) => {
            const nextPath = candidate.map((point) => ({ lat: point.lat, lng: point.lng }));
            stableRouteSourcePathRef.current = nextPath;
            motionRouteVersionRef.current += 1; // M1.5R-C: notify rAF that Motion Route changed
            if (routeBodyLockActiveRef.current) {
                routeBodyLockActiveRef.current = false;
            }
            lastRouteSourceSignatureRef.current = nextSignature;
            lastRouteSourceBodySignatureRef.current = nextBodySignature;
            lastRouteSourceRouteVersionRef.current = routeVersion;
            setStableRouteSourcePath(nextPath);
            // [afe.web.route_flicker] Seed the displayed/clipped geometry only on a genuine
            // identity change (first route, or Mapbox-refetch remount) or when nothing has
            // been displayed yet. On an ordinary MT-D* incremental update (same identity),
            // the previous generation's physically-clipped geometry keeps showing until the
            // continuous rAF loop below (single write path) re-clips onto the new geometry —
            // this avoids a second, independent writer racing the Source's `data` prop and
            // reintroducing full/unclipped geometry for a frame.
            if (sourceKeyChanged || displayRouteSourcePathRef.current.length < 2) {
                displayRouteSourcePathRef.current = nextPath;
                setDisplayRouteSourcePath(nextPath);
            }
            recordRouteActivation();
        };

        // ── PR2a-1C-B2: gate-OFF legacy wrapper (NO TRANSACTION BEHAVIOR) ─────
        // Wraps ONLY the three same-identity accepted route updates. Deliberately
        // excluded: initial_seed, and the route_version_changed call site under
        // sourceKeyChanged === true (that one is Mapbox replacement — it shares
        // the reason string but is a different branch entirely, so substitution
        // is by call-site position, never by reason-string matching).
        //
        // Both branches publish through applySourcePathLegacy exactly once, so
        // production behavior is equivalent whether the gate is OFF or ON.
        // applySourcePathLegacy itself is not modified by this phase.

        // ── PR2a-1C-C4-A: production dependency adapters (ON branch only) ───────
        // Thin closures over existing production refs/state. None of them decide
        // policy — the C1/C3 helpers they wrap own every mutation decision.
        // Unreachable while the compiled gate is OFF.
        const readCurrentSourceOwnership: ReadCurrentSourceOwnershipDependency = () => ({
            // Proves frontend-ref coherence only — NOT browser-visible atomicity.
            // sourceSignature/bodySignature reflect the LAST-PUBLISHED ownership
            // (written inside applySourcePathLegacy / commitFrontendOwnership
            // below). routeSourceKey/routeVersion mirror the CURRENT candidate,
            // which coincides with "last published" only because this whole
            // evaluation is synchronous with no await between prepare and
            // commit. Future async/concurrent wiring must re-review this
            // contract before relying on it for anything stronger.
            generation: productionTransactionGenerationRef.current,
            routeSourceKey: routeSourceKeyRef.current,
            routeVersion: routeVersionRef.current,
            sourceSignature: lastRouteSourceSignatureRef.current,
            bodySignature: lastRouteSourceBodySignatureRef.current,
        });

        const stageStrictTrimMutation: StageStrictTrimMutationDependency = (input) => {
            // Resolved fresh on every invocation — stage and each restore call
            // each capture their own single map instance; never cached across calls.
            const map = mapRef.current?.getMap?.() as {
                getLayer?: (layerId: string) => unknown;
                getPaintProperty?: (layerId: string, property: string) => unknown;
                setPaintProperty?: (layerId: string, property: string, value: unknown) => void;
            } | undefined;
            const adapter: TrimPaintMapAdapter = {
                getLayer: (layerId) => map?.getLayer?.(layerId),
                getPaintProperty: (layerId, property) => map?.getPaintProperty?.(layerId, property),
                setPaintProperty: (layerId, property, value) => { map?.setPaintProperty?.(layerId, property, value); },
            };
            return executeStrictTrimMutation(adapter, input);
        };

        const commitFrontendOwnership: CommitFrontendOwnershipDependency = (input) => {
            const refsWritten: string[] = [];
            try {
                const committedPath = input.candidatePath.map((p) => ({ lat: p.lat, lng: p.lng }));
                stableRouteSourcePathRef.current = committedPath;                    // write 1
                refsWritten.push('stableRouteSourcePathRef');
                motionRouteVersionRef.current += 1;                                  // write 2
                refsWritten.push('motionRouteVersionRef');
                lastRouteSourceSignatureRef.current = input.sourceSignature;         // write 3
                refsWritten.push('lastRouteSourceSignatureRef');
                lastRouteSourceBodySignatureRef.current = input.bodySignature;       // write 4
                refsWritten.push('lastRouteSourceBodySignatureRef');
                lastRouteSourceRouteVersionRef.current = input.routeVersion;         // write 5
                refsWritten.push('lastRouteSourceRouteVersionRef');
                setStableRouteSourcePath(committedPath);                             // write 6 — React state, last, SAME object
                refsWritten.push('setStableRouteSourcePath');
                return { committed: true, refsWritten, failedWrites: [], failureReason: null };
            } catch {
                return { committed: false, refsWritten, failedWrites: [], failureReason: 'commit_write_threw' };
            }
        };

        const productionDependencies: PresentationTransactionIntegrationDependencies = {
            readCurrentSourceOwnership, stageStrictTrimMutation, commitFrontendOwnership,
        };

        const applySourcePathTransactionStub = (
            reason: PresentationTransactionEligibleReason,
        ): void => {
            // PR2a-1C-C4-A: real ON-branch production wiring. Still unreachable
            // while TRANSACTION_GATE_COMPILED is false — see
            // applySourcePathWithTransactionGate below, unchanged. Exactly one
            // policy/effect decision governs this function.

            // 1. reset or initialize session auto-disable identity
            if (sessionId !== null && sessionId !== sessionTransactionAutoDisableSessionIdRef.current) {
                sessionTransactionAutoDisabledRef.current = false;
                sessionTransactionAutoDisableReasonRef.current = null;
                sessionTransactionAutoDisableGenerationRef.current = null;
                sessionTransactionAutoDisableSessionIdRef.current = sessionId;
            }

            // 2/3. increment the production generation exactly once; store locally
            productionTransactionGenerationRef.current += 1;
            const generation = productionTransactionGenerationRef.current;

            // 4. construct exactly one ProductionAttemptOutcome inside one try/catch
            // (type left to inference — every assignment below is reachable
            // before the one read at step 5, so no annotation is needed).
            let attemptOutcome;
            try {
                const gateSnapshot = createPresentationTransactionGateSnapshot({
                    generation,
                    buildCapabilityEnabled: TRANSACTION_GATE_COMPILED,
                    fieldTestSwitchEnabled: FIELD_TEST_SWITCH_COMPILED,
                    sessionAutoDisabled: sessionTransactionAutoDisabledRef.current,
                });
                const candidateTrim = computeRouteTrimProgress(
                    visualAgentPositionRef.current,
                    candidate,
                    ROUTE_TRIM_MAX_PROJECTION_DIST_M,
                );
                if (candidateTrim === null) {
                    attemptOutcome = { kind: 'CLEAN_PRECONDITION_HOLD', reason: 'intended_trim_unavailable' };
                } else {
                    // Structurally checked against PresentationTransactionIntegrationInput
                    // at the call site below — no separate annotation needed here.
                    const c3Input = {
                        generation,
                        gateSnapshot,
                        routeSourceKey,
                        routeVersion,
                        sourceSignature: nextSignature,
                        bodySignature: nextBodySignature,
                        candidatePath: candidate,
                        intendedTrim: [0, candidateTrim.progress],
                    };
                    const result = evaluatePresentationTransactionIntegration(c3Input, productionDependencies);
                    attemptOutcome = { kind: 'C3_RESULT', result };
                }
            } catch {
                attemptOutcome = { kind: 'UNEXPECTED_ATTEMPT_ERROR', reason: 'production_attempt_threw' };
            }

            // 5. run exactly one pure policy
            const policyOutcome = decideProductionWiringAction(attemptOutcome);

            // 6. execute exactly one effect switch
            switch (policyOutcome.decision) {
                case 'USE_LEGACY':
                    applySourcePathLegacy(reason);
                    break;
                case 'TRANSACTION_COMMITTED':
                    recordRouteActivation();
                    break;
                case 'AUTO_DISABLE_NO_FALLBACK':
                    if (sessionTransactionAutoDisableSessionIdRef.current === sessionId) {
                        sessionTransactionAutoDisabledRef.current = true;
                        sessionTransactionAutoDisableReasonRef.current = policyOutcome.reason;
                        sessionTransactionAutoDisableGenerationRef.current = generation;
                    }
                    break;
            }

        };

        const applySourcePathWithTransactionGate = (
            reason: PresentationTransactionEligibleReason,
        ): void => {
            if (!TRANSACTION_GATE_COMPILED) {
                return applySourcePathLegacy(reason);
            }
            return applySourcePathTransactionStub(reason);
        };

        // Record remount status before branching
        if (routeVersionChanged) {
            if (sourceKeyChanged) {
                prevRouteSourceKeyForInstRef.current = routeSourceKey;
            }
        }

        // F2: Route Presentation Guard — protects visual route from abrupt collapse
        const presentationGuard = shouldApplyPresentationPath({
            status,
            incomingPathLength: candidate.length,
            currentVisiblePathLength: previousPath.length,
            isIdentityChange: sourceKeyChanged,
        });

        // Helper: evaluate F3 body lock and return the hold decision.
        const evalBodyLock = (branch: string, epDeltaM: number): { hold: boolean; reason: string } => {
            const result = shouldHoldRouteBodyLock({
                status,
                isIdentityChange: sourceKeyChanged,
                currentVisiblePathLength: previousPath.length,
                incomingPathLength: candidate.length,
                endpointDeltaM: epDeltaM,
            });
            return result;
        };

        const holdBodyLock = () => {
            routeBodyLockActiveRef.current = true;
        };


        if (previousPath.length < 2) {
            // Case 1: initial seed — F3 not applicable, no visible path yet
            applySourcePathLegacy('initial_seed');
        } else if (sameSignature) {
            // Case 2: exact duplicate — no source change at all
            lastRouteSourceRouteVersionRef.current = routeVersion;
        } else if (routeVersionChanged) {
            if (sourceKeyChanged) {
                // Case 3a: Mapbox refetch (identity change) — F3 must not block new geometry
                if (presentationGuard.apply) {
                    applySourcePathLegacy('route_version_changed');
                }
            } else {
                // Case 3b: MT-D* incremental — routeVersion incremented but NOT a Mapbox refetch.
                // F3 MUST evaluate here: field test showed 8→7 path shrink goes through this branch.
                if (presentationGuard.apply) {
                    const epDelta3 = Number.isFinite(lastPointMoveM) ? lastPointMoveM : 0;
                    const bodyLock3 = evalBodyLock('route_version_changed', epDelta3);
                    if (bodyLock3.hold) {
                        holdBodyLock();
                    } else {
                        applySourcePathWithTransactionGate('route_version_changed');
                    }
                }
            }
        } else if (Number.isFinite(lastPointMoveM) && lastPointMoveM > ROUTE_SOURCE_ENDPOINT_MOVE_M) {
            // Case 4: endpoint moved > 1m
            if (presentationGuard.apply) {
                const bodyLock4 = evalBodyLock('route_endpoint_changed', lastPointMoveM);
                if (bodyLock4.hold) {
                    holdBodyLock();
                } else {
                    applySourcePathWithTransactionGate('route_endpoint_changed');
                }
            }
        } else if (sameBody) {
            // Case 5: same endpoint — agent-side tail trim only, F3 not needed
        } else {
            // Case 6: body changed (endpoint shifted < 1m or < 0.1m hash boundary)
            if (presentationGuard.apply) {
                const epDelta6 = Number.isFinite(lastPointMoveM) ? lastPointMoveM : 0;
                const bodyLock6 = evalBodyLock('route_body_changed', epDelta6);
                if (bodyLock6.hold) {
                    holdBodyLock();
                } else {
                    applySourcePathWithTransactionGate('route_body_changed');
                }
            }
        }

    }, [path, routeVersion, status, endpointDiagnostics, routeCandidateProvenance]);

    // State สำหรับ UI
    const [arrivalTime, setArrivalTime] = useState("--:--");
    const [durationHrs, setDurationHrs] = useState(0);
    const [durationMins, setDurationMins] = useState(0);

    const isCameraFollowingRef = useRef(isCameraFollowing);
    const prevHeadingRef = useRef(0);
    const hasNavigationBearingRef = useRef(false);
    const lastMarkerBearingRef = useRef<StableMarkerBearingInfo | null>(null);
    const wrongWayRef = useRef(false);
    const wrongWayTicksRef = useRef(0);
    const wrongWayClearTicksRef = useRef(0);
    const lastMovementBearingRef = useRef<number | null>(null);
    const lastMovementBearingSampleRef = useRef<LatLngPoint>(displayAgentPosition);
    const latestGpsSpeedRef = useRef(0);
    // ── Camera bearing management refs ──
    const lastAppliedCameraBearingRef   = useRef(0);          // actual bearing after ease verified — updated from map.getBearing()
    const lastRequestedCameraBearingRef = useRef(0);          // target of the most recent easeTo call — set before animation starts
    const isBearingEasingRef            = useRef(false);      // true while easeTo bearing animation runs
    const isModeTransitionRef           = useRef(false);      // true only during the 1500ms mode-transition easeTo
    const bearingEaseTimeoutRef        = useRef<ReturnType<typeof setTimeout> | null>(null); // applyCameraBearing timeout only
    const modeTransitionTimeoutRef     = useRef<ReturnType<typeof setTimeout> | null>(null); // mode-transition timeout only — separate from bearing ease
    // ── Soft-follow ramp refs ──────────────────────────────────────────────────
    const softFollowStartAtRef             = useRef(0);   // performance.now() when soft-follow ramp began; 0 = inactive
    const softFollowInitialPitchRef        = useRef(0);   // map pitch at soft-follow start
    const softFollowInitialZoomRef         = useRef(0);   // map zoom at soft-follow start
    const softFollowInitialPaddingBottomRef = useRef(0);  // padding.bottom at soft-follow start (always 0 in top_down)
    const targetCameraBearingRef       = useRef(0);          // route-up target from getRouteUpBearingCandidate()
    const targetCameraBearingSourceRef = useRef<RouteUpBearingSource>('fallback');
    const targetCameraBearingSegmentRef = useRef<number | null>(null);
    const visualCameraBearingRef       = useRef(0);          // actual bearing applied by continuous rAF turn smoothing
    // ── Camera center smoothing refs ──
    const visualCameraCenterRef          = useRef<LatLngPoint | null>(null); // smoothed camera center
    const lastCenterApplyDuringEaseAtRef = useRef(0);                        // throttle for center-only jumpTo during bearing ease
    const userCameraOverrideRef          = useRef(false);                     // true after confirmed user pan/zoom/rotate gesture
    const hasUserExploredMapRef          = useRef(false);                     // true after confirmed pre-drive/active user map gesture
    const pendingTouchRef                = useRef<PendingTouchGesture | null>(null);
    const pathRef = useRef(path);
    const routeVersionRef = useRef(routeVersion);
    const renderedRoutePathRef = useRef<LatLngPoint[]>([]); // synced from renderedRoutePath memo — for use in closures

    // --- Refs for marker display state (M1: inner animate removed; position updated at GPS cadence) ---
    const displayPositionRef = useRef(currentPosition); // kept for fallback at agentPos resolution sites
    const [displayBearing, setDisplayBearing] = useState(0); // compass indicator, updated at GPS cadence

    useEffect(() => {
        isCameraFollowingRef.current = isCameraFollowing;
    }, [isCameraFollowing]);

    useEffect(() => {
        pathRef.current = path;
    }, [path]);

    useEffect(() => {
        renderedRoutePathRef.current = renderedRoutePath;
    }, [renderedRoutePath]);

    useEffect(() => {
        routeTailAnchorRef.current = routeTailAnchor;
    }, [routeTailAnchor]);

    // [afe.web.route_flicker] Replaces the former paint-only `line-trim-offset` trim writer.
    // Passed history is now excluded by physically slicing the route coordinates BEFORE they
    // reach the Mapbox Source, instead of hiding it behind a separately-mutated paint property.
    // `line-trim-offset` stays invariant at [0, 0] in the layer JSX and is never written here —
    // there is exactly one write path for what the route Source displays.
    const applyRouteDisplayGeometry = (clippedPath: LatLngPoint[]): boolean => {
        const mapRefValue = mapRef.current as unknown as {
            getMap?: () => unknown;
        } | null;
        const map = (mapRefValue?.getMap ? mapRefValue.getMap() : mapRefValue) as {
            getSource?: (id: string) => { setData?: (data: GeoJSON.FeatureCollection) => void } | undefined;
        } | null;
        const source = map?.getSource ? map.getSource("route") : undefined;
        if (!source?.setData) return false;

        const geojson: GeoJSON.FeatureCollection = clippedPath.length >= 2
            ? {
                type: "FeatureCollection",
                features: [{
                    type: "Feature",
                    properties: {},
                    geometry: {
                        type: "LineString",
                        coordinates: clippedPath.map((p) => [p.lng, p.lat] as [number, number]),
                    },
                }],
            }
            : { type: "FeatureCollection", features: [] };

        try {
            source.setData(geojson);
        } catch {
            // A failed write must not be reported as committed, and must not update bookkeeping
            // refs below — the previously-committed generation remains the displayed one.
            return false;
        }

        displayRouteSourcePathRef.current = clippedPath;
        return true;
    };

    const getInitialRouteTrimPosition = (): LatLngPoint | null => {
        const candidates: Array<LatLngPoint | null | undefined> = [
            visualAgentPositionRef.current,
            lastValidSnappedRef.current,
            snappedAgentTargetRef.current,
            displayAgentPosition,
            displayPositionRef.current,
            currentPosition,
        ];

        for (const point of candidates) {
            if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
                return point;
            }
        }

        return null;
    };

    const seedInitialRouteTrim = (): boolean => {
        const activeRouteVersion = routeVersionRef.current;
        if (hasSeededInitialRouteTrimRef.current && seededRouteTrimVersionRef.current === activeRouteVersion) {
            return true;
        }

        const sourcePath = stableRouteSourcePathRef.current;
        if (sourcePath.length < 2) {
            return false;
        }

        const positionCandidate = getInitialRouteTrimPosition();
        if (!positionCandidate) {
            return false;
        }

        const trim = computeRouteTrimProgress(
            positionCandidate,
            sourcePath,
            ROUTE_TRIM_MAX_PROJECTION_DIST_M,
        );
        if (!trim) {
            return false;
        }

        const previousProgress = routeTrimProgressRef.current;
        const previousDistanceM = lastRouteTrimDistanceMRef.current;
        const currentTrimGeometrySignature = lastRouteSourceSignatureRef.current;
        const geometryBasisChanged = hasRouteTrimGeometryBasisChanged(
            currentTrimGeometrySignature,
            presentationShadowTrimBasisSignatureRef.current,
        );
        const progress = geometryBasisChanged ? trim.progress : Math.max(previousProgress, trim.progress);
        const distanceAlongRouteM = geometryBasisChanged
            ? trim.distanceAlongRouteM
            : Math.max(previousDistanceM, trim.distanceAlongRouteM);
        // [afe.web.route_flicker] Only a fresh (non-clamped) projection has a valid
        // segmentIndex/projectedPoint to physically clip against. If the fresh projection
        // regressed and got clamped to the previous progress, the previously-committed
        // display geometry is already correct — nothing to (re-)write this call.
        const isFreshProjection = shouldCommitFreshProjection(trim.distanceAlongRouteM, previousDistanceM, geometryBasisChanged);
        const applied = isFreshProjection
            ? applyRouteDisplayGeometry(
                clipRoutePathAtProjection(sourcePath, trim.projectedPoint, trim.segmentIndex),
            )
            : true;
        if (!applied) {
            return false;
        }

        routeTrimProgressRef.current = progress;
        // Geometry basis this trim was computed on.
        presentationShadowTrimBasisSignatureRef.current = currentTrimGeometrySignature;
        lastRouteTrimDistanceMRef.current = distanceAlongRouteM;
        routeTrimRouteVersionRef.current = activeRouteVersion;
        lastRouteTrimPaintAtRef.current = Date.now();
        hasSeededInitialRouteTrimRef.current = true;
        seededRouteTrimVersionRef.current = activeRouteVersion;


        return true;
    };

    useEffect(() => {
        if (path.length >= 2) return;
        routeTailAnchorRef.current = null;
        setRouteTailAnchor(null);
        routeTrimProgressRef.current = 0;
        lastRouteTrimDistanceMRef.current = 0;
        hasSeededInitialRouteTrimRef.current = false;
        seededRouteTrimVersionRef.current = null;
        applyRouteDisplayGeometry([]);
        setDisplayRouteSourcePath([]);
        presentationShadowTrimBasisSignatureRef.current = null;
        softFollowStartAtRef.current = 0;
        softFollowInitialPitchRef.current = 0;
        softFollowInitialZoomRef.current = 0;
        softFollowInitialPaddingBottomRef.current = 0;
    }, [path.length]);

    useEffect(() => {
        if (routeVersionRef.current !== routeVersion) {
            const rfPreviousTrimSourceKey = routeTrimSourceKeyRef.current;
            const rfIdentityChange = rfPreviousTrimSourceKey !== routeSourceKeyRef.current;
            const rfTrimResetApplied = rfIdentityChange;
            lastProjectionRef.current = null;
            projectionPoorFitCountRef.current = 0;
            lastValidSnappedRef.current = null; // new route — old snapped position is invalid
            routeTailAnchorRef.current = null;
            setRouteTailAnchor(null);
            wrongWayRef.current = false;
            wrongWayTicksRef.current = 0;
            wrongWayClearTicksRef.current = 0;
            lastMovementBearingRef.current = null;
            lastMovementBearingSampleRef.current = visualAgentPositionRef.current;
            // Phase 2A: Route Trim reset is now identity-scoped, not version-scoped.
            // An MT-D* incremental update (routeVersion changes, routeSourceKey does not)
            // must preserve trim progress — only a genuine identity replacement may zero it.
            if (rfTrimResetApplied) {
                routeTrimProgressRef.current = 0;
                lastRouteTrimDistanceMRef.current = 0;
            }
            // Reliably keep routeTrimSourceKeyRef in sync from the one effect that owns
            // trim lifecycle, instead of depending on the rAF loop's identity-check branch
            // (page.tsx ~2668), which is structurally unreachable once this effect has
            // already synced routeTrimRouteVersionRef/routeVersionRef for the same
            // transition. This is what makes rfIdentityChange above a reliable read.
            routeTrimSourceKeyRef.current = routeSourceKeyRef.current;
            routeTrimRouteVersionRef.current = routeVersion;
            lastRouteTrimPaintAtRef.current = 0;
            hasSeededInitialRouteTrimRef.current = false;
            seededRouteTrimVersionRef.current = null;
            setIsWrongWay(false);
        }
        routeVersionRef.current = routeVersion;
    }, [routeVersion]);

    useEffect(() => {
        if (stableRouteSourcePath.length < 2) return;
        seedInitialRouteTrim();
    }, [stableRouteSourcePath, routeVersion]);

    useEffect(() => {
        const btRef  = bearingEaseTimeoutRef;
        const mtRef  = modeTransitionTimeoutRef;
        return () => {
            if (btRef.current  !== null) clearTimeout(btRef.current);
            if (mtRef.current  !== null) clearTimeout(mtRef.current);
        };
    }, []);

    // Keep cameraModeRef in sync with cameraMode state so the rAF loop can read it without stale closures
    useEffect(() => { cameraModeRef.current = cameraMode; }, [cameraMode]);

    // ── Continuous visual rendering loop (Phase 7F-1c-fix) ────────────────────
    // Runs every rAF frame for the full navigation session — independent of GPS
    // sample rate. Lerps visualAgentPosition toward snappedAgentTarget using
    // dt-based exponential smoothing so marker moves smoothly even between GPS samples.
    // Camera follow is driven from this loop using visualAgentPositionRef.
    useEffect(() => {
        isVisualLoopRunningRef.current = true;
        lastVisualFrameTimeRef.current = performance.now();

        const runFrame = () => {
            if (!isVisualLoopRunningRef.current) return;

            const now       = performance.now();
            const rawDt     = now - lastVisualFrameTimeRef.current;
            // clamp: min 8ms to avoid zero-dt; max 100ms to prevent big jump after tab background
            const dtMs      = Math.max(8, Math.min(100, rawDt));
            lastVisualFrameTimeRef.current = now;
            // M1.5R-C: Motion Route SSOT — single canonical route for projection, integrator, sampling.
            // Resolves to stableRouteSourcePath when available (= route user sees on map).
            // Falls back to pathRef only during the brief startup window before first route is displayed.
            const getMotionRoute = (): LatLngPoint[] => {
                const stable = stableRouteSourcePathRef.current;
                return stable.length >= 2 ? stable : pathRef.current;
            };

            // M0.5A: shadow frame timing to MotionState
            {
                const ms = motionStateRef.current;
                ms.lastFrameAt = now;
                ms.gpsAge = ms.lastGpsAt > 0 ? now - ms.lastGpsAt : 0;
                ms.isStationary = latestGpsSpeedRef.current < 0.5;
                ms.hasMovementDetected = cameraModeRef.current === 'navigation_follow';
            }

            // ── M1: rAF-frame projection ─────────────────────────────────────────
            // Projection runs once per GPS sample (or route version change).
            // Preserves all guards: poor-fit recovery, stale lock, lastValidSnapped fallback.
            {
                const currentGpsAt         = motionStateRef.current.lastGpsAt;
                const currentRouteVer      = routeVersionRef.current;
                const currentMotionRouteVer = motionRouteVersionRef.current;
                const isNewGps             = currentGpsAt > lastProjectedGpsAtRef.current && currentGpsAt > 0;
                const isBackendRouteNew    = currentRouteVer !== lastProjectedRouteVersionRef.current;
                // M1.5R-C: isMotionRouteNew fires when the route used by motion (stableRouteSourcePath)
                // actually changes — NOT merely when backend routeVersion increments during body lock.
                const isMotionRouteNew     = currentMotionRouteVer !== lastProjectedMotionRouteVersionRef.current;
                const isNewRoute           = isMotionRouteNew; // keep for downstream compatibility
                if (isNewGps || isMotionRouteNew || isBackendRouteNew) {
                    lastProjectedGpsAtRef.current              = currentGpsAt;
                    lastProjectedRouteVersionRef.current       = currentRouteVer;
                    lastProjectedMotionRouteVersionRef.current = currentMotionRouteVer;

                    // M1.5R-C: immediate progress migration — project integratorPosition onto new
                    // Motion Route so integrator never falls back to Euclidean during route change.
                    if (isMotionRouteNew) {
                        const newMotionRoute = getMotionRoute();
                        if (newMotionRoute.length >= 2) {
                            const ms          = motionStateRef.current;
                            const migrateProj = projectPointToRoute(ms.integratorPosition, newMotionRoute);
                            if (migrateProj && migrateProj.distanceM <= AGENT_PROJECTION_MAX_DIST_M) {
                                ms.integratorRouteProgressM     = computeRouteProgressFromProjection(
                                    migrateProj.segmentIndex, migrateProj.t, newMotionRoute,
                                );
                                ms.integratorRouteProgressValid = true;
                                ms.integratorRouteBearingSource = 'route';
                            } else {
                                // Migration failed — invalidate and let integrator use Euclidean as last resort
                                ms.integratorRouteProgressValid = false;
                                ms.integratorRouteBearingSource = 'euclidean';
                            }
                        } else {
                            motionStateRef.current.integratorRouteProgressValid = false;
                        }
                    }

                    const rawGps       = motionStateRef.current.rawGpsPosition;
                    const routeForProj = getMotionRoute(); // M1.5R-C: SSOT — was pathRef.current

                    if (routeForProj.length >= 2) {
                        const previousProjection = lastProjectionRef.current;
                        const proj = projectPointToRouteStable(
                            rawGps,
                            routeForProj,
                            previousProjection,
                            routeVersionRef.current,
                        );

                        let finalProj = proj;
                        if (proj && proj.distanceM > PROJECTION_POOR_FIT_DIST_M) {
                            projectionPoorFitCountRef.current++;
                            const isForceDistance = proj.distanceM > PROJECTION_FORCE_FULL_SCAN_DIST_M;
                            const isPoorFitLimit  = projectionPoorFitCountRef.current >= PROJECTION_POOR_FIT_MAX_COUNT;
                            if (isForceDistance || isPoorFitLimit) {
                                const recovered = projectPointToRoute(rawGps, routeForProj);
                                if (recovered && recovered.distanceM < proj.distanceM) {
                                    finalProj = withProjectionSource(recovered, previousProjection, 'full_scan_recovery');
                                    projectionPoorFitCountRef.current = 0;
                                }
                            }
                        } else if (proj) {
                            projectionPoorFitCountRef.current = 0;
                        }
                        if (finalProj && finalProj.distanceM <= AGENT_PROJECTION_MAX_DIST_M) {
                            const nextProjectionLock: ProjectionLock = {
                                ...finalProj,
                                routeVersion:  routeVersionRef.current,
                                routePathLen:  routeForProj.length,
                                lastUpdatedAt: Date.now(),
                            };
                            lastProjectionRef.current     = nextProjectionLock;
                            snappedAgentTargetRef.current = finalProj.projectedPoint;
                            lastValidSnappedRef.current   = finalProj.projectedPoint;
                            // M1.5R: update integrator target — intentionally NOT resetting integratorVelocityMps
                            // M1.5R-B: also compute route progress for route-constrained motion
                            {
                                const ms = motionStateRef.current;
                                ms.integratorTargetPosition      = finalProj.projectedPoint;
                                ms.integratorTargetDistanceM     = distanceMeters(ms.integratorPosition, finalProj.projectedPoint);
                                ms.integratorLastTargetUpdateAt  = now;
                                // Compute route arc-length for target
                                const targetProgressM = computeRouteProgressFromProjection(
                                    finalProj.segmentIndex, finalProj.t, routeForProj,
                                );
                                ms.integratorTargetProgressM = targetProgressM;
                                // Initialize integrator route progress if not yet valid (first GPS or after route change)
                                if (!ms.integratorRouteProgressValid) {
                                    const initProj = projectPointToRoute(ms.integratorPosition, routeForProj);
                                    ms.integratorRouteProgressM = initProj
                                        ? computeRouteProgressFromProjection(initProj.segmentIndex, initProj.t, routeForProj)
                                        : Math.max(0, targetProgressM - distanceMeters(ms.integratorPosition, finalProj.projectedPoint));
                                    ms.integratorRouteProgressValid = true;
                                }
                            }
                            motionStateRef.current.projectedPosition    = finalProj.projectedPoint;
                            motionStateRef.current.projectionDistanceM  = finalProj.distanceM;
                            motionStateRef.current.projectionSegmentIdx = finalProj.segmentIndex;
                            motionStateRef.current.isProjected          = true;

                            const deltaM  = distanceMeters(lastDisplayAgentPositionRef.current, finalProj.projectedPoint);
                            if (deltaM < DISPLAY_AGENT_MIN_MOVE_M) {
                            } else {
                                lastDisplayAgentPositionRef.current = finalProj.projectedPoint;
                                setDisplayAgentPosition(finalProj.projectedPoint);
                            }
                        } else {
                            // Projection too far from route — hold last valid snapped to prevent off-road marker.
                            lastProjectionRef.current = null;
                            projectionPoorFitCountRef.current = 0;
                            motionStateRef.current.isProjected = false;
                            if (lastValidSnappedRef.current) {
                                snappedAgentTargetRef.current = lastValidSnappedRef.current;
                                // M1.5R: update integrator target to last valid snapped (velocity preserved)
                                {
                                    const ms = motionStateRef.current;
                                    ms.integratorTargetPosition      = lastValidSnappedRef.current;
                                    ms.integratorTargetDistanceM     = distanceMeters(ms.integratorPosition, lastValidSnappedRef.current);
                                    ms.integratorLastTargetUpdateAt  = now;
                                }
                            } else {
                                snappedAgentTargetRef.current = rawGps;
                                // M1.5R: update integrator target to raw GPS (velocity preserved)
                                {
                                    const ms = motionStateRef.current;
                                    ms.integratorTargetPosition      = rawGps;
                                    ms.integratorTargetDistanceM     = distanceMeters(ms.integratorPosition, rawGps);
                                    ms.integratorLastTargetUpdateAt  = now;
                                }
                                const deltaM = distanceMeters(lastDisplayAgentPositionRef.current, rawGps);
                                if (deltaM >= DISPLAY_AGENT_MIN_MOVE_M) {
                                    lastDisplayAgentPositionRef.current = rawGps;
                                    setDisplayAgentPosition(rawGps);
                                }
                            }
                        }
                    } else {
                        // No route available
                        lastProjectionRef.current = null;
                        motionStateRef.current.isProjected = false;
                        if (lastValidSnappedRef.current) {
                            snappedAgentTargetRef.current = lastValidSnappedRef.current;
                        } else {
                            const rawGps2 = motionStateRef.current.rawGpsPosition;
                            snappedAgentTargetRef.current = rawGps2;
                            const deltaM = distanceMeters(lastDisplayAgentPositionRef.current, rawGps2);
                            if (deltaM >= DISPLAY_AGENT_MIN_MOVE_M) {
                                lastDisplayAgentPositionRef.current = rawGps2;
                                setDisplayAgentPosition(rawGps2);
                            }
                        }
                    }
                }
            }
            // ── end M1 rAF projection ─────────────────────────────────────────

            // ── M1.5R-B: route-constrained velocity integrator ──────────────
            // Advances marker along route polyline arc instead of Euclidean straight line.
            // Falls back to Euclidean motion when route progress is not yet valid.
            let nextVisual: LatLngPoint = motionStateRef.current.integratorPosition;
            {
                const ms             = motionStateRef.current;
                const route          = getMotionRoute(); // M1.5R-C: SSOT — was pathRef.current
                const progressValid  = ms.integratorRouteProgressValid && route.length >= 2;

                const intPos         = ms.integratorPosition;
                const intTgt         = ms.integratorTargetPosition;
                const euclideanDist  = distanceMeters(intPos, intTgt);
                const dtSec          = dtMs / 1000;
                const gpsAgeSec      = ms.lastGpsAt > 0 ? (now - ms.lastGpsAt) / 1000 : 0;
                const effectiveSpeed = latestAgentSpeedMpsRef.current;

                // Route lag (arc-length) or Euclidean distance for speed/decel calculations
                const progressLag = progressValid
                    ? Math.max(0, ms.integratorTargetProgressM - ms.integratorRouteProgressM)
                    : 0;
                const targetDist = progressValid ? progressLag : euclideanDist;

                // Hard teleport guard — Euclidean only (extreme outliers)
                const dynamicFastCatchup = Math.max(VISUAL_AGENT_FAST_CATCHUP_DIST_M, effectiveSpeed * 2.0);
                const hardTeleportDistM  = Math.max(150, dynamicFastCatchup * 2.5);

                let newVelocity  = ms.integratorVelocityMps;
                let newBearing   = ms.integratorBearingDeg;
                let mode         = 'stopped';
                let desiredSpeed = 0;
                // M1.5R-D1: capture pre-frame values for derived dynamics metrics
                const prevVelocity = newVelocity;
                const prevBearing  = newBearing;
                if (euclideanDist > hardTeleportDistM) {
                    // Hard teleport — snap to target, reset velocity and progress
                    nextVisual  = intTgt;
                    newVelocity = 0;
                    if (progressValid) ms.integratorRouteProgressM = ms.integratorTargetProgressM;
                } else {
                    const isStale = gpsAgeSec > INTEGRATOR_STALE_GPS_SEC;

                    if (!isStale && targetDist >= INTEGRATOR_EPSILON_M) {
                        if (effectiveSpeed > INTEGRATOR_STOP_SPEED_MPS) {
                            desiredSpeed = Math.min(effectiveSpeed, INTEGRATOR_MAX_SPEED_MPS);
                        } else {
                            desiredSpeed = Math.min(
                                targetDist / INTEGRATOR_EXPECTED_GPS_INTERVAL_SEC,
                                INTEGRATOR_MAX_SPEED_MPS,
                            );
                        }
                        // Deceleration window: smooth approach to target
                        if (desiredSpeed > 0) {
                            const timeToTarget = targetDist / desiredSpeed;
                            if (timeToTarget < INTEGRATOR_DECEL_WINDOW_SEC) {
                                desiredSpeed *= timeToTarget / INTEGRATOR_DECEL_WINDOW_SEC;
                            }
                        }
                    }

                    // M1.5R-D Task 1: Acceleration clamp — replaces exponential lerp.
                    // Prevents GPS jitter from causing abrupt 6→9→6 m/s velocity swings.
                    const velDelta = desiredSpeed - newVelocity;
                    newVelocity += Math.max(-INTEGRATOR_MAX_DECEL_MPS2 * dtSec,
                                            Math.min(INTEGRATOR_MAX_ACCEL_MPS2 * dtSec, velDelta));
                    if (newVelocity < 0.01) newVelocity = 0;

                    // M1.5R-D Task 5: Mode with cruise hysteresis — reduce Accel/Cruise oscillation
                    const prevMode = ms.integratorMode;
                    if (newVelocity < 0.05) {
                        mode = 'stopped';
                    } else if (prevMode === 'cruise') {
                        if      (desiredSpeed > newVelocity + INTEGRATOR_CRUISE_HYSTERESIS_MPS) mode = 'accel';
                        else if (desiredSpeed < newVelocity - INTEGRATOR_CRUISE_HYSTERESIS_MPS) mode = 'decel';
                        else                                                                      mode = 'cruise';
                    } else {
                        if      (desiredSpeed > newVelocity + 0.1) mode = 'accel';
                        else if (desiredSpeed < newVelocity - 0.1) mode = 'decel';
                        else                                        mode = 'cruise';
                    }

                    if (progressValid) {
                        // ── Route-constrained motion (M1.5R-B) ──────────────
                        const currentPrg = ms.integratorRouteProgressM;
                        const targetPrg  = ms.integratorTargetProgressM;

                        // Fast catch-up multiplier for arc lag — never jump
                        let catchupMul = 1.0;
                        if      (progressLag > 8) catchupMul = 1.5;
                        else if (progressLag > 3) catchupMul = 1.2;

                        const moveDist = newVelocity * dtSec * catchupMul;

                        if (progressLag < INTEGRATOR_EPSILON_M) {
                            // Settled at target
                            ms.integratorRouteProgressM = targetPrg;
                            nextVisual = intTgt;
                        } else {
                            const newProgress = Math.min(currentPrg + moveDist, targetPrg);
                            ms.integratorRouteProgressM = newProgress;

                            const sampled = sampleRouteAtDistance(route, newProgress);
                            if (sampled) {
                                nextVisual = sampled.position;
                                // M1.5R-D Task 3: Heading dynamics — limit angular velocity for natural steering
                                {
                                    const bDelta = shortestBearingDelta(ms.integratorBearingDeg, sampled.bearing);
                                    const maxBΔ  = INTEGRATOR_MAX_ANGULAR_VEL_DEG_S * dtSec;
                                    newBearing = normalizeBearing(ms.integratorBearingDeg
                                        + Math.max(-maxBΔ, Math.min(maxBΔ, bDelta)));
                                }
                                ms.integratorRouteBearingSource = 'route';
                            } else {
                                // Sampling failed — Euclidean fallback
                                if (euclideanDist >= INTEGRATOR_EPSILON_M && moveDist > 0) {
                                    const frac = Math.min(1, moveDist / euclideanDist);
                                    nextVisual = {
                                        lat: intPos.lat + frac * (intTgt.lat - intPos.lat),
                                        lng: intPos.lng + frac * (intTgt.lng - intPos.lng),
                                    };
                                } else {
                                    nextVisual = intPos;
                                }
                                if (distanceMeters(intPos, nextVisual) > 0.05) {
                                    const rawB  = bearingBetween(intPos, nextVisual);
                                    const bDelta = shortestBearingDelta(ms.integratorBearingDeg, rawB);
                                    const maxBΔ  = INTEGRATOR_MAX_ANGULAR_VEL_DEG_S * dtSec;
                                    newBearing = normalizeBearing(ms.integratorBearingDeg
                                        + Math.max(-maxBΔ, Math.min(maxBΔ, bDelta)));
                                }
                                ms.integratorRouteBearingSource = 'euclidean';
                            }
                        }
                    } else {
                        // ── Euclidean fallback (route not loaded / invalid) ──
                        const moveDist = newVelocity * dtSec;
                        if (euclideanDist < INTEGRATOR_EPSILON_M || moveDist >= euclideanDist) {
                            nextVisual = intTgt;
                        } else if (moveDist > 0) {
                            const frac = moveDist / euclideanDist;
                            nextVisual = {
                                lat: intPos.lat + (intTgt.lat - intPos.lat) * frac,
                                lng: intPos.lng + (intTgt.lng - intPos.lng) * frac,
                            };
                        } else {
                            nextVisual = intPos;
                        }
                        if (distanceMeters(intPos, nextVisual) > 0.05) {
                            const rawB  = bearingBetween(intPos, nextVisual);
                            const bDelta = shortestBearingDelta(ms.integratorBearingDeg, rawB);
                            const maxBΔ  = INTEGRATOR_MAX_ANGULAR_VEL_DEG_S * dtSec;
                            newBearing = normalizeBearing(ms.integratorBearingDeg
                                + Math.max(-maxBΔ, Math.min(maxBΔ, bDelta)));
                        }
                        ms.integratorRouteBearingSource = 'euclidean';
                    }
                }

                // Write back to MotionState
                // M1.5R-D1: derived dynamics metrics (computed from pre-frame values before overwrite)
                ms.integratorAccelMps2      = dtSec > 0 ? (newVelocity - prevVelocity) / dtSec : 0;
                ms.integratorAngularVelDegS = dtSec > 0
                    ? Math.abs(shortestBearingDelta(prevBearing, newBearing)) / dtSec : 0;
                ms.integratorPosition        = nextVisual;
                ms.integratorVelocityMps     = newVelocity;
                ms.integratorBearingDeg      = newBearing;
                ms.integratorTargetDistanceM = progressValid
                    ? Math.max(0, ms.integratorTargetProgressM - ms.integratorRouteProgressM)
                    : distanceMeters(nextVisual, intTgt);
                ms.integratorDesiredSpeedMps = desiredSpeed;
                ms.integratorIsSettled       = newVelocity < 0.05 && ms.integratorTargetDistanceM < INTEGRATOR_EPSILON_M;
                ms.integratorMode            = mode;
                // M1.5R-D2: turn diagnostics — sample 5m ahead for upcoming heading delta
                if (progressValid) {
                    const aheadS = sampleRouteAtDistance(route, ms.integratorRouteProgressM + INTEGRATOR_TURN_LOOKAHEAD_M);
                    const tDelta = aheadS ? Math.abs(shortestBearingDelta(ms.integratorBearingDeg, aheadS.bearing)) : 0;
                    ms.integratorTurnHeadingDeltaDeg = tDelta;
                    ms.integratorTurnPhase           = tDelta > INTEGRATOR_TURN_DETECT_DEG ? 'TURNING' : 'STRAIGHT';
                }
            }
            // ── end M1.5R-B integrator ───────────────────────────────────────
            visualAgentPositionRef.current = nextVisual;
            setVisualAgentPosition(nextVisual);
            // M0.5A: shadow visual position to MotionState
            motionStateRef.current.visualPosition = nextVisual;

            // ── Wrong-way detection / movement-bearing fallback (Phase 9) ─────
            // Detect when the visual agent is moving opposite the route tangent. This is
            // a visual-only bearing fallback: it does not reroute, mutate path, or touch Source.
            {
                const sampleFrom = lastMovementBearingSampleRef.current;
                const movementDistanceM = distanceMeters(sampleFrom, nextVisual);
                if (movementDistanceM >= WRONG_WAY_MOVEMENT_MIN_M) {
                    const movementBearing = computeBearingBetween(sampleFrom, nextVisual);
                    lastMovementBearingRef.current = movementBearing;
                    lastMovementBearingSampleRef.current = nextVisual;

                    const routeCandidate = getRouteGeometryBearingCandidate();
                    const routeBearing = routeCandidate.bearing;
                    const delta = Math.abs(shortestBearingDelta(routeBearing, movementBearing));
                    const speed = latestGpsSpeedRef.current;
                    const isEligible = cameraModeRef.current === 'navigation_follow'
                        && isCameraFollowingRef.current
                        && routeCandidate.source !== 'gps'
                        && routeCandidate.source !== 'fallback'
                        && (movementDistanceM >= WRONG_WAY_MOVEMENT_MIN_M || speed >= WRONG_WAY_SPEED_MIN_MPS);

                    if (isEligible) {
                        if (delta > WRONG_WAY_DETECT_DELTA_DEG) {
                            wrongWayTicksRef.current += 1;
                            wrongWayClearTicksRef.current = 0;
                            if (!wrongWayRef.current && wrongWayTicksRef.current >= WRONG_WAY_TICKS_REQUIRED) {
                                wrongWayRef.current = true;
                                setIsWrongWay(true);
                            }
                        } else if (delta < WRONG_WAY_CLEAR_DELTA_DEG) {
                            wrongWayClearTicksRef.current += 1;
                            wrongWayTicksRef.current = 0;
                            if (wrongWayRef.current && wrongWayClearTicksRef.current >= WRONG_WAY_TICKS_REQUIRED) {
                                wrongWayRef.current = false;
                                setIsWrongWay(false);
                            }
                        } else {
                            wrongWayTicksRef.current = 0;
                            wrongWayClearTicksRef.current = 0;
                        }
                    }

                }

                if (wrongWayRef.current && lastMovementBearingRef.current !== null) {
                    const overrideBearing = normalizeBearing(lastMovementBearingRef.current);
                    targetMarkerBearingRef.current = overrideBearing;
                    targetCameraBearingRef.current = overrideBearing;
                    targetCameraBearingSourceRef.current = 'wrong_way_movement_bearing';
                    targetCameraBearingSegmentRef.current = null;

                }
            }

            // ── Route tail anchor sync (Phase 6) ─────────────────────────────
            // Marker renders from nextVisual every frame, but Mapbox route source must not
            // update every rAF. Project the visual marker back onto road geometry and update
            // a throttled anchor only after meaningful movement.
            {
                const routeForTail = getMotionRoute(); // M1.5R-C: SSOT — was pathRef.current
                if (routeForTail.length >= 2) {
                    const tailNow = Date.now();
                    const currentAnchor = routeTailAnchorRef.current;
                    const lockedProjection = lastProjectionRef.current;
                    const validLockedSegment = lockedProjection
                        && lockedProjection.routeVersion === routeVersionRef.current
                        && lockedProjection.routePathLen === routeForTail.length
                        && lockedProjection.segmentIndex < routeForTail.length - 1;
                    const projectedTail = validLockedSegment
                        ? projectPointToRouteRange(
                            nextVisual,
                            routeForTail,
                            Math.max(0, lockedProjection.segmentIndex - 1),
                            Math.min(routeForTail.length - 2, lockedProjection.segmentIndex + 1),
                        )
                        : projectPointToRoute(nextVisual, routeForTail);

                    if (!projectedTail || projectedTail.distanceM > ROUTE_TAIL_ANCHOR_MAX_PROJECTION_DIST_M) {
                    } else {
                        const nextAnchor: RouteTailAnchor = {
                            point: projectedTail.projectedPoint,
                            segmentIndex: projectedTail.segmentIndex,
                            routeVersion: routeVersionRef.current,
                            routePathLen: routeForTail.length,
                            updatedAt: tailNow,
                            source: 'visual_projection',
                        };
                        const hasValidCurrentAnchor = currentAnchor
                            && currentAnchor.routeVersion === routeVersionRef.current
                            && currentAnchor.routePathLen === routeForTail.length
                            && currentAnchor.segmentIndex < routeForTail.length - 1;
                        const movedM = hasValidCurrentAnchor
                            ? distanceMeters(currentAnchor.point, nextAnchor.point)
                            : Infinity;
                        const timeSinceLastUpdateMs = hasValidCurrentAnchor
                            ? tailNow - currentAnchor.updatedAt
                            : Infinity;
                        let skipReason: 'small_move' | 'throttled' | null = null;
                        if (hasValidCurrentAnchor && timeSinceLastUpdateMs < ROUTE_TAIL_ANCHOR_UPDATE_INTERVAL_MS) {
                            skipReason = 'throttled';
                        } else if (hasValidCurrentAnchor && movedM < ROUTE_TAIL_ANCHOR_MIN_MOVE_M) {
                            skipReason = 'small_move';
                        }

                        if (skipReason) {
                        } else {
                            routeTailAnchorRef.current = nextAnchor;
                            setRouteTailAnchor(nextAnchor);
                        }
                    }
                }
            }

            // ── [afe.web.route_flicker] Route display geometry (physical clip) ──────
            // Passed history is excluded by physically slicing stableRouteSourcePathRef
            // (the full authoritative path) at the agent's projected position, then writing
            // the result directly to the Mapbox route Source via applyRouteDisplayGeometry.
            // This never touches stableRouteSourcePath/React state on the hot path, so agent
            // movement cannot trigger a declarative re-render — but unlike the former
            // paint-only trim, the passed segment is now actually absent from the geometry,
            // not merely hidden behind a separately-mutated line-trim-offset.
            {
                const sourcePath = stableRouteSourcePathRef.current;
                const trimNow = Date.now();

                if (routeTrimRouteVersionRef.current !== routeVersionRef.current) {
                    const isIdentityChange = routeTrimSourceKeyRef.current !== routeSourceKeyRef.current;
                    routeTrimRouteVersionRef.current = routeVersionRef.current;
                    if (isIdentityChange) {
                        routeTrimSourceKeyRef.current = routeSourceKeyRef.current;
                        routeTrimProgressRef.current = 0;
                        lastRouteTrimDistanceMRef.current = 0;
                        lastRouteTrimPaintAtRef.current = 0;
                        hasSeededInitialRouteTrimRef.current = false;
                        seededRouteTrimVersionRef.current = null;
                    } else {
                        lastRouteTrimPaintAtRef.current = 0; // force recompute, preserve progress
                    }
                }

                if (sourcePath.length < 2) {
                    if (routeTrimProgressRef.current !== 0) {
                        routeTrimProgressRef.current = 0;
                        lastRouteTrimDistanceMRef.current = 0;
                        applyRouteDisplayGeometry([]);
                    }
                } else {
                    const trim = computeRouteTrimProgress(
                        nextVisual,
                        sourcePath,
                        ROUTE_TRIM_MAX_PROJECTION_DIST_M,
                    );

                    if (!trim) {
                    } else {
                        if (!hasSeededInitialRouteTrimRef.current || seededRouteTrimVersionRef.current !== routeVersionRef.current) {
                            seedInitialRouteTrim();
                        }

                        const previousProgress = routeTrimProgressRef.current;
                        const previousDistanceM = lastRouteTrimDistanceMRef.current;
                        const currentTrimGeometrySignature = lastRouteSourceSignatureRef.current;
                        const geometryBasisChanged = hasRouteTrimGeometryBasisChanged(
                            currentTrimGeometrySignature,
                            presentationShadowTrimBasisSignatureRef.current,
                        );
                        const clampedProgress = trim.progress < previousProgress
                            ? previousProgress
                            : trim.progress;
                        const clampedDistanceM = trim.distanceAlongRouteM < previousDistanceM
                            ? previousDistanceM
                            : trim.distanceAlongRouteM;
                        const nextTrimProgress = geometryBasisChanged ? trim.progress : clampedProgress;
                        const nextTrimDistanceM = geometryBasisChanged ? trim.distanceAlongRouteM : clampedDistanceM;
                        const progressDelta = Math.abs(nextTrimProgress - previousProgress);
                        const distanceDeltaM = Math.abs(nextTrimDistanceM - previousDistanceM);
                        const timeSinceLastPaintMs = lastRouteTrimPaintAtRef.current > 0
                            ? trimNow - lastRouteTrimPaintAtRef.current
                            : Infinity;
                        const shouldApplyTrim = shouldApplyRouteTrimPaint({
                            currentGeometrySignature: currentTrimGeometrySignature,
                            trimBasisSignature: presentationShadowTrimBasisSignatureRef.current,
                            lastPaintAtMs: lastRouteTrimPaintAtRef.current,
                            nowMs: trimNow,
                            distanceDeltaM,
                            progressDelta,
                            minAdvanceM: ROUTE_TRIM_MIN_ADVANCE_M,
                            minProgressDelta: ROUTE_TRIM_MIN_PROGRESS_DELTA,
                            paintIntervalMs: ROUTE_TRIM_PAINT_INTERVAL_MS,
                        });

                        if (shouldApplyTrim) {
                            // [afe.web.route_flicker] Only trim.segmentIndex/projectedPoint (this
                            // frame's fresh projection) is valid to physically clip against. When
                            // the fresh projection regressed and nextTrimDistanceM was clamped back
                            // to the previous value instead, the already-committed display geometry
                            // is still correct — treat as a successful no-op rather than clipping
                            // against a stale/foreign position.
                            const isFreshApplied = shouldCommitFreshProjection(trim.distanceAlongRouteM, previousDistanceM, geometryBasisChanged);
                            const applied = isFreshApplied
                                ? applyRouteDisplayGeometry(
                                    clipRoutePathAtProjection(sourcePath, trim.projectedPoint, trim.segmentIndex),
                                )
                                : true;
                            if (applied) {
                                routeTrimProgressRef.current = nextTrimProgress;
                                // Geometry basis this trim used.
                                presentationShadowTrimBasisSignatureRef.current = currentTrimGeometrySignature;
                                lastRouteTrimDistanceMRef.current = nextTrimDistanceM;
                                lastRouteTrimPaintAtRef.current = trimNow;
                            }
                        }
                    }
                }
            }

            // ── Visual marker bearing lerp ────────────────────────────────────
            // Lerp visualMarkerBearing toward targetMarkerBearing each frame using
            // dt-based smoothing. This ensures the arrow rotates smoothly even when
            // React renders (which update the target) are infrequent or irregular.
            {
                // M1.5R-D2: use integratorBearingDeg when in route mode so the arrow tracks
                // the marker's actual arc position, not the GPS-projection-segment bearing.
                // This eliminates early-rotation caused by GPS crossing the apex before the integrator.
                const msB = motionStateRef.current;
                const tBearing = (msB.integratorRouteProgressValid && msB.integratorRouteBearingSource === 'route')
                    ? msB.integratorBearingDeg
                    : targetMarkerBearingRef.current;
                const vBearing = visualMarkerBearingRef.current;
                const bDelta   = shortestBearingDelta(vBearing, tBearing); // -180..180
                let nextVisualBearing: number;
                if (Math.abs(bDelta) < MARKER_BEARING_VISUAL_DEAD_ZONE_DEG) {
                    nextVisualBearing = vBearing;
                } else {
                    const alpha = 1 - Math.exp(-dtMs / MARKER_BEARING_SMOOTH_TIME_MS);
                    nextVisualBearing = normalizeBearing(vBearing + bDelta * alpha);
                }
                visualMarkerBearingRef.current = nextVisualBearing;
                setVisualMarkerBearing(nextVisualBearing);
                // M0.5A: shadow marker bearing to MotionState
                motionStateRef.current.visualMarkerBearing = nextVisualBearing;
                motionStateRef.current.targetMarkerBearing = targetMarkerBearingRef.current;

            }

            // ── Camera follow (visual anchor) ────────────────────────────────
            if (isCameraFollowingRef.current && mapRef.current) {
                const isNav         = cameraModeRef.current === 'navigation_follow';
                let visualCameraBearing = visualCameraBearingRef.current;

                // ── Soft-follow ramp: 0→1 over SOFT_FOLLOW_DURATION_MS after MOVEMENT_DETECTED ─
                const softElapsedMs = softFollowStartAtRef.current > 0
                    ? now - softFollowStartAtRef.current
                    : Infinity;
                const softT    = Math.min(1, softElapsedMs / SOFT_FOLLOW_DURATION_MS);
                const easedT   = softT * softT * (3 - 2 * softT);
                const activeLookAheadM    = LOOK_AHEAD_M * easedT;
                const activePitch         = softFollowInitialPitchRef.current
                    + easedT * (NAV_FOLLOW_PITCH - softFollowInitialPitchRef.current);
                const activeZoom          = softFollowInitialZoomRef.current
                    + easedT * (NAV_FOLLOW_ZOOM  - softFollowInitialZoomRef.current);
                const activePaddingBottom = Math.round(CAMERA_NAV_BOTTOM_PAD_PX * easedT);

                if (isNav && softT >= 1 && softFollowStartAtRef.current > 0) {
                    softFollowStartAtRef.current = 0;
                }

                if (isNav) {
                    // M2-A: motion-aligned camera bearing; fallback to route geometry unchanged.
                    // M3-B1: getCameraBearing() no longer gates on velocity — target source now
                    // matches the marker lerp condition, preserving camera smoothing pipeline.
                    const selectedCam = getCameraBearing();
                    targetCameraBearingRef.current        = selectedCam.bearing;
                    targetCameraBearingSourceRef.current  = selectedCam.source;
                    targetCameraBearingSegmentRef.current = null;
                    motionStateRef.current.cameraBearingSource = selectedCam.source;
                    const currentVisual = Number.isFinite(visualCameraBearingRef.current)
                        ? visualCameraBearingRef.current
                        : (mapRef.current.getBearing() ?? mapHeadingRef.current ?? selectedCam.bearing);
                    const targetBearing = targetCameraBearingRef.current;
                    const turnDelta = shortestBearingDelta(currentVisual, targetBearing);

                    if (Math.abs(turnDelta) < CAMERA_TURN_DEAD_ZONE_DEG) {
                        visualCameraBearing = currentVisual;
                    } else {
                        const turnAlpha = 1 - Math.exp(-dtMs / CAMERA_TURN_SMOOTH_TIME_MS);
                        visualCameraBearing = normalizeBearing(currentVisual + turnDelta * turnAlpha);
                    }

                    visualCameraBearingRef.current = visualCameraBearing;
                    lastRequestedCameraBearingRef.current = targetBearing;
                    // M0.5A/C: shadow camera bearing to MotionState
                    motionStateRef.current.visualCameraBearing = visualCameraBearing;
                    motionStateRef.current.targetCameraBearing = targetCameraBearingRef.current;
                    motionStateRef.current.isTurning = Math.abs(turnDelta) > CAMERA_TURN_DEAD_ZONE_DEG;

                }

                const centerBearing = isNav ? visualCameraBearing : 0;
                const targetCenter  = isNav
                    ? computeLookAheadCenter(nextVisual, centerBearing, activeLookAheadM)
                    : nextVisual;
                // ── Camera center smoothing layer ────────────────────────────
                // Smoothly interpolate visualCameraCenter toward targetCenter each frame
                // using the same dt as the visual position loop. This prevents the camera
                // center from snapping when the lookAhead direction changes (e.g. during a turn).
                const prevCamCenter = visualCameraCenterRef.current;
                let smoothedCenter: LatLngPoint;
                if (!prevCamCenter) {
                    // First frame — initialize at target
                    smoothedCenter = targetCenter;
                } else {
                    const remainingM = distanceMeters(prevCamCenter, targetCenter);
                    if (remainingM < CAMERA_CENTER_EPSILON_M) {
                        smoothedCenter = targetCenter;
                    } else if (remainingM > CAMERA_CENTER_SNAP_DIST_M && softT < 1) {
                        // Soft-follow active — block snap to avoid jerk; use smooth lerp instead
                        const alpha = 1 - Math.exp(-dtMs / CAMERA_CENTER_SMOOTH_TIME_MS);
                        smoothedCenter = {
                            lat: prevCamCenter.lat + (targetCenter.lat - prevCamCenter.lat) * alpha,
                            lng: prevCamCenter.lng + (targetCenter.lng - prevCamCenter.lng) * alpha,
                        };
                    } else if (remainingM > CAMERA_CENTER_SNAP_DIST_M) {
                        // Large jump after soft-follow completes — snap to avoid runaway lag
                        smoothedCenter = targetCenter;
                    } else {
                        const alpha = 1 - Math.exp(-dtMs / CAMERA_CENTER_SMOOTH_TIME_MS);
                        smoothedCenter = {
                            lat: prevCamCenter.lat + (targetCenter.lat - prevCamCenter.lat) * alpha,
                            lng: prevCamCenter.lng + (targetCenter.lng - prevCamCenter.lng) * alpha,
                        };
                    }
                }
                visualCameraCenterRef.current = smoothedCenter;
                // M0.5A/C: shadow camera center to MotionState (always, even during bearing ease)
                motionStateRef.current.visualCameraCenter = smoothedCenter;

                if (isModeTransitionRef.current) {
                    // 1500ms mode-transition easeTo is running — do NOT call jumpTo at all.
                    // jumpTo would cancel the transition animation. visualCameraCenterRef is
                    // updated in memory above; modeTransitionTimeoutRef callback will sync from
                    // map.getCenter() when the transition completes.
                } else if (isBearingEasingRef.current) {
                    // Bearing easeTo running — do NOT call jumpTo (would cancel easeTo bearing).
                    // visualCameraCenterRef is updated in memory each frame so it tracks the
                    // target continuously. bearingEaseTimeoutRef callback will sync from
                    // map.getCenter() when the ease completes, anchoring the next follow frame.
                } else {
                    // M0.5C: read center and bearing from MotionState (behavior-equivalent mirror)
                    const msCenter  = motionStateRef.current.visualCameraCenter;
                    const msBearing = motionStateRef.current.visualCameraBearing;
                    mapRef.current.jumpTo({
                        center: [msCenter.lng, msCenter.lat],
                        ...(isNav ? {
                            pitch:   activePitch,
                            zoom:    activeZoom,
                            bearing: msBearing,
                            padding: { top: 0, bottom: activePaddingBottom, left: 0, right: 0 },
                        } : {
                            padding: { top: 0, bottom: 0, left: 0, right: 0 },
                        }),
                    });
                    if (isNav) {
                        const actualAfterJump = mapRef.current.getBearing() ?? visualCameraBearing;
                        lastAppliedCameraBearingRef.current = actualAfterJump;
                    }
                }
            }

            visualAnimFrameRef.current = requestAnimationFrame(runFrame);
        };

        visualAnimFrameRef.current = requestAnimationFrame(runFrame);

        return () => {
            isVisualLoopRunningRef.current = false;
            if (visualAnimFrameRef.current !== null) {
                cancelAnimationFrame(visualAnimFrameRef.current);
                visualAnimFrameRef.current = null;
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    type RouteUpBearingCandidate = {
        bearing: number;
        source: RouteUpBearingSource;
        segmentIndex?: number;
        from?: LatLngPoint;
        to?: LatLngPoint;
    };

    // Route geometry bearing without wrong-way override. Used by wrong-way detection itself.
    // Priority: locked projection segment > rendered route tangent > raw path start > GPS > fallback.
    const getRouteGeometryBearingCandidate = (): RouteUpBearingCandidate => {
        const currentPath = pathRef.current;
        const lockedProj  = lastProjectionRef.current;

        if (
            lockedProj &&
            lockedProj.routeVersion === routeVersionRef.current &&
            lockedProj.routePathLen === currentPath.length &&
            lockedProj.segmentIndex < currentPath.length - 1
        ) {
            const from = currentPath[lockedProj.segmentIndex];
            const to   = currentPath[lockedProj.segmentIndex + 1];
            return {
                bearing: computeBearingBetween(from, to),
                source: 'locked_projection_segment',
                segmentIndex: lockedProj.segmentIndex,
                from,
                to,
            };
        }

        const rendered = renderedRoutePathRef.current;
        if (rendered.length >= 2) {
            return {
                bearing: computeBearingBetween(rendered[0], rendered[1]),
                source: 'rendered_route_tangent',
                from: rendered[0],
                to: rendered[1],
            };
        }

        if (currentPath.length >= 2) {
            return {
                bearing: computeBearingBetween(currentPath[0], currentPath[1]),
                source: 'path_start_tangent',
                from: currentPath[0],
                to: currentPath[1],
            };
        }

        if (hasNavigationBearingRef.current && Number.isFinite(prevHeadingRef.current)) {
            return { bearing: normalizeBearing(prevHeadingRef.current), source: 'gps' };
        }

        return { bearing: normalizeBearing(prevHeadingRef.current ?? 0), source: 'fallback' };
    };

    // Unified bearing source for camera route-up. Wrong-way is a visual-only override.
    const getRouteUpBearingCandidate = (): RouteUpBearingCandidate => {
        if (
            wrongWayRef.current
            && cameraModeRef.current === 'navigation_follow'
            && isCameraFollowingRef.current
            && lastMovementBearingRef.current !== null
            && Number.isFinite(lastMovementBearingRef.current)
        ) {
            return {
                bearing: normalizeBearing(lastMovementBearingRef.current),
                source: 'wrong_way_movement_bearing',
            };
        }

        return getRouteGeometryBearingCandidate();
    };

    // M2-A: Motion-aligned camera bearing selector.
    // In steady-state route-valid navigation, uses integratorBearingDeg so the camera
    // pan tracks the same arc reference as the marker body. Falls back to
    // getRouteUpBearingCandidate() for wrong-way, startup, GPS-degraded, and Euclidean modes.
    // M3-B1: removed the integratorVelocityMps > 0.5 gate so the camera bearing target
    // stays on integratorBearingDeg during slow turns — matching the marker lerp condition
    // which also has no velocity threshold.
    const getCameraBearing = (): { bearing: number; source: RouteUpBearingSource } => {
        const ms = motionStateRef.current;
        if (
            !wrongWayRef.current
            && ms.integratorRouteProgressValid
            && ms.integratorRouteBearingSource === 'route'
        ) {
            return { bearing: normalizeBearing(ms.integratorBearingDeg), source: 'integrator' };
        }
        const candidate = getRouteUpBearingCandidate();
        return { bearing: normalizeBearing(candidate.bearing), source: candidate.source };
    };

    const getNavigationBearing = (fallbackBearing = prevHeadingRef.current) => {
        const candidate = getRouteUpBearingCandidate();
        if (candidate.source !== 'gps' && candidate.source !== 'fallback') {
            return candidate.bearing;
        }
        if (hasNavigationBearingRef.current && Number.isFinite(prevHeadingRef.current)) {
            return normalizeBearing(prevHeadingRef.current);
        }
        return normalizeBearing(Number.isFinite(fallbackBearing) ? fallbackBearing : 0);
    };

    const getMarkerWorldBearingCandidate = (): {
        bearing: number;
        source: MarkerBearingSource;
        segmentIndex: number | null;
    } => {
        if (
            wrongWayRef.current
            && lastMovementBearingRef.current !== null
            && Number.isFinite(lastMovementBearingRef.current)
        ) {
            return {
                bearing: normalizeBearing(lastMovementBearingRef.current),
                source: 'wrong_way_movement_bearing',
                segmentIndex: null,
            };
        }

        const currentPath = pathRef.current;
        const lockedProjection = lastProjectionRef.current;

        if (
            lockedProjection
            && lockedProjection.routeVersion === routeVersionRef.current
            && lockedProjection.routePathLen === currentPath.length
            && lockedProjection.segmentIndex < currentPath.length - 1
        ) {
            return {
                bearing: computeBearingBetween(
                    currentPath[lockedProjection.segmentIndex],
                    currentPath[lockedProjection.segmentIndex + 1],
                ),
                source: 'route_tangent',
                segmentIndex: lockedProjection.segmentIndex,
            };
        }

        const visualProjection = projectPointToRoute(visualAgentPositionRef.current, currentPath);
        if (
            visualProjection
            && visualProjection.distanceM <= AGENT_PROJECTION_MAX_DIST_M
            && visualProjection.segmentIndex < currentPath.length - 1
        ) {
            return {
                bearing: computeBearingBetween(
                    currentPath[visualProjection.segmentIndex],
                    currentPath[visualProjection.segmentIndex + 1],
                ),
                source: 'route_tangent',
                segmentIndex: visualProjection.segmentIndex,
            };
        }

        const rendered = renderedRoutePathRef.current;
        if (rendered.length >= 2) {
            return {
                bearing: computeBearingBetween(rendered[0], rendered[1]),
                source: 'route_tangent',
                segmentIndex: null,
            };
        }

        if (
            lastMovementBearingRef.current !== null
            && Number.isFinite(lastMovementBearingRef.current)
        ) {
            return {
                bearing: normalizeBearing(lastMovementBearingRef.current),
                source: 'movement_bearing',
                segmentIndex: null,
            };
        }

        if (hasNavigationBearingRef.current && Number.isFinite(prevHeadingRef.current)) {
            return {
                bearing: normalizeBearing(prevHeadingRef.current),
                source: 'gps',
                segmentIndex: null,
            };
        }

        return {
            bearing: normalizeBearing(mapHeadingRef.current ?? 0),
            source: 'fallback',
            segmentIndex: null,
        };
    };

    const updateTargetCameraBearing = (): RouteUpBearingCandidate => {
        const candidate = getRouteUpBearingCandidate();
        const nextTarget = normalizeBearing(candidate.bearing);

        targetCameraBearingRef.current = nextTarget;
        targetMarkerBearingRef.current = nextTarget;   // M1: unify bearing targets — both lerps converge to same value
        targetCameraBearingSourceRef.current = candidate.source;
        targetCameraBearingSegmentRef.current = candidate.segmentIndex ?? null;

        return candidate;
    };

    const computeAndLogLookAheadCenter = (
        agentPos: LatLngPoint,
        bearing: number,
    ) => {
        const lookAheadCenter = computeLookAheadCenter(agentPos, bearing, LOOK_AHEAD_M);

        return lookAheadCenter;
    };

    // ── Phase 3: User camera override (free-explore) ─────────────────────────
    const applyUserCameraOverride = () => {
        const isCameraFollowingBefore = isCameraFollowingRef.current;
        const isNavigationActive = pathRef.current.length >= 2 || routeVersionRef.current > 0;

        if (!isNavigationActive) {
            return;
        }

        if (!isCameraFollowingBefore && userCameraOverrideRef.current) {
            return;
        }

        // Cancel soft-follow ramp — user now owns the camera
        if (softFollowStartAtRef.current > 0) {
            softFollowStartAtRef.current = 0;
        }

        // Apply override — ref first for immediate rAF guard
        isCameraFollowingRef.current = false;
        setIsCameraFollowing(false);
        userCameraOverrideRef.current = true;
        hasUserExploredMapRef.current = true;
        setHasUserExploredMap(true);

        // Cancel any in-flight bearing ease — user now owns the camera
        if (bearingEaseTimeoutRef.current !== null) {
            clearTimeout(bearingEaseTimeoutRef.current);
            bearingEaseTimeoutRef.current = null;
        }
        isBearingEasingRef.current = false;

    };

    // Helper: check if map event is user-initiated (has originalEvent)
    const isUserGesture = (e: { originalEvent?: any }): boolean => {
        return !!(e.originalEvent);
    };

    const handleUserGestureEvent = (reason: string, e: { originalEvent?: any }) => {
        const hasOE = isUserGesture(e);
        if (!hasOE) {
            return;
        }

        applyUserCameraOverride();
    };

    const isMapCanvasTouchTarget = (target: EventTarget | null) => {
        const element = target as HTMLElement | null;
        return element?.tagName === 'CANVAS';
    };

    const clearPendingTouch = () => {
        pendingTouchRef.current = null;
    };

    const handleMapTouchStart = (e: React.TouchEvent) => {
        if (!isMapCanvasTouchTarget(e.target)) return;
        const firstTouch = e.touches[0];
        if (!firstTouch) return;

        pendingTouchRef.current = {
            active: true,
            startX: firstTouch.clientX,
            startY: firstTouch.clientY,
            startTime: Date.now(),
            touchCount: e.touches.length,
        };

    };

    const handleMapTouchMove = (e: React.TouchEvent) => {
        const pending = pendingTouchRef.current;
        if (!pending?.active) return;

        const firstTouch = e.touches[0];
        if (!firstTouch) return;

        const dx = firstTouch.clientX - pending.startX;
        const dy = firstTouch.clientY - pending.startY;
        const distancePx = Math.sqrt(dx * dx + dy * dy);
        const touchCount = e.touches.length;

        if (touchCount >= 2) {
            applyUserCameraOverride();
            clearPendingTouch();
            return;
        }

        if (distancePx >= USER_GESTURE_MOVE_THRESHOLD_PX) {
            applyUserCameraOverride();
            clearPendingTouch();
        }
    };

    const cancelPendingTouchWithoutOverride = () => {
        const pending = pendingTouchRef.current;
        if (!pending?.active) return;

        clearPendingTouch();
    };

    const handleMapTouchEnd = () => {
        cancelPendingTouchWithoutOverride();
    };

    const handleMapTouchCancel = () => {
        cancelPendingTouchWithoutOverride();
    };

    // Smooth camera bearing rotation — called from watchPosition and path-update trigger.
    // Dead zone is compared against actual map.getBearing() (not stale lastAppliedCameraBearingRef)
    // so an interrupted easeTo does not permanently block retries.
    const applyCameraBearing = (targetBearing: number) => {
        if (!mapRef.current || cameraModeRef.current !== 'navigation_follow') {
            return;
        }
        if (!isCameraFollowingRef.current) {
            return;
        }
        // Mode transition owns the camera for 1500ms — do not interrupt with a bearing ease
        if (isModeTransitionRef.current) {
            return;
        }

        const normalizedTarget = normalizeBearing(targetBearing);
        targetCameraBearingRef.current = normalizedTarget;
        // Use actual Mapbox bearing as source of truth for the dead-zone check.
        // lastAppliedCameraBearingRef is now only updated after a verified ease — it is NOT
        // used for the dead zone, preventing a stale pre-set value from permanently blocking retries.
        const actualBearing = mapRef.current.getBearing() ?? mapHeadingRef.current ?? lastAppliedCameraBearingRef.current ?? 0;
        const delta = shortestBearingDelta(actualBearing, normalizedTarget);
        const absDelta = Math.abs(delta);


        if (absDelta < CAMERA_BEARING_DEAD_ZONE_DEG) {
            return;
        }

        if (bearingEaseTimeoutRef.current !== null) clearTimeout(bearingEaseTimeoutRef.current);
        isBearingEasingRef.current = true;
        lastRequestedCameraBearingRef.current = normalizedTarget; // record intent — NOT applied yet


        mapRef.current.easeTo({
            bearing:  normalizedTarget,
            duration: CAMERA_BEARING_EASE_MS,
        });

        bearingEaseTimeoutRef.current = setTimeout(() => {
            isBearingEasingRef.current = false;
            bearingEaseTimeoutRef.current = null;
            if (mapRef.current) {
                const mc = mapRef.current.getCenter();
                visualCameraCenterRef.current = { lat: mc.lat, lng: mc.lng };
                const actualAfter = mapRef.current.getBearing();
                // Update lastAppliedCameraBearingRef with the ACTUAL bearing — never the target
                lastAppliedCameraBearingRef.current = actualAfter;
                visualCameraBearingRef.current = actualAfter;
                // M0.5A/C: sync MotionState after bearing ease completes
                motionStateRef.current.visualCameraCenter  = { lat: mc.lat, lng: mc.lng };
                motionStateRef.current.visualCameraBearing = actualAfter;
            }
        }, CAMERA_BEARING_EASE_MS + 50);
    };

    // Soft-follow seed — fires exactly once when movement first detected.
    // Replaces the old heavy easeTo with a ref-seed so the rAF loop ramps smoothly.
    useEffect(() => {
        if (cameraMode !== 'navigation_follow' || !mapRef.current) return;

        // Cancel any in-flight bearing ease or prior mode transition (safety)
        if (bearingEaseTimeoutRef.current !== null) {
            clearTimeout(bearingEaseTimeoutRef.current);
            bearingEaseTimeoutRef.current = null;
        }
        if (modeTransitionTimeoutRef.current !== null) {
            clearTimeout(modeTransitionTimeoutRef.current);
            modeTransitionTimeoutRef.current = null;
        }

        // Seed camera refs from the map's current state so rAF starts from exactly
        // where the camera is right now — no jump, no easeTo.
        const mc = mapRef.current.getCenter();
        visualCameraCenterRef.current = { lat: mc.lat, lng: mc.lng };

        const actualBearing = mapRef.current.getBearing() ?? mapHeadingRef.current ?? 0;
        lastAppliedCameraBearingRef.current = actualBearing;
        visualCameraBearingRef.current = actualBearing;
        lastRequestedCameraBearingRef.current = actualBearing;
        targetCameraBearingRef.current = normalizeBearing(actualBearing);

        // Seed soft-follow initial camera state for the ramp
        softFollowInitialPitchRef.current = mapRef.current.getPitch() ?? 0;
        softFollowInitialZoomRef.current  = mapRef.current.getZoom()  ?? NAV_FOLLOW_ZOOM;
        softFollowInitialPaddingBottomRef.current = 0; // top_down has no bottom padding
        softFollowStartAtRef.current = performance.now();

        // Allow rAF to start jumpTo immediately — no transition lock
        isBearingEasingRef.current  = false;
        isModeTransitionRef.current = false;

    }, [cameraMode]); // eslint-disable-line react-hooks/exhaustive-deps

    // Route-update bearing alignment — feed the continuous rAF turn smoother.
    // Do not call easeTo here; polling cadence would make route-up rotation happen in chunks.
    useEffect(() => {
        if (path.length < 2) return;
        if (cameraModeRef.current !== 'navigation_follow') return;
        updateTargetCameraBearing();
    }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Marker bearing — locked route tangent is primary, GPS is fallback only.
    const markerBearingInfo = useMemo<StableMarkerBearingInfo>(() => {
        const rawInfo = getMarkerWorldBearingCandidate();

        const rawBearing = normalizeBearing(rawInfo.bearing);
        const previous = lastMarkerBearingRef.current;
        if (!previous || previous.source !== rawInfo.source) {
            const initial = {
                bearing: rawBearing,
                source: rawInfo.source,
                segmentIndex: rawInfo.segmentIndex,
                rawBearing,
                delta: 0,
                skippedSmallDelta: false,
            };
            lastMarkerBearingRef.current = initial;
            return initial;
        }

        const delta = shortestBearingDelta(previous.bearing, rawBearing);
        if (Math.abs(delta) < MARKER_BEARING_DEAD_ZONE_DEG) {
            const stabilized = {
                bearing: previous.bearing,
                source: rawInfo.source,
                segmentIndex: rawInfo.segmentIndex,
                rawBearing,
                delta,
                skippedSmallDelta: true,
            };
            lastMarkerBearingRef.current = stabilized;
            return stabilized;
        }

        const appliedBearing = normalizeBearing(rawBearing); // M1: removed pre-damping (was delta*0.35); rAF T=300ms owns all smoothing
        const stabilized = {
            bearing: appliedBearing,
            source: rawInfo.source,
            segmentIndex: rawInfo.segmentIndex,
            rawBearing,
            delta,
            skippedSmallDelta: false,
        };
        lastMarkerBearingRef.current = stabilized;
        return stabilized;
    }, [displayAgentPosition, hasGpsHeading, gpsHeading, isWrongWay, mapHeading, path, renderedRoutePath, routeVersion]);

    // ── Sync targetMarkerBearingRef from markerBearingInfo ──────────────────
    // Runs on React render cadence; rAF loop then lerps visualMarkerBearing toward this target.
    // Initialises visualMarkerBearingRef on first sync so the first rAF frame starts from
    // the correct bearing (not 0°).
    useEffect(() => {
        const newTarget = normalizeBearing(markerBearingInfo.bearing);
        const prevTarget = targetMarkerBearingRef.current;

        targetMarkerBearingRef.current = newTarget;

        // Also seed visual ref on first mount so there is no 0→target sweep at startup
        if (visualMarkerBearingRef.current === 0 && prevTarget === 0) {
            visualMarkerBearingRef.current = newTarget;
            setVisualMarkerBearing(newTarget);
        }

    }, [markerBearingInfo]); // eslint-disable-line react-hooks/exhaustive-deps

    // When the user leaves active follow, refresh marker world bearing immediately.
    // Free-explore renders marker rotation in map/world coordinates, so it must not
    // inherit a stale visual bearing from the route-up transition state.
    useEffect(() => {
        const wasFollowing = prevIsCameraFollowingForMarkerRef.current;
        prevIsCameraFollowingForMarkerRef.current = isCameraFollowing;
        if (!wasFollowing || isCameraFollowing) return;

        const candidate = getMarkerWorldBearingCandidate();
        const refreshedBearing = normalizeBearing(candidate.bearing);

        targetMarkerBearingRef.current = refreshedBearing;
        visualMarkerBearingRef.current = refreshedBearing;
        setVisualMarkerBearing(refreshedBearing);

    }, [isCameraFollowing]); // eslint-disable-line react-hooks/exhaustive-deps

    // Production target bootstrap: identity comes from /location query.
    useEffect(() => {
        if (pollingUsersId === null || pollingTakecareId === null) return;

        const pollingService = new AdaptivePollingService(
            pollingUsersId,
            pollingTakecareId,
            (location) => {
                if (!location.latitude || !location.longitude) return;

                const nextTarget: TargetReference = {
                    lat: Number(location.latitude),
                    lng: Number(location.longitude),
                    targetSampleId: location.targetSampleId,
                };

                appendResearchProvenanceEvent({
                    event: 'target_received',
                    system_version: 'V3',
                    target_sample_id: nextTarget.targetSampleId,
                    target_ref_lat: nextTarget.lat,
                    target_ref_lng: nextTarget.lng,
                });

                setPatientLocation(nextTarget);

                // First Production target sample seeds presentation directly.
                // This prevents interpolation from the invalid 0/0 sentinel.
                if (!hasRealTargetPositionRef.current) {
                    hasRealTargetPositionRef.current = true;
                    setHasRealTargetPosition(true);
                    setVisualPatientLocation(nextTarget);

                    markerSmoothingDecisionRef.current = {
                        deadZoneTriggered: false,
                        animationState: 'initial',
                        previousVisual: nextTarget,
                        nextVisual: nextTarget,
                        rawToVisualBeforeM: 0,
                        rawToVisualAfterM: 0,
                    };
                }
            },
        );

        pollingService.start();
        return () => pollingService.stop();
    }, [pollingUsersId, pollingTakecareId]);

    useEffect(() => {
        setVisualPatientLocation((previous) => {
            const deltaM = distanceMeters(previous, patientLocation);
            if (!Number.isFinite(deltaM)) {
                markerSmoothingDecisionRef.current = {
                    deadZoneTriggered: false,
                    animationState: 'snap_invalid',
                    previousVisual: previous,
                    nextVisual: patientLocation,
                    rawToVisualBeforeM: null,
                    rawToVisualAfterM: 0,
                };
                return patientLocation;
            }
            if (deltaM <= PATIENT_MARKER_DEAD_ZONE_M) {
                markerSmoothingDecisionRef.current = {
                    deadZoneTriggered: true,
                    animationState: 'dead_zone_hold',
                    previousVisual: previous,
                    nextVisual: previous,
                    rawToVisualBeforeM: deltaM,
                    rawToVisualAfterM: deltaM,
                };
                return previous;
            }
            if (deltaM >= PATIENT_MARKER_MAX_JUMP_M) {
                markerSmoothingDecisionRef.current = {
                    deadZoneTriggered: false,
                    animationState: 'snap_large_jump',
                    previousVisual: previous,
                    nextVisual: patientLocation,
                    rawToVisualBeforeM: deltaM,
                    rawToVisualAfterM: 0,
                };
                return patientLocation;
            }

            const nextVisual = {
                lat: previous.lat + (patientLocation.lat - previous.lat) * PATIENT_MARKER_INTERP_ALPHA,
                lng: previous.lng + (patientLocation.lng - previous.lng) * PATIENT_MARKER_INTERP_ALPHA,
            };
            markerSmoothingDecisionRef.current = {
                deadZoneTriggered: false,
                animationState: 'interpolating',
                previousVisual: previous,
                nextVisual,
                rawToVisualBeforeM: deltaM,
                rawToVisualAfterM: distanceMeters(nextVisual, patientLocation),
            };
            return nextVisual;
        });
    }, [patientLocation]);

    // Production entry bootstrap.
    // Wait until session restoration has been resolved and both Production
    // identity-bound target data and a real GPS sample are available.
    useEffect(() => {
        if (!restoreChecked) return;
        if (pollingUsersId === null || pollingTakecareId === null) return;
        if (!hasRealGpsPosition || !hasRealTargetPosition) return;
        // Research-only startup gate: run_start must exist before initial /init.
        if (researchLogger.status !== 'RECORDING') return;
        if (sessionId || status !== 'idle') return;
        if (initInFlightRef.current) return;

        const attemptKey = `${pollingUsersId}:${pollingTakecareId}`;
        if (initAttemptKeyRef.current === attemptKey) return;

        initInFlightRef.current = true;
        initAttemptKeyRef.current = attemptKey;

        void (async () => {
            try {
                await start(
                    {
                        lat: currentPosition.lat,
                        lng: currentPosition.lng,
                    },
                    {
                        lat: patientLocation.lat,
                        lng: patientLocation.lng,
                        targetSampleId: patientLocation.targetSampleId,
                    },
                );
            } finally {
                initInFlightRef.current = false;
            }
        })();
    }, [
        currentPosition,
        patientLocation,
        pollingTakecareId,
        pollingUsersId,
        hasRealGpsPosition,
        hasRealTargetPosition,
        researchLogger.status,
        restoreChecked,
        sessionId,
        start,
        status,
    ]);

    // Feed only real Production positions into an active navigation session.
    useEffect(() => {
        if (pollingUsersId === null || pollingTakecareId === null) return;
        if (!hasRealGpsPosition || !hasRealTargetPosition) return;
        if (!sessionId || status !== 'active') return;

        updatePositions(
            {
                lat: currentPosition.lat,
                lng: currentPosition.lng,
            },
            {
                lat: patientLocation.lat,
                lng: patientLocation.lng,
                targetSampleId: patientLocation.targetSampleId,
            },
        );
    }, [
        currentPosition,
        patientLocation,
        pollingTakecareId,
        pollingUsersId,
        hasRealGpsPosition,
        hasRealTargetPosition,
        sessionId,
        status,
        updatePositions,
    ]);

    const resetArrivalState = useCallback(() => {
        if (arrivalCandidateTimeoutRef.current) {
            clearTimeout(arrivalCandidateTimeoutRef.current);
            arrivalCandidateTimeoutRef.current = null;
        }
        arrivalCandidateStartedAtRef.current = 0;
        hasArrivedRef.current = false;
        setHasArrived(false);
        setArrivalDistance(null);
    }, []);

    // Reset speed estimation refs when navigation starts a new session so stale
    // speed/position from a previous session cannot inflate dynamic thresholds.
    const resetVisualAgentSpeedRefs = useCallback(() => {
        latestAgentSpeedMpsRef.current       = 0;
        estimatedAgentSpeedMpsRef.current    = 0;
        lastGpsPositionForSpeedRef.current   = null;
        lastGpsPositionAtMsRef.current       = 0;
    }, []);

    useEffect(() => {
        if (status === 'loading' || status === 'idle' || status === 'error') {
            const resetKey = `${status}:${routeVersion}`;
            if (lastArrivalResetKeyRef.current !== resetKey) {
                lastArrivalResetKeyRef.current = resetKey;
                resetArrivalState();
                resetVisualAgentSpeedRefs();
            }
        }
    }, [status, routeVersion, resetArrivalState, resetVisualAgentSpeedRefs]);

    useEffect(() => {
        if (status !== 'active' && status !== 'arrived') return;

        const agentPos = visualAgentPositionRef.current || displayPositionRef.current || currentPosition;
        const distanceToTarget = distanceMeters(agentPos, patientLocation);
        if (!Number.isFinite(distanceToTarget)) return;

        setArrivalDistance(distanceToTarget);

        if (hasArrivedRef.current || status === 'arrived') {
            if (!hasArrivedRef.current || !hasArrived) {
                hasArrivedRef.current = true;
                setHasArrived(true);
            }
            return;
        }

        const now = performance.now();
        if (distanceToTarget <= NAV_ARRIVAL_REACHED_THRESHOLD_M) {
            if (!arrivalCandidateStartedAtRef.current) {
                arrivalCandidateStartedAtRef.current = now;
            }

            if (!arrivalCandidateTimeoutRef.current) {
                arrivalCandidateTimeoutRef.current = setTimeout(() => {
                    arrivalCandidateTimeoutRef.current = null;
                    const latestAgentPos = visualAgentPositionRef.current || displayPositionRef.current || currentPosition;
                    const latestDistanceToTarget = distanceMeters(latestAgentPos, patientLocation);
                    const candidateDurationMs = performance.now() - arrivalCandidateStartedAtRef.current;

                    if (
                        !hasArrivedRef.current
                        && arrivalCandidateStartedAtRef.current
                        && latestDistanceToTarget <= NAV_ARRIVAL_REACHED_THRESHOLD_M
                        && candidateDurationMs >= 3000
                    ) {
                        hasArrivedRef.current = true;
                        setHasArrived(true);
                        setArrivalDistance(latestDistanceToTarget);
                        markArrived();

                    }
                }, 3000);
            }
            return;
        }

        if (distanceToTarget > NAV_ARRIVAL_NEAR_THRESHOLD_M && arrivalCandidateStartedAtRef.current) {
            arrivalCandidateStartedAtRef.current = 0;
            if (arrivalCandidateTimeoutRef.current) {
                clearTimeout(arrivalCandidateTimeoutRef.current);
                arrivalCandidateTimeoutRef.current = null;
            }
        }
    }, [currentPosition, patientLocation, status, markArrived, hasArrived]);

    useEffect(() => {
        return () => {
            if (arrivalCandidateTimeoutRef.current) {
                clearTimeout(arrivalCandidateTimeoutRef.current);
                arrivalCandidateTimeoutRef.current = null;
            }
        };
    }, []);

    // แปลงข้อมูล eta และ distance เพื่อนำไปแสดงผล UI
    useEffect(() => {
        const safeDistance = Number(distance) || 0;
        const safeEta = Number(eta) || 0;

        setTotalDistance(safeDistance);

        const totalMinutes = Math.max(0, Math.ceil(safeEta / 60)) || 0;
        if (totalMinutes >= 60) {
            setDurationHrs(Math.floor(totalMinutes / 60));
            setDurationMins(totalMinutes % 60);
        } else {
            setDurationHrs(0);
            setDurationMins(totalMinutes);
        }

        if (safeEta > 0) {
            const arrival = new Date(Date.now() + safeEta * 1000);
            setArrivalTime(`${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')}`);
        } else {
            setArrivalTime("--:--");
        }
    }, [eta, distance]);

    const navigationDistanceDisplay = useMemo(() => {
        const routeRemainingDistance = Number.isFinite(totalDistance) ? Math.max(0, totalDistance) : 0;
        const distanceToTarget = typeof arrivalDistance === 'number' && Number.isFinite(arrivalDistance)
            ? Math.max(0, arrivalDistance)
            : null;
        const isNearArrival = distanceToTarget !== null && distanceToTarget <= NAV_ARRIVAL_NEAR_THRESHOLD_M;
        const displayRemainingDistance = isNearArrival
            ? Math.max(1, distanceToTarget)
            : routeRemainingDistance;

        return {
            routeRemainingDistance,
            distanceToTarget,
            isNearArrival,
            displayRemainingDistance,
            source: isNearArrival ? "targetDistance" : "routeRemainingDistance",
        };
    }, [totalDistance, arrivalDistance]);

    // GUIDANCE_ROUTE_AUTHORITY: this is the exact same runtime selection used by
    // getMotionRoute() inside the rAF integrator above. Maneuvers are projected
    // only when their paired backend route exactly matches this geometry.
    const guidanceRoute = stableRouteSourcePathRef.current.length >= 2
        ? stableRouteSourcePathRef.current
        : pathRef.current;
    const projectGuidancePointToProgress = useCallback((point: LatLngPoint, route: LatLngPoint[]) => {
        const projection = projectPointToRoute(point, route);
        return projection
            ? computeRouteProgressFromProjection(projection.segmentIndex, projection.t, route)
            : null;
    }, []);
    const motionGuidanceState = motionStateRef.current;
    const guidance = useNavigationGuidance({
        sessionId,
        maneuverRoute,
        activeRoute: guidanceRoute,
        agentProgressM: motionGuidanceState.integratorRouteProgressM,
        agentProgressValid: motionGuidanceState.integratorRouteProgressValid,
        status,
        routeUxState,
        hasArrived,
        isNearArrival: navigationDistanceDisplay.isNearArrival,
        projectPointToProgress: projectGuidancePointToProgress,
    });

    const topBannerInstruction = resolveNavigationTopBarPresentation({
        status,
        hasArrived,
        isNearArrival: navigationDistanceDisplay.isNearArrival,
        nearArrivalDistanceM: navigationDistanceDisplay.isNearArrival
            ? navigationDistanceDisplay.displayRemainingDistance
            : null,
        remainingDistanceM: navigationDistanceDisplay.routeRemainingDistance,
        guidance,
    });

    const handleRetryInitRoute = useCallback(() => {
        start(currentPosition, patientLocation);
    }, [currentPosition, patientLocation, start]);

    const routeUxBanner = resolveRouteUxBanner(routeUxState);
    const maneuverPresentationOwned = routeUxBanner === null
        && topBannerInstruction.source === 'currentManeuver';
    const voiceManeuver = guidance.currentManeuver
        && guidance.instruction
        && guidance.distanceToManeuverM !== null
        ? {
            type: guidance.currentManeuver.maneuver.type,
            location: guidance.currentManeuver.maneuver.location,
            instructionText: guidance.instruction,
            distanceToManeuverM: guidance.distanceToManeuverM,
        }
        : null;
    const { cancelSpeech } = useNavigationVoice({
        sessionId,
        freshStartSequence,
        guidanceAvailable: guidance.availability === 'available',
        maneuverPresentationOwned,
        currentManeuver: voiceManeuver,
        nearArrival: navigationDistanceDisplay.isNearArrival,
        arrived: status === 'arrived' || hasArrived,
        soundEnabled: isSoundOn,
        nowMs: Date.now(),
    });

    const topBannerManeuverIcon = useMemo(() => {
        if (routeUxBanner || topBannerInstruction.source !== 'currentManeuver') return ArrowUp;
        switch (guidance.semanticType) {
            case 'TURN_LEFT': return CornerUpLeft;
            case 'TURN_RIGHT': return CornerUpRight;
            case 'SLIGHT_LEFT': return MoveUpLeft;
            case 'SLIGHT_RIGHT': return MoveUpRight;
            case 'UTURN': return Undo2;
            default: return ArrowUp;
        }
    }, [guidance.semanticType, routeUxBanner, topBannerInstruction.source]);

    const lastMileLabel = useMemo(() => {
        if (status === 'arrived' || hasArrived) return null;
        if (path.length < 2) return null;

        const routeEndpoint = path[path.length - 1];
        const lastMileDistanceM = distanceMeters(routeEndpoint, patientLocation);
        if (!Number.isFinite(lastMileDistanceM) || lastMileDistanceM < LAST_MILE_LABEL_THRESHOLD_M) {
            return null;
        }

        return `อีกประมาณ ${Math.round(lastMileDistanceM)} เมตรจากปลายเส้นทาง`;
    }, [hasArrived, path, patientLocation, status]);

    // 3. ติดตามพิกัดตัวเรา (Watch Position)
    // dependency = [] intentionally — uses refs (hasStartedMovingRef, cameraModeRef)
    // to avoid recreating the watch every time movement state changes.
    useEffect(() => {
        if (!navigator.geolocation) return;
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const newPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                setCurrentPosition(newPos);
                setGpsError(false);

                // First real GPS sample seeds presentation state before the
                // Production map becomes ready.
                if (!hasRealGpsPositionRef.current) {
                    hasRealGpsPositionRef.current = true;
                    setHasRealGpsPosition(true);

                    setDisplayAgentPosition(newPos);
                    lastDisplayAgentPositionRef.current = newPos;

                    setVisualAgentPosition(newPos);
                    visualAgentPositionRef.current = newPos;
                    snappedAgentTargetRef.current = newPos;

                    displayPositionRef.current = newPos;
                    motionStateRef.current = createInitialMotionState(newPos);
                }

                // Use raw GPS position only — backend already trims route
                const fusedPosition = newPos;

                // M0.5A / M1: shadow GPS layer to MotionState; update displayPositionRef at GPS cadence
                motionStateRef.current.rawGpsPosition = fusedPosition;
                motionStateRef.current.lastGpsAt      = performance.now();
                displayPositionRef.current = fusedPosition; // M1: no inner lerp; ref stays current at GPS rate

                // M1: projection + snappedAgentTargetRef update moved to main rAF loop.
                // onGpsUpdate / onProjectionUpdated are called there after each GPS-triggered projection.

                const speed      = pos.coords.speed    ?? 0;    // ?? handles null (iOS Safari)
                const accuracy   = pos.coords.accuracy ?? null; // meters — null means unavailable
                const rawHeading = pos.coords.heading;
                latestGpsSpeedRef.current = speed;

                // M0.5A: shadow GPS accuracy (declared after animate start — safe; animate runs next rAF tick)
                motionStateRef.current.rawGpsAccuracyM = accuracy ?? 0;

                // ── Effective speed tracking for high-speed marker smoothing ─
                // Primary: GPS speed from hardware. Fallback: estimated from position delta.
                // Guards: skip estimation on poor accuracy or large GPS jump (not real speed).
                {
                    const nowMs   = Date.now();
                    const prevPos = lastGpsPositionForSpeedRef.current;
                    const prevAt  = lastGpsPositionAtMsRef.current;

                    // Poor-accuracy samples must not update estimated speed
                    // (reuses MOVEMENT_ACCURACY_MAX_M = 30m — same policy as movement detection)
                    const poorAccuracy = accuracy !== null && (!isFinite(accuracy) || accuracy > MOVEMENT_ACCURACY_MAX_M);

                    if (!poorAccuracy && prevPos && prevAt > 0) {
                        const dtMs   = nowMs - prevAt;
                        const movedM = distanceMeters(prevPos, newPos);

                        // Large GPS jump guard: >100m in one sample is unreliable for speed.
                        // 100 km/h = 28m/s, 120 km/h = 33m/s — a legitimate 1s sample is ≤~35m.
                        // 100m threshold safely passes real highway movement while blocking jumps.
                        const isLargeJump = movedM > 100;
                        const isValidDt   = dtMs > 200 && dtMs < 5000;

                        if (isValidDt && !isLargeJump) {
                            const est = movedM / (dtMs / 1000);
                            estimatedAgentSpeedMpsRef.current = Math.max(0, Math.min(60, est));
                        }

                        // Always advance the position baseline so the next sample computes
                        // delta from the current position (prevents stale-ref drift).
                        lastGpsPositionForSpeedRef.current = newPos;
                        lastGpsPositionAtMsRef.current     = nowMs;
                    } else if (poorAccuracy) {
                    } else {
                        // First sample or no previous baseline — seed position only
                        lastGpsPositionForSpeedRef.current = newPos;
                        lastGpsPositionAtMsRef.current     = nowMs;
                    }

                    // Prefer GPS speed if valid; fall back to estimated position delta
                    const validGpsSpeed = speed > 0 && isFinite(speed) && speed < 60;
                    latestAgentSpeedMpsRef.current = validGpsSpeed
                        ? speed
                        : estimatedAgentSpeedMpsRef.current;
                }

                // ── Movement detection ──────────────────────────────────────────────
                // Guards prevent GPS cold-start false positives on iOS:
                //   1. route must be ready (path.length >= 2)
                //   2. GPS accuracy must be acceptable (<= MOVEMENT_ACCURACY_MAX_M)
                //   3. first valid GPS sample is stored as baseline — no detection yet
                //   4. distance fallback requires MOVEMENT_CONSECUTIVE_REQUIRED consecutive ticks
                if (!hasStartedMovingRef.current) {
                    if (pathRef.current.length < 2) {
                        // Route not ready — movement check would be premature
                        prevPosForMoveRef.current = newPos; // track position so we're ready when route loads
                    } else if (accuracy !== null && accuracy > MOVEMENT_ACCURACY_MAX_M) {
                        // GPS cold-start: sample too imprecise to be a reliable baseline or movement trigger
                        // Do NOT update prevPosForMoveRef — discard inaccurate position as baseline
                    } else if (ignoreFirstGpsSampleRef.current) {
                        // First valid GPS sample — store as baseline, skip detection this tick
                        ignoreFirstGpsSampleRef.current = false;
                        prevPosForMoveRef.current = newPos;
                    } else {
                        let detected = false;
                        let distM    = -1;

                        if (speed > 0.8) {
                            // Speed-based: single reliable tick is sufficient
                            detected = true;
                        } else if (prevPosForMoveRef.current) {
                            const dlat = (newPos.lat - prevPosForMoveRef.current.lat) * 111320;
                            const dlng = (newPos.lng - prevPosForMoveRef.current.lng) * 111320
                                * Math.cos(newPos.lat * Math.PI / 180);
                            distM = Math.sqrt(dlat * dlat + dlng * dlng);

                            if (distM >= MOVEMENT_DISTANCE_THRESHOLD_M) {
                                consecutiveMovementCountRef.current += 1;
                                if (consecutiveMovementCountRef.current >= MOVEMENT_CONSECUTIVE_REQUIRED) {
                                    detected = true;
                                }
                            } else {
                                consecutiveMovementCountRef.current = 0;
                            }
                        }

                        if (detected) {
                            hasStartedMovingRef.current = true;
                            userCameraOverrideRef.current = false;
                            hasUserExploredMapRef.current = false;
                            isCameraFollowingRef.current = true;
                            setHasStartedMoving(true);
                            setHasUserExploredMap(false);
                            setIsCameraFollowing(true);
                            setCameraMode('navigation_follow');
                        }

                        prevPosForMoveRef.current = newPos;
                    }
                }

                // ── Bearing smoothing ──────────────────────────────────────────────
                // Low-pass filter: 80% previous + 20% raw — prevents jitter
                if (speed > 0.5 && rawHeading !== null && !isNaN(rawHeading)) {
                    const prevBearing = prevHeadingRef.current;
                    let headingDelta = normalizeBearing(rawHeading) - normalizeBearing(prevBearing);
                    if (headingDelta > 180) headingDelta -= 360;
                    if (headingDelta < -180) headingDelta += 360;
                    const smoothed = normalizeBearing(prevBearing + headingDelta * 0.2);
                    prevHeadingRef.current = smoothed;
                    hasNavigationBearingRef.current = true;
                    setHasGpsHeading(true);
                    setGpsHeading(smoothed);
                    // mapHeading is updated exclusively by Mapbox onMove (= actual camera bearing).
                    // GPS heading must NOT write mapHeading — mixing the two caused marker rotation jitter.
                    // Camera bearing — shared candidate so camera and marker use the same segment.
                    // prevHeadingRef.current is already updated to `smoothed` above, so
                    // gps/fallback candidate.bearing === smoothed at this point.
                    updateTargetCameraBearing();
                }

                // M1: update compass bearing at GPS cadence (replaces 800ms bearing animate)
                setDisplayBearing(prevHeadingRef.current);
            },
            (err) => {
                setGpsError(true);
                console.error("GPS Error:", err.message);
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }
        );
        return () => navigator.geolocation.clearWatch(watchId);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleRecenter = () => {
        if (!mapRef.current) return;

        const isActiveNavigation = hasStartedMovingRef.current && cameraModeRef.current === 'navigation_follow';
        const agentPos = visualAgentPositionRef.current; // use visual position for smooth transition

        if (!isActiveNavigation) {
            userCameraOverrideRef.current = false;
            hasUserExploredMapRef.current = false;
            isCameraFollowingRef.current = false;
            setHasUserExploredMap(false);
            setIsCameraFollowing(false);

            const center = agentPos;
            const zoom = TOP_DOWN_ZOOM;
            const pitch = 0;
            const bearing = 0;

            mapRef.current.flyTo({
                center: [center.lng, center.lat],
                zoom,
                pitch,
                bearing,
                duration: 650,
                padding: { top: 0, bottom: 0, left: 0, right: 0 },
            });


            setTimeout(() => {
                if (mapRef.current) {
                    const mc = mapRef.current.getCenter();
                    visualCameraCenterRef.current = { lat: mc.lat, lng: mc.lng };
                }
            }, 700);
            return;
        }

        // Active navigation recenter: restore follow state — ref first for immediate rAF pickup
        userCameraOverrideRef.current = false;
        hasUserExploredMapRef.current = false;
        isCameraFollowingRef.current = true;
        setHasUserExploredMap(false);
        setIsCameraFollowing(true);

        const pitch = NAV_FOLLOW_PITCH;
        const zoom = NAV_FOLLOW_ZOOM;

        // Use route-up bearing from Phase 1c — not north-up
        const candidate = getRouteUpBearingCandidate();
        const bearing = candidate?.bearing ?? getNavigationBearing();
        const center = computeAndLogLookAheadCenter(agentPos, bearing);

        // Set bearing refs so post-animation bearing loop is aligned
        lastRequestedCameraBearingRef.current = bearing;
        targetCameraBearingRef.current = normalizeBearing(bearing);
        visualCameraBearingRef.current = mapRef.current.getBearing() ?? mapHeadingRef.current ?? bearing;
        isBearingEasingRef.current = true;

        mapRef.current.flyTo({
            center: [center.lng, center.lat],
            zoom,
            pitch,
            bearing,
            duration: 800,
            padding: { top: 0, bottom: CAMERA_NAV_BOTTOM_PAD_PX, left: 0, right: 0 },
        });

        // Sync refs after animation completes
        setTimeout(() => {
            isBearingEasingRef.current = false;
            if (mapRef.current) {
                const mc = mapRef.current.getCenter();
                visualCameraCenterRef.current = { lat: mc.lat, lng: mc.lng };
                const actualBearing = mapRef.current.getBearing();
                lastAppliedCameraBearingRef.current = actualBearing;
                visualCameraBearingRef.current = actualBearing;
            }
        }, 850); // 800ms animation + 50ms buffer

    };

    const isNavigationActiveForRecenter = path.length >= 2 || routeVersion > 0;
    const shouldShowRecenter = (
        cameraMode === 'navigation_follow' && !isCameraFollowing
    ) || (
        !hasStartedMoving && isNavigationActiveForRecenter && hasUserExploredMap
    );

    const markerScreenRotation = useMemo(() => (
        isCameraFollowing
            ? normalizeBearing(visualMarkerBearing - mapHeading)
            : normalizeBearing(visualMarkerBearing)
    ), [isCameraFollowing, mapHeading, visualMarkerBearing]);

    // Production entry gates.
    // Do not expose invalid sentinel coordinates while identity/GPS/target
    // bootstrap is incomplete.
    if (!router.isReady) {
        return (
            <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 text-center font-sans">
                <h1 className="text-2xl font-bold text-gray-900">
                    กำลังเตรียมระบบนำทาง...
                </h1>
            </main>
        );
    }

    if (!queryResult?.ok) {
        return (
            <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 text-center font-sans">
                <div className="space-y-4">
                    <h1 className="text-2xl font-bold text-gray-900">
                        {queryResult?.error ?? NAVIGATION_QUERY_ERROR}
                    </h1>
                    <button
                        type="button"
                        onClick={() => router.back()}
                        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white"
                    >
                        ย้อนกลับ
                    </button>
                </div>
            </main>
        );
    }

    if (gpsError) {
        return (
            <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 text-center font-sans">
                <h1 className="text-2xl font-bold text-gray-900">
                    ไม่สามารถเข้าถึงตำแหน่งปัจจุบันได้
                </h1>
            </main>
        );
    }

    if (!hasRealGpsPosition) {
        return (
            <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 text-center font-sans">
                <h1 className="text-2xl font-bold text-gray-900">
                    กำลังค้นหาตำแหน่งปัจจุบัน...
                </h1>
            </main>
        );
    }

    if (!hasRealTargetPosition) {
        return (
            <main className="flex min-h-[100dvh] items-center justify-center bg-gray-50 px-6 text-center font-sans">
                <h1 className="text-2xl font-bold text-gray-900">
                    กำลังรอตำแหน่ง...
                </h1>
            </main>
        );
    }


    return (
        <main className="relative w-full h-[100dvh] bg-[#EFEFEF] overflow-hidden font-sans">
            <ResearchLogPanel className="absolute left-3 top-[96px] z-30" />
            <div
                className="absolute inset-0"
                onTouchStart={handleMapTouchStart}
                onTouchMove={handleMapTouchMove}
                onTouchEnd={handleMapTouchEnd}
                onTouchCancel={handleMapTouchCancel}
            >
                <Map
                    ref={mapRef}
                    mapboxAccessToken={MAPBOX_TOKEN}
                    initialViewState={{
                        longitude: currentPosition.lng,
                        latitude: currentPosition.lat,
                        zoom: hasStartedMoving ? NAV_FOLLOW_ZOOM : TOP_DOWN_ZOOM,
                        bearing: isCameraFollowing ? mapHeading : 0,
                        pitch: (isCameraFollowing && hasStartedMoving) ? NAV_FOLLOW_PITCH : 0,
                    }}
                    padding={{ top: 0, bottom: 0, left: 0, right: 0 }}
                    style={{ width: "100%", height: "100%" }}
                    mapStyle="mapbox://styles/mapbox/streets-v12"
                    onDragStart={(e) => handleUserGestureEvent('drag', e as any)}
                    onZoomStart={(e) => handleUserGestureEvent('zoom', e as any)}
                    onRotateStart={(e) => handleUserGestureEvent('rotate', e as any)}
                    onMoveStart={(e) => handleUserGestureEvent('move', e as any)}
                    onMove={(e) => {
                        mapHeadingRef.current = e.viewState.bearing;
                        setMapHeading(e.viewState.bearing);
                    }}
                    attributionControl={false}
                >
                    {/* หมุดตัวเรา — ใช้ visualAgentPosition (smooth lerp toward snapped route) */}
                    <Marker
                        longitude={visualAgentPosition.lng}
                        latitude={visualAgentPosition.lat}
                        anchor="center"
                    >
                        <div
                            style={{
                                width: 65,
                                height: 65,
                                borderRadius: "9999px",
                                overflow: "visible",
                                background: "transparent",
                                transform: `rotate(${markerScreenRotation}deg)`,
                                filter: "drop-shadow(0px 4px 10px rgba(0,0,0,0.28))",
                            }}
                        >
                            <img
                                src="/navigation_arrow.png"
                                alt="My Location"
                                style={{
                                    width: "100%",
                                    height: "100%",
                                    display: "block",
                                    objectFit: "contain",
                                }}
                            />
                        </div>
                    </Marker>

                    {/* หมุดคนไข้ */}
                    <Marker
                        longitude={visualPatientLocation.lng}
                        latitude={visualPatientLocation.lat}
                        anchor="bottom"
                    >
                        <img src="/marker.png" alt="Patient" style={{ width: 45, height: 45, objectFit: "contain", filter: "drop-shadow(0px 4px 6px rgba(0,0,0,0.3))" }} />
                    </Marker>

                    {/* 💡 วาดเส้นทาง Mapbox — key เปลี่ยนเฉพาะ first route + Mapbox refetch (ไม่ remount บน MT-D* incremental) */}
                    {/* [afe.web.route_flicker] `data` here only ever carries the same physically-clipped
                        geometry that applyRouteDisplayGeometry already wrote imperatively — it seeds the
                        declarative Source on (re)mount, and steady-state MT-D* updates flow through the
                        imperative path only, so this prop and the imperative writer never race each other. */}
                    <Source
                        key={`route-${routeSourceKey}`}
                        id="route"
                        type="geojson"
                        data={routeSourceData}
                        lineMetrics={true}
                    >
                        {/* 1. เส้นขอบด้านหลัง (Casing) เพื่อให้เส้นดูมีมิติ */}
                        <Layer
                            id="route-line-casing"
                            type="line"
                            paint={{
                                "line-color": "#1A52B8", // สีน้ำเงินเข้ม
                                "line-width": [
                                    "interpolate", ["linear"], ["zoom"],
                                    12, 6,
                                    18, 14,
                                    22, 22
                                ],
                                "line-opacity": 1.0,
                                "line-trim-offset": [0, 0], // [afe.web.route_flicker] invariant — never written imperatively
                                "line-trim-color": "rgba(0, 0, 0, 0)",
                                "line-trim-fade-range": [0, 0],
                            }}
                            layout={{
                                "line-join": "round",
                                "line-cap": "round",
                            }}
                        />
                        {/* 2. เส้นหลัก (Main Line) ตรงกลาง */}
                        <Layer
                            id="route-line"
                            type="line"
                            paint={{
                                "line-color": "#4285F4", // สีฟ้าสว่าง
                                "line-width": [
                                    "interpolate", ["linear"], ["zoom"],
                                    12, 3,
                                    18, 9,
                                    22, 14
                                ],
                                "line-opacity": 1.0,
                                "line-trim-offset": [0, 0], // [afe.web.route_flicker] invariant — never written imperatively
                                "line-trim-color": "rgba(0, 0, 0, 0)",
                                "line-trim-fade-range": [0, 0],
                            }}
                            layout={{
                                "line-join": "round",
                                "line-cap": "round",
                            }}
                        />
                    </Source>

                </Map>
            </div>

            {/* --- 1. แถบบอกทางด้านบน --- */}
            <TopNavigationBanner
                maneuverIcon={topBannerManeuverIcon}
                distance={topBannerInstruction.distance}
                instruction={routeUxBanner ? routeUxBanner.title : topBannerInstruction.title}
                subtitle={routeUxBanner ? (routeUxBanner.subtitle ?? null) : (lastMileLabel ?? null)}
                action={routeUxBanner?.action ?? null}
                onAction={routeUxBanner?.action ? handleRetryInitRoute : undefined}
                isVisible={true}
            />



            {/* --- 2. ปุ่มด้านขวา --- */}
            <div className="absolute top-[150px] right-4 z-10 flex flex-col gap-[12px]">
                <div
                    className="transition-opacity duration-300 flex justify-end"
                    style={{
                        opacity: Math.abs(mapHeading) > 1.0 ? 1 : 0,
                        pointerEvents: Math.abs(mapHeading) > 1.0 ? 'auto' : 'none'
                    }}
                >
                    <CustomCompass
                        size={55}
                        bearing={displayBearing}
                        onTap={() => {
                            const isNavFollow = cameraModeRef.current === 'navigation_follow';
                            const wasFollowing = isCameraFollowingRef.current;

                            // If in navigation_follow and still auto-following, enter free-explore first
                            if (isNavFollow && wasFollowing) {
                                userCameraOverrideRef.current = true;
                                isCameraFollowingRef.current = false;
                                setIsCameraFollowing(false);
                                // Cancel any in-flight bearing ease — compass now owns rotation
                                if (bearingEaseTimeoutRef.current !== null) {
                                    clearTimeout(bearingEaseTimeoutRef.current);
                                    bearingEaseTimeoutRef.current = null;
                                }
                                isBearingEasingRef.current = false;
                            }

                            if (mapRef.current) {
                                mapRef.current.flyTo({ bearing: 0, duration: 500 });
                                // Sync mapHeading from actual map state after flyTo completes
                                // instead of forcing setMapHeading(0) before Mapbox rotates
                                setTimeout(() => {
                                    if (mapRef.current) {
                                        const actualAfter = mapRef.current.getBearing();
                                        // onMove handler continuously updates mapHeading,
                                        // but sync explicitly here for safety
                                        mapHeadingRef.current = actualAfter;
                                        setMapHeading(actualAfter);
                                    }
                                }, 550); // 500ms flyTo + 50ms buffer
                            }
                        }}
                    />
                </div>
                <button
                    onClick={() => {
                        if (isSoundOn) cancelSpeech();
                        setIsSoundOn(!isSoundOn);
                    }}
                    className="w-[55px] h-[55px] bg-white rounded-full flex items-center justify-center shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-4px_rgba(0,0,0,0.1)] active:scale-95 transition-transform"
                >
                    {isSoundOn ? <Volume2 className="text-[#1B5E20] w-[28px] h-[28px]" /> : <VolumeX className="text-gray-500 w-[28px] h-[28px]" />}
                </button>
            </div>

            {/* --- ปุ่มปรับจุดกลาง --- */}
            {shouldShowRecenter && (
                <div className="absolute bottom-[140px] left-4 z-10 animate-in fade-in zoom-in duration-200">
                    <button
                        onClick={handleRecenter}
                        className="flex items-center gap-2 px-[16px] py-[10px] bg-white rounded-full shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-4px_rgba(0,0,0,0.1)] active:scale-95 transition-transform border-[1px] border-solid border-[#F3F4F6]"
                    >
                        <NavIcon className="text-[#4285F4] w-5 h-5" />
                        <span className="text-gray-800 font-medium text-[15px]">ปรับจุดกลาง</span>
                    </button>
                </div>
            )}

            {/* --- 4. แถบสถานะด้านล่าง --- */}
            <div className="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-[30px] shadow-[0_-10px_30px_rgba(0,0,0,0.1)] px-[25px] pt-[20px] pb-[calc(2.2rem+env(safe-area-inset-bottom))]">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                            {status === 'arrived' ? (
                                <span className="text-[#1B5E20] text-[26px] font-extrabold leading-none tracking-tight whitespace-nowrap">ถึงจุดหมายแล้ว</span>
                            ) : (
                                <>
                                    {durationHrs > 0 && (
                                        <>
                                            <span className="text-[#1B5E20] text-[44px] font-extrabold leading-none tracking-tight">{durationHrs || 0}</span>
                                            <span className="text-[#1B5E20] text-[24px] font-bold leading-none mr-1">ชม.</span>
                                        </>
                                    )}
                                    <span className="text-[#1B5E20] text-[44px] font-extrabold leading-none tracking-tight">{status === 'loading' ? '--' : (durationMins || 0)}</span>
                                    <span className="text-[#1B5E20] text-[24px] font-bold leading-none">นาที</span>
                                </>
                            )}
                        </div>
                        <p className="text-[#5F6368] text-[18px] mt-1 font-normal leading-none whitespace-nowrap overflow-hidden text-ellipsis">
                            {status === 'arrived'
                                ? 'การนำทางเสร็จสิ้น'
                                : `${navigationDistanceDisplay.displayRemainingDistance > 1000
                                    ? `${(navigationDistanceDisplay.displayRemainingDistance / 1000).toFixed(1)} กม.`
                                    : `${Math.round(navigationDistanceDisplay.displayRemainingDistance || 0)} ม.`
                                } • ${arrivalTime}`}
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            stop();
                            router.back();
                        }}
                        className="shrink-0 whitespace-nowrap bg-[#E31E24] text-white px-[20px] py-[14px] rounded-[24px] text-[20px] font-bold shadow-md active:scale-95 transition-transform"
                    >
                        {status === 'arrived' ? 'สิ้นสุดการนำทาง' : 'ออก'}
                    </button>
                </div>
            </div>
        </main>
    );
}

export default function NavigationPage() {
    return (
        <NavigationProvider>
            <NavigationScreen />
        </NavigationProvider>
    );
}
