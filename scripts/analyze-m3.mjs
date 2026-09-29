#!/usr/bin/env node
// M3 (Route-to-Target Reference Location Discrepancy) offline analyzer.
//
// Processes exported navigation JSONL (V2 or V3, route_active-bearing) and a
// linked Target Sender JSONL trace against a run manifest and a versioned
// clock-quality criteria file, per protocol M3-PROTOCOL-V1. Read-only: never
// mutates navigation behavior, route calculation, or M1/M2 event meaning.
//
// Usage:
//   node scripts/analyze-m3.mjs --navigation <nav.jsonl> --sender <sender.jsonl> \
//     --manifest <manifest.json> --criteria <criteria.json> [--table]
import { readFileSync } from 'node:fs';
import { haversineMeters, isValidLatLng } from './m3-haversine.mjs';

export const CHECKPOINTS = [0, 50, 100, 150, 200, 300, 500];
export const VALID_SYSTEMS = ['AFE-Plus V.2', 'D-TANS'];
export const PROTOCOL_VERSION = 'M3-PROTOCOL-V1';

const RUN_INVALIDATING_STATUSES = new Set([
  'RUN_ID_MISMATCH', 'NAVIGATION_SESSION_MISMATCH', 'SENDER_SESSION_MISMATCH',
  'DUPLICATE_TARGET_SAMPLE_ID', 'INCOMPLETE_NAVIGATION_LOG', 'INCOMPLETE_SENDER_LOG',
  'PROTOCOL_ERROR',
]);

// ─── JSONL / JSON loading ───────────────────────────────────────────────────

export function parseJsonl(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`invalid JSON at line ${i + 1}`);
    }
  }
  return events;
}

function isPlausibleEpochMs(value) {
  // Structural sanity check only (year 2000..2100) — never a research threshold.
  return Number.isFinite(value) && value > 946_684_800_000 && value < 4_102_444_800_000;
}

// ─── Manifest / criteria validation ─────────────────────────────────────────

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { valid: false, errors: ['malformed_manifest'] };
  if (manifest.schema_version !== 'm3-manifest-v1') errors.push('bad_schema_version');
  if (manifest.protocol_version !== PROTOCOL_VERSION) errors.push('bad_protocol_version');
  for (const key of ['research_run_id', 'navigation_session_id', 'sender_session_id', 'navigation_log_file', 'sender_trace_file']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) errors.push(`missing_${key}`);
  }
  if (!VALID_SYSTEMS.includes(manifest.system)) errors.push('invalid_system');
  return { valid: errors.length === 0, errors };
}

export function validateCriteria(criteria) {
  const errors = [];
  if (!criteria || typeof criteria !== 'object') return { valid: false, errors: ['malformed_criteria'], missing: true };
  if (criteria.schema_version !== 'm3-criteria-v1') errors.push('bad_schema_version');
  const required = ['max_rtt_ms', 'max_clock_uncertainty_ms', 'max_clock_drift_ms', 'max_route_reference_match_distance_m'];
  let missing = false;
  for (const key of required) {
    if (typeof criteria[key] !== 'number' || !Number.isFinite(criteria[key]) || criteria[key] < 0) {
      errors.push(`missing_or_invalid_${key}`);
      missing = true;
    }
  }
  return { valid: errors.length === 0, errors, missing };
}

// ─── Navigation log ──────────────────────────────────────────────────────────

function normalizeRouteActive(raw) {
  return {
    event_seq: raw.event_seq,
    wall_clock_ms: raw.wall_clock_ms,
    session_id: raw.session_id,
    route_update_id: raw.route_update_id,
    target_sample_id: raw.target_sample_id ?? null,
    target_ref_lat: raw.target_ref_lat,
    target_ref_lng: raw.target_ref_lng,
    route_activation_seq: raw.route_activation_seq,
    route_version: raw.route_version ?? null,
  };
}

function computeClockOffset(record) {
  if (!record) return null;
  const { success, rtt_ms: rttMs, estimated_clock_offset_ms: offsetMs } = record;
  if (success !== true || !Number.isFinite(rttMs) || !Number.isFinite(offsetMs)) return null;
  return { offsetMs, rttMs };
}

function loadNavigationLog(rawEvents, manifest) {
  const issues = [];
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { issues: ['INCOMPLETE_NAVIGATION_LOG:empty'], routeActives: [], clockOffset: null, clockSyncRaw: null };
  }

  const runStarts = rawEvents.filter((e) => e?.event === 'run_start');
  const runStops = rawEvents.filter((e) => e?.event === 'run_stop');
  const clockSyncEvents = rawEvents.filter((e) => e?.event === 'clock_sync');
  const loggerHealths = rawEvents.filter((e) => e?.event === 'logger_health');
  const routeActiveRaw = rawEvents.filter((e) => e?.event === 'route_active');

  if (runStarts.length === 0) issues.push('INCOMPLETE_NAVIGATION_LOG:missing_run_start');
  if (runStops.length === 0) issues.push('INCOMPLETE_NAVIGATION_LOG:missing_run_stop');
  for (const health of loggerHealths) {
    const dropped = Number(health.dropped_events);
    if (Number.isFinite(dropped) && dropped > 0) issues.push('INCOMPLETE_NAVIGATION_LOG:dropped_events');
  }

  const runIds = new Set(rawEvents.map((e) => e?.research_run_id).filter((v) => typeof v === 'string' && v));
  if (runIds.size > 1) issues.push('RUN_ID_MISMATCH:navigation_log_multiple_run_ids');
  if (manifest?.research_run_id && (runIds.size === 0 || !runIds.has(manifest.research_run_id))) {
    issues.push('RUN_ID_MISMATCH:navigation_log_run_id');
  }

  const matchingSessionRouteActives = routeActiveRaw.filter((e) => e.session_id === manifest?.navigation_session_id);
  if (routeActiveRaw.length > 0 && matchingSessionRouteActives.length === 0) {
    issues.push('NAVIGATION_SESSION_MISMATCH:no_matching_session');
  }

  const routeActives = matchingSessionRouteActives
    .filter((e) => typeof e.route_update_id === 'string' && Number.isFinite(e.wall_clock_ms) && Number.isFinite(e.route_activation_seq))
    .map(normalizeRouteActive);

  const clockSyncRaw = clockSyncEvents.length > 0 ? clockSyncEvents[clockSyncEvents.length - 1] : null;
  const clockOffset = computeClockOffset(clockSyncRaw);

  return { issues, routeActives, clockOffset, clockSyncRaw };
}

// ─── Sender trace ────────────────────────────────────────────────────────────

function normalizeSample(raw) {
  return {
    sender_session_id: raw.sender_session_id,
    target_sample_id: raw.target_sample_id,
    sequence: raw.sequence,
    target_lat: raw.target_lat,
    target_lng: raw.target_lng,
    source_timestamp_ms: raw.source_timestamp_ms,
    cumulative_distance_m: raw.cumulative_distance_m,
    research_run_id: raw.research_run_id ?? null,
    sourceTimestampValid: isPlausibleEpochMs(raw.source_timestamp_ms),
  };
}

function indexById(samples) {
  const map = new Map();
  for (const sample of samples) {
    if (!map.has(sample.target_sample_id)) map.set(sample.target_sample_id, []);
    map.get(sample.target_sample_id).push(sample);
  }
  return map;
}

function loadSenderTrace(rawEvents, manifest) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { issues: ['INCOMPLETE_SENDER_LOG:empty'], samples: [], allSamplesById: new Map(), clockOffset: null, clockSyncRaw: null };
  }
  const issues = [];

  const senderStarts = rawEvents.filter((e) => e?.event === 'sender_start');
  const senderStops = rawEvents.filter((e) => e?.event === 'sender_stop');
  const clockSyncEvents = rawEvents.filter((e) => e?.event === 'clock_sync');
  const sampleRaw = rawEvents.filter((e) => e?.event === 'target_sample');

  if (senderStarts.length === 0) issues.push('INCOMPLETE_SENDER_LOG:missing_sender_start');
  if (senderStops.length === 0) issues.push('INCOMPLETE_SENDER_LOG:missing_sender_stop');

  const sessionIds = new Set(rawEvents.map((e) => e?.sender_session_id).filter((v) => typeof v === 'string' && v));
  if (sessionIds.size > 1) issues.push('SENDER_SESSION_MISMATCH:multiple_sessions_in_file');
  if (manifest?.sender_session_id && (sessionIds.size === 0 || !sessionIds.has(manifest.sender_session_id))) {
    issues.push('SENDER_SESSION_MISMATCH:wrong_session');
  }

  const runIds = new Set(rawEvents.map((e) => e?.research_run_id).filter((v) => typeof v === 'string' && v));
  if (runIds.size > 1) issues.push('RUN_ID_MISMATCH:sender_trace_multiple_run_ids');
  if (manifest?.research_run_id && (runIds.size === 0 || !runIds.has(manifest.research_run_id))) {
    issues.push('RUN_ID_MISMATCH:sender_trace_run_id');
  }

  const matchingSamplesRaw = sampleRaw.filter((e) => e.sender_session_id === manifest?.sender_session_id);
  const idCounts = new Map();
  for (const sample of matchingSamplesRaw) {
    idCounts.set(sample.target_sample_id, (idCounts.get(sample.target_sample_id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) issues.push(`DUPLICATE_TARGET_SAMPLE_ID:${id}`);
  }

  // Structurally unusable records (no sequence/cumulative distance) are dropped —
  // that is not the same as an invalid *coordinate*, which must still take part
  // in checkpoint-crossing selection (by distance/time) so a bad-coordinate
  // sample can be surfaced as INVALID_COORDINATE rather than silently skipped
  // in favor of the next sample.
  const samples = matchingSamplesRaw
    .filter((e) => Number.isFinite(e.sequence) && Number.isFinite(e.cumulative_distance_m))
    .sort((a, b) => a.sequence - b.sequence)
    .map((raw) => ({ ...normalizeSample(raw), coordValid: isValidLatLng({ lat: raw.target_lat, lng: raw.target_lng }) }));

  const clockSyncRaw = clockSyncEvents.length > 0 ? clockSyncEvents[clockSyncEvents.length - 1] : null;
  const clockOffset = computeClockOffset(clockSyncRaw);

  return { issues, samples, allSamplesById: indexById(samples), clockOffset, clockSyncRaw };
}

// ─── Clock quality gate ──────────────────────────────────────────────────────

function evaluateClockSync(navClock, senderClock, criteria) {
  if (!navClock || !senderClock) return { pass: false, uncertaintyMs: null, reason: 'clock_sync_probe_missing_or_failed' };
  if (navClock.rttMs > criteria.max_rtt_ms || senderClock.rttMs > criteria.max_rtt_ms) {
    return { pass: false, uncertaintyMs: null, reason: 'rtt_exceeds_criteria' };
  }
  // No periodic re-sync exists in current instrumentation, so max_clock_drift_ms
  // is applied as a flat conservative uncertainty budget rather than a rate.
  const uncertaintyMs = navClock.rttMs / 2 + senderClock.rttMs / 2 + criteria.max_clock_drift_ms;
  if (uncertaintyMs > criteria.max_clock_uncertainty_ms) {
    return { pass: false, uncertaintyMs, reason: 'uncertainty_exceeds_criteria' };
  }
  return { pass: true, uncertaintyMs, reason: null };
}

// ─── Checkpoint selection (M3-PROTOCOL-V1) ──────────────────────────────────

function selectInitialRouteActive(routeActives) {
  if (routeActives.length === 0) return null;
  return routeActives.reduce((min, r) => (r.route_activation_seq < min.route_activation_seq ? r : min));
}

function selectCheckpointZero(samples, initialRouteTimeServerMs) {
  for (const sample of samples) {
    if (sample.normalizedSourceTimeMs === null) continue;
    if (sample.normalizedSourceTimeMs >= initialRouteTimeServerMs) return sample;
  }
  return null;
}

function selectCheckpointCrossing(samples, baselineDistance, thresholdM) {
  for (const sample of samples) {
    if (sample.cumulative_distance_m - baselineDistance >= thresholdM) return sample;
  }
  return null;
}

function selectRouteForCheckpoint(routeActives, navOffsetMs, checkpointTimeServerMs, uncertaintyMs) {
  const candidates = routeActives
    .map((r) => ({ ...r, normalizedTimeMs: r.wall_clock_ms + navOffsetMs }))
    .filter((r) => Number.isFinite(r.normalizedTimeMs))
    .sort((a, b) => a.normalizedTimeMs - b.normalizedTimeMs || a.event_seq - b.event_seq);

  let selected = null;
  let selectedIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].normalizedTimeMs <= checkpointTimeServerMs) {
      selected = candidates[i];
      selectedIndex = i;
    } else {
      break;
    }
  }
  if (!selected) return { route: null, ambiguous: false };

  // A newer route within the uncertainty band of the checkpoint could actually
  // have been accepted before it — ordering can't be trusted, never guessed.
  const next = candidates[selectedIndex + 1];
  const ambiguous = next ? (next.normalizedTimeMs - uncertaintyMs) <= checkpointTimeServerMs : false;
  return { route: selected, ambiguous };
}

function computeCheckpoints({ routeActives, samples, navOffsetMs, uncertaintyMs, criteria, allSamplesById }) {
  const initial = selectInitialRouteActive(routeActives);
  if (!initial) {
    return { wholeRunStatus: 'NO_ROUTE', wholeRunReason: 'no_accepted_route_in_run', results: null };
  }
  const initialRouteTimeServerMs = initial.wall_clock_ms + navOffsetMs;
  const checkpointZero = selectCheckpointZero(samples, initialRouteTimeServerMs);
  if (!checkpointZero) {
    return { wholeRunStatus: 'MISSING_CANONICAL_SAMPLE', wholeRunReason: 'no_sender_sample_at_or_after_initial_route_active', results: null };
  }
  const baselineDistance = checkpointZero.cumulative_distance_m;

  const chosenByDistance = new Map([[0, checkpointZero]]);
  for (const d of CHECKPOINTS.slice(1)) {
    chosenByDistance.set(d, selectCheckpointCrossing(samples, baselineDistance, d));
  }

  const sharedBy = new Map();
  for (const [d, sample] of chosenByDistance) {
    if (!sample) continue;
    if (!sharedBy.has(sample.target_sample_id)) sharedBy.set(sample.target_sample_id, []);
    sharedBy.get(sample.target_sample_id).push(d);
  }

  const results = CHECKPOINTS.map((d) => {
    const sample = chosenByDistance.get(d);
    const sharesWith = sample ? sharedBy.get(sample.target_sample_id).filter((x) => x !== d) : [];
    return computeSingleCheckpoint({ d, sample, sharesWith, routeActives, navOffsetMs, uncertaintyMs, criteria, allSamplesById, baselineDistance });
  });

  return { wholeRunStatus: null, results };
}

function computeSingleCheckpoint({ d, sample, sharesWith, routeActives, navOffsetMs, uncertaintyMs, criteria, allSamplesById, baselineDistance }) {
  const base = { checkpoint_m: d, baseline_distance_m: baselineDistance, shares_sample_with_checkpoints: sharesWith };
  const emptyRoute = {
    route_update_id: null, route_version: null, route_activation_seq: null, route_active_time_server_ms: null,
    route_target_sample_id: null, route_target_lat: null, route_target_lng: null,
  };
  const emptyCanonical = { checkpoint_sample_id: null, checkpoint_sequence: null, checkpoint_time_server_ms: null, checkpoint_cumulative_distance_m: null };

  if (!sample) {
    return { ...base, ...emptyCanonical, ...emptyRoute, canonical_target_sample_id: null, canonical_target_lat: null, canonical_target_lng: null,
      m3_distance_m: null, join_mode: null, status: 'MISSING_CANONICAL_SAMPLE', diagnostic_reason: 'sender_trace_did_not_reach_checkpoint_distance' };
  }
  if (!sample.coordValid) {
    return { ...base, checkpoint_sample_id: sample.target_sample_id, checkpoint_sequence: sample.sequence,
      checkpoint_time_server_ms: sample.normalizedSourceTimeMs, checkpoint_cumulative_distance_m: sample.cumulative_distance_m, ...emptyRoute,
      canonical_target_sample_id: sample.target_sample_id, canonical_target_lat: sample.target_lat, canonical_target_lng: sample.target_lng,
      m3_distance_m: null, join_mode: null, status: 'INVALID_COORDINATE', diagnostic_reason: 'canonical_checkpoint_sample_coordinates_invalid' };
  }
  if (sample.normalizedSourceTimeMs === null) {
    return { ...base, checkpoint_sample_id: sample.target_sample_id, checkpoint_sequence: sample.sequence, checkpoint_time_server_ms: null,
      checkpoint_cumulative_distance_m: sample.cumulative_distance_m, ...emptyRoute,
      canonical_target_sample_id: sample.target_sample_id, canonical_target_lat: sample.target_lat, canonical_target_lng: sample.target_lng,
      m3_distance_m: null, join_mode: null, status: 'MISSING_CANONICAL_SAMPLE', diagnostic_reason: 'canonical_sample_source_timestamp_invalid' };
  }

  const checkpointTimeServerMs = sample.normalizedSourceTimeMs;
  const common = {
    ...base,
    checkpoint_sample_id: sample.target_sample_id,
    checkpoint_sequence: sample.sequence,
    checkpoint_time_server_ms: checkpointTimeServerMs,
    checkpoint_cumulative_distance_m: sample.cumulative_distance_m,
    canonical_target_sample_id: sample.target_sample_id,
    canonical_target_lat: sample.target_lat,
    canonical_target_lng: sample.target_lng,
  };

  const { route, ambiguous } = selectRouteForCheckpoint(routeActives, navOffsetMs, checkpointTimeServerMs, uncertaintyMs);
  if (!route) {
    return { ...common, ...emptyRoute, m3_distance_m: null, join_mode: null, status: 'NO_ROUTE', diagnostic_reason: 'no_accepted_route_at_or_before_checkpoint' };
  }
  if (ambiguous) {
    const routeInfo = {
      route_update_id: route.route_update_id, route_version: route.route_version, route_activation_seq: route.route_activation_seq,
      route_active_time_server_ms: route.normalizedTimeMs, route_target_sample_id: route.target_sample_id,
      route_target_lat: route.target_ref_lat, route_target_lng: route.target_ref_lng,
    };
    return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'CLOCK_SYNC_INVALID', diagnostic_reason: 'route_acceptance_order_ambiguous_within_uncertainty' };
  }

  const routeInfo = {
    route_update_id: route.route_update_id, route_version: route.route_version, route_activation_seq: route.route_activation_seq,
    route_active_time_server_ms: route.normalizedTimeMs, route_target_sample_id: route.target_sample_id,
    route_target_lat: route.target_ref_lat, route_target_lng: route.target_ref_lng,
  };

  if (!isValidLatLng({ lat: route.target_ref_lat, lng: route.target_ref_lng })) {
    return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'MISSING_ROUTE_REFERENCE', diagnostic_reason: 'route_active_target_ref_invalid_or_out_of_range' };
  }

  let joinMode;
  let status;
  let diagnosticReason;
  if (route.target_sample_id !== null) {
    const candidates = allSamplesById.get(route.target_sample_id) ?? [];
    if (candidates.length === 0) {
      return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'ROUTE_SAMPLE_MISMATCH', diagnostic_reason: 'route_target_sample_id_not_found_in_linked_sender_session' };
    }
    if (candidates.length > 1) {
      return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'ROUTE_SAMPLE_MISMATCH', diagnostic_reason: 'route_target_sample_id_matched_multiple_sender_samples' };
    }
    const matched = candidates[0];
    if (!isValidLatLng({ lat: matched.target_lat, lng: matched.target_lng })) {
      return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'ROUTE_SAMPLE_MISMATCH', diagnostic_reason: 'matched_sender_sample_coordinates_invalid' };
    }
    const matchDistanceM = haversineMeters({ lat: matched.target_lat, lng: matched.target_lng }, { lat: route.target_ref_lat, lng: route.target_ref_lng });
    if (matchDistanceM > criteria.max_route_reference_match_distance_m) {
      return { ...common, ...routeInfo, m3_distance_m: null, join_mode: null, status: 'ROUTE_SAMPLE_MISMATCH', diagnostic_reason: `matched_sample_diverges_${matchDistanceM.toFixed(2)}m_from_route_target_ref` };
    }
    joinMode = 'ID_VERIFIED';
    status = 'OK';
    diagnosticReason = 'target_sample_id_verified_against_linked_sender_sample';
  } else {
    joinMode = 'COORD_ONLY';
    status = 'OK_COORD_ONLY';
    diagnosticReason = 'route_active_target_sample_id_null_using_route_coordinate_directly';
  }

  const m3DistanceM = haversineMeters({ lat: route.target_ref_lat, lng: route.target_ref_lng }, { lat: sample.target_lat, lng: sample.target_lng });
  return { ...common, ...routeInfo, m3_distance_m: m3DistanceM, join_mode: joinMode, status, diagnostic_reason: diagnosticReason };
}

// ─── Run summary ─────────────────────────────────────────────────────────────

function buildSummary(manifest, results, forcedValidity) {
  const okCount = results.filter((r) => r.status === 'OK').length;
  const okCoordOnlyCount = results.filter((r) => r.status === 'OK_COORD_ONLY').length;
  const validCount = okCount + okCoordOnlyCount;
  const runValidity = forcedValidity ?? 'VALID';
  return {
    research_run_id: manifest?.research_run_id ?? null,
    system: manifest?.system ?? null,
    sender_session_id: manifest?.sender_session_id ?? null,
    navigation_session_id: manifest?.navigation_session_id ?? null,
    protocol_version: PROTOCOL_VERSION,
    valid_checkpoint_count: validCount,
    ok_count: okCount,
    ok_coord_only_count: okCoordOnlyCount,
    na_count: results.length - validCount,
    run_validity: runValidity,
  };
}

function buildBlockedResult({ status, reason, manifest, extraIssues, nav, sender, clockEval }) {
  const results = CHECKPOINTS.map((d) => ({
    checkpoint_m: d, checkpoint_sample_id: null, checkpoint_sequence: null, checkpoint_time_server_ms: null,
    checkpoint_cumulative_distance_m: null, baseline_distance_m: null, shares_sample_with_checkpoints: [],
    route_update_id: null, route_version: null, route_activation_seq: null, route_active_time_server_ms: null,
    route_target_sample_id: null, route_target_lat: null, route_target_lng: null,
    canonical_target_sample_id: null, canonical_target_lat: null, canonical_target_lng: null,
    m3_distance_m: null, join_mode: null, status, diagnostic_reason: reason,
    clock_sync_navigation: nav?.clockSyncRaw ?? null, clock_sync_sender: sender?.clockSyncRaw ?? null,
    estimated_uncertainty_ms: clockEval?.uncertaintyMs ?? null,
  }));
  const runValidity = RUN_INVALIDATING_STATUSES.has(status) ? 'INVALID' : 'NO_OFFICIAL_RESULT';
  return { manifest_issues: extraIssues ?? [], results, summary: buildSummary(manifest, results, runValidity) };
}

// ─── Top-level entry point ───────────────────────────────────────────────────

export function analyzeRun({ navigationEvents, senderEvents, manifest, criteria }) {
  const manifestCheck = validateManifest(manifest);
  if (!manifestCheck.valid) {
    return buildBlockedResult({ status: 'PROTOCOL_ERROR', reason: manifestCheck.errors.join(';'), manifest, extraIssues: manifestCheck.errors.map((e) => `PROTOCOL_ERROR:${e}`) });
  }

  const nav = loadNavigationLog(navigationEvents, manifest);
  const sender = loadSenderTrace(senderEvents, manifest);
  const issues = [...nav.issues, ...sender.issues];

  const blockingOrder = [
    'RUN_ID_MISMATCH', 'NAVIGATION_SESSION_MISMATCH', 'SENDER_SESSION_MISMATCH',
    'DUPLICATE_TARGET_SAMPLE_ID', 'INCOMPLETE_NAVIGATION_LOG', 'INCOMPLETE_SENDER_LOG',
  ];
  for (const status of blockingOrder) {
    const hit = issues.find((i) => i.startsWith(status));
    if (hit) return buildBlockedResult({ status, reason: hit, manifest, extraIssues: issues, nav, sender });
  }

  const criteriaCheck = validateCriteria(criteria);
  if (criteriaCheck.missing) {
    return buildBlockedResult({ status: 'CLOCK_SYNC_CRITERIA_MISSING', reason: 'criteria_file_missing_required_values', manifest, extraIssues: issues, nav, sender });
  }

  const clockEval = evaluateClockSync(nav.clockOffset, sender.clockOffset, criteria);
  if (!clockEval.pass) {
    return buildBlockedResult({ status: 'CLOCK_SYNC_INVALID', reason: clockEval.reason, manifest, extraIssues: issues, nav, sender, clockEval });
  }

  const normalizedSamples = sender.samples.map((s) => ({
    ...s,
    normalizedSourceTimeMs: s.sourceTimestampValid ? s.source_timestamp_ms + sender.clockOffset.offsetMs : null,
  }));

  const checkpointResult = computeCheckpoints({
    routeActives: nav.routeActives,
    samples: normalizedSamples,
    navOffsetMs: nav.clockOffset.offsetMs,
    uncertaintyMs: clockEval.uncertaintyMs,
    criteria,
    allSamplesById: sender.allSamplesById,
  });

  if (checkpointResult.wholeRunStatus) {
    return buildBlockedResult({ status: checkpointResult.wholeRunStatus, reason: checkpointResult.wholeRunReason, manifest, extraIssues: issues, nav, sender, clockEval });
  }

  const results = checkpointResult.results.map((r) => ({
    ...r,
    clock_sync_navigation: nav.clockSyncRaw,
    clock_sync_sender: sender.clockSyncRaw,
    estimated_uncertainty_ms: clockEval.uncertaintyMs,
  }));

  return { manifest_issues: issues, results, summary: buildSummary(manifest, results, null) };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i++; }
    }
  }
  return args;
}

function printTable(results) {
  console.error('--- M3 Table 4.4 support (meters, or N/A) ---');
  console.table(results.map((r) => ({
    checkpoint_m: r.checkpoint_m,
    m3_distance_m: r.m3_distance_m === null ? 'N/A' : Number(r.m3_distance_m.toFixed(2)),
    status: r.status,
    join_mode: r.join_mode ?? '-',
  })));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.navigation || !args.sender || !args.manifest || !args.criteria) {
    console.error('Usage: node scripts/analyze-m3.mjs --navigation <nav.jsonl> --sender <sender.jsonl> --manifest <manifest.json> --criteria <criteria.json> [--table]');
    process.exit(2);
  }
  const navigationEvents = parseJsonl(readFileSync(args.navigation, 'utf8'));
  const senderEvents = parseJsonl(readFileSync(args.sender, 'utf8'));
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  const criteria = JSON.parse(readFileSync(args.criteria, 'utf8'));

  const result = analyzeRun({ navigationEvents, senderEvents, manifest, criteria });
  if (args.table) printTable(result.results);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.summary.run_validity === 'INVALID' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
