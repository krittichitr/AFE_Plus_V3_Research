#!/usr/bin/env node
// M3-PROTOCOL-V2: read-only, Phone A performance.now() timeline.
// V1 and its calibration tools remain independent and unchanged.
// CLI: --manifest <json> --criteria <json> [--navigation <jsonl> --sender <jsonl>] [--table]
// Relative manifest paths resolve against the manifest directory; overrides must
// resolve to the same real files. No output files are written by this tool.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { haversineMeters, isValidLatLng } from './m3-haversine.mjs';
import { summarizeM3Calibration } from './m3-calibration-core.mjs';

export const PROTOCOL_VERSION = 'M3-PROTOCOL-V2';
const SYSTEMS = { 'AFE-Plus V.2': 'V2', 'D-TANS': 'V3' };
const text = (v) => typeof v === 'string' && v.length > 0;
const nonnegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
// Precision is serialization arithmetic, not a research threshold. All local
// times are rounded to integer microseconds once, then compared as integers.
const us = (ms) => Math.round(ms * 1000);
const validTime = (v) => nonnegative(v) && Number.isSafeInteger(us(v));
const countBy = (items, key) => items.reduce((a, x) => {
  const k = String(x[key]); a[k] = (a[k] ?? 0) + 1; return a;
}, {});

export function parseJsonlV2(input) {
  return input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`INVALID_JSONL:line_${index + 1}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !text(value.event)) {
      throw new Error(`INVALID_JSONL:record_${index + 1}`);
    }
    return [value];
  });
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, min: null, mean: null, median: null, p95: null, max: null };
  // Linear interpolation: h=(n-1)*p, interpolate adjacent sorted values.
  const q = (p) => {
    const h = (sorted.length - 1) * p, i = Math.floor(h);
    return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (h - i);
  };
  return { n: sorted.length, min: sorted[0], mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: q(0.5), p95: q(0.95), max: sorted.at(-1) };
}

export function validateManifestV2(m) {
  const errors = [];
  if (m?.schema_version !== 'm3-manifest-v2' || m?.protocol_version !== PROTOCOL_VERSION) errors.push('MANIFEST_VERSION');
  if (!Object.hasOwn(SYSTEMS, m?.system ?? '')) errors.push('MANIFEST_SYSTEM');
  for (const part of ['navigation', 'sender']) {
    if (!text(m?.[part]?.file)) errors.push(`MANIFEST_${part.toUpperCase()}_FILE`);
    const hash = m?.[part]?.sha256;
    if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) errors.push(`MANIFEST_${part.toUpperCase()}_HASH`);
  }
  if (!text(m?.navigation?.session_id)) errors.push('MANIFEST_NAVIGATION_SESSION');
  if (!text(m?.sender?.sender_session_id)) errors.push('MANIFEST_SENDER_SESSION');
  if (m?.analysis_scope?.policy !== 'single_continuous_navigation_session' || m?.analysis_scope?.end_policy !== 'run_stop') errors.push('MANIFEST_SCOPE');
  if (m?.analysis_scope?.end_mono_ms !== undefined && !validTime(m.analysis_scope.end_mono_ms)) errors.push('MANIFEST_SCOPE_END');
  if (m?.observation_start_policy !== 'linkage_ready_plus_configured_startup_stabilization') errors.push('MANIFEST_START_POLICY');
  for (const key of ['linkage_ready_mono_ms', 'effective_start_mono_ms', 'start_mono_ms']) {
    if (m && (Object.hasOwn(m, key) || Object.hasOwn(m.analysis_scope ?? {}, key))) errors.push('MANIFEST_DERIVED_START_INPUT');
  }
  return { valid: !errors.length, errors };
}

export function validateCriteriaV2(c) {
  const errors = [];
  if (c?.schema_version !== 'm3-criteria-v2' || c?.protocol_version !== PROTOCOL_VERSION) errors.push('criteria_version');
  if (!text(c?.criteria_id)) errors.push('criteria_id');
  if (!validTime(c?.observation_interval_ms) || us(c.observation_interval_ms) <= 0) errors.push('observation_interval_ms');
  if (!validTime(c?.max_sample_freshness_age_ms)) errors.push('max_sample_freshness_age_ms');
  const gps = c?.gps_quality_policy;
  if (gps?.mode === 'thresholds') {
    for (const key of ['max_accuracy_m', 'max_speed_mps']) if (!nonnegative(gps[key])) errors.push(`gps.${key}`);
    for (const key of ['missing_accuracy', 'missing_speed', 'missing_source_timestamp']) {
      if (!['reject', 'allow'].includes(gps[key])) errors.push(`gps.${key}`);
    }
  } else if (gps?.mode !== 'diagnostic_only') errors.push('gps_quality_policy');
  const startup = c?.startup_stabilization_policy;
  if (startup?.mode === 'fixed_duration') {
    if (!validTime(startup.duration_ms)) errors.push('startup.duration_ms');
  } else if (startup?.mode !== 'none') errors.push('startup_stabilization_policy');
  const gap = c?.unresolved_gps_gap_policy;
  if (gap?.mode === 'reject') {
    if (!nonnegative(gap.max_source_gap_ms) || gap.max_source_gap_ms === 0) errors.push('gap.max_source_gap_ms');
    if (typeof gap.reject_rejected_callbacks !== 'boolean') errors.push('gap.reject_rejected_callbacks');
  } else if (gap?.mode !== 'diagnostic_only') errors.push('unresolved_gps_gap_policy');
  return { valid: !errors.length, errors };
}

function navigationLog(events, manifest) {
  const issues = [], version = SYSTEMS[manifest.system];
  if (!Array.isArray(events) || !events.length) return { issues: ['INCOMPLETE_NAVIGATION_LOG'], primary: [] };
  const starts = events.filter((e) => e?.event === 'run_start');
  const stops = events.filter((e) => e?.event === 'run_stop');
  const healths = events.filter((e) => e?.event === 'logger_health');
  const start = starts[0], stop = stops[0], health = healths[0];
  if (starts.length !== 1 || stops.length !== 1 || healths.length !== 1 || events[0] !== start || events.at(-1) !== health) issues.push('INCOMPLETE_NAVIGATION_LOG');
  if (!validTime(start?.mono_ms) || !validTime(stop?.mono_ms) || !validTime(health?.mono_ms) ||
      us(stop?.mono_ms) < us(start?.mono_ms) || us(health?.mono_ms) < us(stop?.mono_ms)) issues.push('INVALID_LOCAL_TIME');
  if (events.some((e, i) => !e || e.event_seq !== i + 1 || e.system_version !== version)) issues.push('INVALID_EVENT_SEQUENCE_OR_SYSTEM');
  if (health?.dropped_events !== 0) issues.push('DROPPED_OR_UNKNOWN_EVENTS');
  const stored = events.length - 1;
  if (version === 'V2') {
    if (health?.total_events !== stored) issues.push('LOGGER_HEALTH_COUNT_MISMATCH');
  } else {
    if (health?.stored_events !== stored || health?.attempted_events !== stored) issues.push('LOGGER_HEALTH_COUNT_MISMATCH');
    if (events.some((e) => !integer(e.monotonic_us))) issues.push('INVALID_LOCAL_TIME');
    if (!health?.dropped_by_event || typeof health.dropped_by_event !== 'object' || Array.isArray(health.dropped_by_event) ||
        Object.values(health.dropped_by_event).some((n) => n !== 0) ||
        ['first_dropped_event_seq', 'last_dropped_event_seq', 'first_dropped_monotonic_us', 'last_dropped_monotonic_us']
          .some((key) => health[key] !== null) || health.high_water_mark !== stored) issues.push('LOGGER_HEALTH_DROP_MISMATCH');
  }
  const primary = [];
  let previousUs = validTime(start?.mono_ms) ? us(start.mono_ms) : 0;
  let previousActivation = null;
  for (const e of events) {
    // Backend import timestamps are not route activation/Target receipt times.
    if (e?.event !== 'route_active' && e?.event !== 'target_received') continue;
    if (e.source === 'backend') continue;
    if (!validTime(e.mono_ms) || us(e.mono_ms) < previousUs || us(e.mono_ms) > us(stop?.mono_ms) || e.event_seq > stop?.event_seq) {
      issues.push('INVALID_LOCAL_TIME'); continue;
    }
    previousUs = us(e.mono_ms);
    if (e.event === 'route_active') {
      if (e.session_id !== manifest.navigation.session_id) issues.push('NAVIGATION_SESSION_MISMATCH');
      if (!text(e.route_update_id) || !integer(e.route_activation_seq) || e.route_activation_seq === 0 ||
          (previousActivation !== null && e.route_activation_seq <= previousActivation)) issues.push('INVALID_ROUTE_IDENTITY');
      previousActivation = e.route_activation_seq;
    } else if (e.session_id !== undefined && e.session_id !== manifest.navigation.session_id) issues.push('NAVIGATION_SESSION_MISMATCH');
    primary.push({ ...e, time_us: us(e.mono_ms) });
  }
  // Hot V3 events have monotonic_us without mono_ms. Validate their own clock
  // structurally; never substitute them for primary raw performance.now times.
  if (events.some((e) => e.mono_ms !== undefined && !validTime(e.mono_ms))) issues.push('INVALID_LOCAL_TIME');
  if (stop && start && stop.event_seq <= start.event_seq) issues.push('INCOMPLETE_NAVIGATION_LOG');
  return { issues: [...new Set(issues)], primary: primary.sort((a, b) => a.time_us - b.time_us || a.event_seq - b.event_seq),
    start, stop, health, status: issues.length ? 'INVALID' : 'VERIFIED',
    end_us: validTime(stop?.mono_ms) ? us(stop.mono_ms) : null };
}

function senderLog(events, session) {
  const issues = [];
  if (!Array.isArray(events) || events.some((e) => !e || !text(e.event))) return { issues: ['INCOMPLETE_SENDER_LOG'], selected: [], samples: new Map() };
  const selected = events.filter((e) => e.sender_session_id === session);
  const starts = selected.filter((e) => e.event === 'sender_start'), stops = selected.filter((e) => e.event === 'sender_stop');
  if (!selected.length) issues.push('SENDER_SESSION_MISMATCH');
  else if (starts.length !== 1 || stops.length !== 1 || selected[0] !== starts[0] || selected.indexOf(stops[0]) < selected.indexOf(starts[0])) issues.push('INCOMPLETE_SENDER_LOG');
  const samples = new Map(), ids = new Map(), sequences = new Set();
  // A claimed ID must be unique throughout the explicit file, even if a
  // corrupt record puts the same ID under a different session field.
  for (const e of events.filter((e) => e.event === 'target_sample')) ids.set(e.target_sample_id, (ids.get(e.target_sample_id) ?? 0) + 1);
  let previousSequence = 0;
  for (const e of selected.filter((e) => e.event === 'target_sample')) {
    if (ids.get(e.target_sample_id) !== 1) issues.push('DUPLICATE_TARGET_SAMPLE_ID');
    if (!Number.isSafeInteger(e.sequence) || e.sequence <= previousSequence || sequences.has(e.sequence) ||
        e.target_sample_id !== `${session}:T${String(e.sequence).padStart(6, '0')}`) issues.push('SAMPLE_SESSION_SEQUENCE_MISMATCH');
    previousSequence = e.sequence; sequences.add(e.sequence);
    if (!isValidLatLng({ lat: e.target_lat, lng: e.target_lng })) issues.push('INVALID_SENDER_COORDINATE');
    if (selected.indexOf(e) > selected.indexOf(stops[0])) issues.push('INCOMPLETE_SENDER_LOG');
    samples.set(e.target_sample_id, e);
  }
  return { issues: [...new Set(issues)], selected, samples, allIds: ids,
    other_sessions: [...new Set(events.map((e) => e.sender_session_id).filter((id) => id && id !== session))] };
}

function verifyReference(e, sender, session) {
  if (!e) return { status: 'UNAVAILABLE', reason: 'MISSING_REFERENCE' };
  if (e.target_sample_id == null || e.target_sample_id === '') return { status: 'UNAVAILABLE', reason: 'MISSING_SAMPLE_ID' };
  if (!text(e.target_sample_id)) return { status: 'MISMATCH', reason: 'INVALID_SAMPLE_ID' };
  const delimiter = e.target_sample_id.lastIndexOf(':T');
  if (delimiter < 1 || !/^\d+$/.test(e.target_sample_id.slice(delimiter + 2))) return { status: 'MISMATCH', reason: 'INVALID_SAMPLE_ID' };
  if (e.target_sample_id.slice(0, delimiter) !== session) return { status: 'FOREIGN_SESSION', reason: 'SENDER_SESSION_MISMATCH' };
  const sample = sender.samples.get(e.target_sample_id);
  if (!sample) return { status: 'MISMATCH', reason: 'CLAIMED_SAMPLE_MISSING' };
  if (sender.allIds.get(e.target_sample_id) !== 1) return { status: 'MISMATCH', reason: 'DUPLICATE_TARGET_SAMPLE_ID' };
  if (!isValidLatLng({ lat: e.target_ref_lat, lng: e.target_ref_lng }) ||
      e.target_ref_lat !== sample.target_lat || e.target_ref_lng !== sample.target_lng) return { status: 'MISMATCH', reason: 'REFERENCE_COORDINATE_MISMATCH' };
  return { status: 'VERIFIED', reason: null, sample };
}

function supportingQuality(sample, sender, criteria) {
  const reasons = [], gps = criteria.gps_quality_policy, gap = criteria.unresolved_gps_gap_policy;
  if (gps.mode === 'thresholds') {
    for (const [field, max, missing] of [['accuracy_m', gps.max_accuracy_m, gps.missing_accuracy], ['speed_mps', gps.max_speed_mps, gps.missing_speed]]) {
      if (sample[field] == null) { if (missing === 'reject') reasons.push(`MISSING_${field.toUpperCase()}`); }
      else if (!nonnegative(sample[field]) || sample[field] > max) reasons.push(`REJECTED_${field.toUpperCase()}`);
    }
    if (!nonnegative(sample.source_timestamp_ms) && gps.missing_source_timestamp === 'reject') reasons.push('MISSING_SOURCE_TIMESTAMP');
  }
  if (gap.mode === 'reject') {
    const previous = sender.samples.get(`${sample.sender_session_id}:T${String(sample.sequence - 1).padStart(6, '0')}`);
    if (sample.sequence > 1 && !previous) reasons.push('UNRESOLVED_GPS_GAP');
    if (previous) {
      const dt = sample.source_timestamp_ms - previous.source_timestamp_ms;
      if (!Number.isFinite(sample.source_timestamp_ms) || !Number.isFinite(previous.source_timestamp_ms) || dt <= 0 || dt > gap.max_source_gap_ms) reasons.push('UNRESOLVED_GPS_GAP');
      if (gap.reject_rejected_callbacks && sender.selected.some((e) => e.event === 'gps_observation_rejected' &&
          (!Number.isSafeInteger(e.callback_index) || !Number.isSafeInteger(previous.callback_index) || !Number.isSafeInteger(sample.callback_index) ||
          (e.callback_index > previous.callback_index && e.callback_index < sample.callback_index)))) reasons.push('UNRESOLVED_GPS_GAP');
    }
  }
  return { status: reasons.length ? 'REJECTED' : 'ACCEPTED', reasons: [...new Set(reasons)] };
}

function scanTimeline(primary, sender, session) {
  const states = [], issues = [], firstSeen = new Map();
  let route = null, receipt = null, repeated = false, ready = null, repeatedReceipts = 0;
  const provenance = { route: {}, receipt: {} };
  for (let i = 0; i < primary.length;) {
    const time = primary[i].time_us;
    do {
      const e = primary[i++], verified = verifyReference(e, sender, session);
      const kind = e.event === 'route_active' ? 'route' : 'receipt';
      provenance[kind][verified.status] = (provenance[kind][verified.status] ?? 0) + 1;
      if (verified.status === 'MISMATCH' || (ready !== null && verified.status === 'FOREIGN_SESSION')) issues.push(`${verified.reason}:event_${e.event_seq}`);
      if (kind === 'route') route = e;
      else {
        receipt = e; repeated = text(e.target_sample_id) && firstSeen.has(e.target_sample_id);
        if (repeated) repeatedReceipts++;
        if (text(e.target_sample_id) && !firstSeen.has(e.target_sample_id)) firstSeen.set(e.target_sample_id, time);
      }
    } while (i < primary.length && primary[i].time_us === time);
    const rv = verifyReference(route, sender, session), tv = verifyReference(receipt, sender, session);
    if (ready === null && rv.status === 'VERIFIED' && tv.status === 'VERIFIED') ready = time;
    states.push({ time_us: time, route, receipt, repeated, first_seen_us: receipt ? firstSeen.get(receipt.target_sample_id) ?? null : null,
      route_verification: rv, receipt_verification: tv });
  }
  return { states, ready_us: ready, issues: [...new Set(issues)], provenance, repeated_receipts: repeatedReceipts };
}

function observation(state, tick, index, context) {
  const { route, receipt, route_verification: rv, receipt_verification: tv } = state;
  const first = state.first_seen_us;
  const row = {
    observation_index: index, observation_mono_ms: tick / 1000,
    linkage_ready_mono_ms: context.ready / 1000, effective_start_mono_ms: context.start / 1000,
    route_update_id: route?.route_update_id ?? null, route_version: route?.route_version ?? null,
    route_activation_seq: route?.route_activation_seq ?? null, route_event_seq: route?.event_seq ?? null,
    route_event_mono_ms: route ? route.time_us / 1000 : null,
    route_target_sample_id: route?.target_sample_id ?? null, route_target_lat: route?.target_ref_lat ?? null, route_target_lng: route?.target_ref_lng ?? null,
    latest_received_target_sample_id: receipt?.target_sample_id ?? null,
    latest_received_target_lat: receipt?.target_ref_lat ?? null, latest_received_target_lng: receipt?.target_ref_lng ?? null,
    target_received_event_seq: receipt?.event_seq ?? null, latest_receipt_nav_mono_ms: receipt ? receipt.time_us / 1000 : null,
    first_seen_nav_mono_ms: first === null ? null : first / 1000,
    receipt_age_ms: receipt ? (tick - receipt.time_us) / 1000 : null,
    sample_freshness_age_ms: first === null ? null : (tick - first) / 1000,
    repeated_sample_id: state.repeated,
    m3_distance_m: null, status: 'NA', diagnostic_reason: null, warnings: [...context.warnings],
    route_provenance_verification_status: rv.status, receipt_provenance_verification_status: tv.status,
    gps_quality_status: { route: 'NOT_EVALUATED', receipt: 'NOT_EVALUATED' },
  };
  if (rv.status !== 'VERIFIED' || tv.status !== 'VERIFIED') {
    row.diagnostic_reason = rv.status !== 'VERIFIED' ? `ROUTE_${rv.reason}` : `TARGET_${tv.reason}`; return row;
  }
  const rq = supportingQuality(rv.sample, context.sender, context.criteria), tq = supportingQuality(tv.sample, context.sender, context.criteria);
  row.gps_quality_status = { route: rq, receipt: tq };
  if (rq.status !== 'ACCEPTED' || tq.status !== 'ACCEPTED') { row.diagnostic_reason = 'GPS_QUALITY_REJECTED'; return row; }
  if (tick - first > us(context.criteria.max_sample_freshness_age_ms)) { row.diagnostic_reason = 'STALE_TARGET_SAMPLE'; return row; }
  row.m3_distance_m = haversineMeters({ lat: route.target_ref_lat, lng: route.target_ref_lng }, { lat: receipt.target_ref_lat, lng: receipt.target_ref_lng });
  row.status = 'OK'; return row;
}

/** Explicit paired arrays for controlled fixtures/integration. File users should
 * use analyzeFilesV2 so canonical path/hash binding is verified before parsing. */
export function analyzeRunV2({ navigationEvents, senderEvents, manifest, criteria, inputFiles = null }) {
  const observations = [], warnings = [], issues = [];
  const summary = {
    schema_version: 'm3-summary-v2', protocol_version: PROTOCOL_VERSION, criteria_id: criteria?.criteria_id ?? null,
    system: manifest?.system ?? null, navigation_run_id_label: null, sender_run_id_label: null,
    navigation_session_id: manifest?.navigation?.session_id ?? null, sender_session_id: manifest?.sender?.sender_session_id ?? null,
    analysis_scope: manifest?.analysis_scope ?? null, canonical_time: 'Phone A performance.now mono_ms rounded to integer microseconds',
    quantile_method: 'linear_interpolation_h=(n-1)*p', input_files: inputFiles,
    run_validity: 'INVALID', diagnostic_reason: null, warnings,
    linkage_ready_mono_ms: null, effective_start_mono_ms: null,
    startup_policy: criteria?.startup_stabilization_policy ?? null, startup_status: 'NOT_EVALUATED',
    observation_count: 0, valid_count: 0, na_count: 0, na_count_by_reason: {},
    pre_linkage_diagnostic_count: 0, startup_diagnostic_count: 0, repeated_sample_count: 0, repeated_sample_receipt_count: 0, stale_target_sample_count: 0,
    m3_distance_m: distribution([]), receipt_age_ms: { all: distribution([]), valid: distribution([]) },
    sample_freshness_age_ms: { all: distribution([]), valid: distribution([]) },
    provenance_counts: { route: {}, receipt: {} }, observation_provenance_counts: { route: {}, receipt: {} },
    logger_health: { status: 'NOT_EVALUATED', dropped_events: null },
    clock_sync_summary: null, gps_supporting_quality_summary: null,
  };
  const diagnostics = { pre_linkage: [], startup: [], calibration: null, criteria_errors: [], other_sender_sessions: [] };
  const result = { schema_version: 'm3-analysis-v2', protocol_version: PROTOCOL_VERSION, observations, summary, diagnostics, issues };
  const finish = (validity, reason) => { summary.run_validity = validity; summary.diagnostic_reason = reason; return result; };
  const mc = validateManifestV2(manifest);
  if (!mc.valid) { issues.push(...mc.errors); return finish('INVALID', 'MANIFEST_INVALID'); }
  const nav = navigationLog(navigationEvents, manifest), sender = senderLog(senderEvents, manifest.sender.sender_session_id);
  issues.push(...nav.issues, ...sender.issues);
  summary.logger_health = { status: nav.status ?? 'INVALID', dropped_events: nav.health?.dropped_events ?? null, record: nav.health ?? null };
  summary.navigation_run_id_label = nav.start?.research_run_id ?? null;
  summary.sender_run_id_label = sender.selected.find((e) => e.event === 'sender_start')?.research_run_id ?? null;
  summary.navigation_run_id_labels = [...new Set((navigationEvents ?? []).map((e) => e?.research_run_id ?? null))];
  summary.sender_run_id_labels = [...new Set(sender.selected.map((e) => e.research_run_id ?? null))];
  if (summary.navigation_run_id_label !== summary.sender_run_id_label) warnings.push('RUN_ID_LABEL_MISMATCH');
  if (summary.navigation_run_id_labels.length > 1 || summary.sender_run_id_labels.length > 1) warnings.push('MULTIPLE_RUN_ID_LABELS');
  diagnostics.other_sender_sessions = sender.other_sessions ?? [];
  if (issues.length) return finish('INVALID', issues[0]);
  // Existing helper is scoped to the explicit selected Sender only and never
  // consulted for primary selection/validity. Distance/clock issues are output.
  diagnostics.calibration = summarizeM3Calibration({ navigationEvents, senderEvents: sender.selected });
  summary.clock_sync_summary = Object.fromEntries(Object.entries(diagnostics.calibration.clock).map(([device, clock]) => [device, {
    role: 'DIAGNOSTIC_ONLY', round_count: clock.round_count, successful_rounds: clock.successful_rounds,
    failed_rounds: clock.failed_rounds, incomplete_rounds: clock.incomplete_rounds.length, rtt_ms: clock.rtt_ms,
  }]));
  summary.gps_supporting_quality_summary = {
    selected_sender_sample_count: diagnostics.calibration.gps.sample_count,
    rejected_callback_count: diagnostics.calibration.gps.rejected_callback_count,
    accuracy_m: diagnostics.calibration.gps.accuracy_m,
    nonpositive_source_time_count: diagnostics.calibration.gps.nonpositive_source_time_count,
    route_observation_status_counts: {}, receipt_observation_status_counts: {},
  };
  const end = manifest.analysis_scope.end_mono_ms === undefined ? nav.end_us : us(manifest.analysis_scope.end_mono_ms);
  if (end > nav.end_us || end < us(nav.start.mono_ms)) return finish('INVALID', 'ANALYSIS_SCOPE_OUT_OF_BOUNDS');
  summary.analysis_scope = { ...manifest.analysis_scope, end_mono_ms: end / 1000 };
  const primary = nav.primary.filter((e) => e.time_us <= end);
  const scan = scanTimeline(primary, sender, manifest.sender.sender_session_id);
  issues.push(...scan.issues); summary.provenance_counts = scan.provenance;
  summary.linkage_ready_mono_ms = scan.ready_us === null ? null : scan.ready_us / 1000;
  for (const state of scan.states.filter((s) => scan.ready_us === null || s.time_us < scan.ready_us)) {
    diagnostics.pre_linkage.push({ mono_ms: state.time_us / 1000, route_event_seq: state.route?.event_seq ?? null,
      receipt_event_seq: state.receipt?.event_seq ?? null, route_status: state.route_verification.status, receipt_status: state.receipt_verification.status });
  }
  summary.pre_linkage_diagnostic_count = primary.filter((e) => scan.ready_us === null || e.time_us < scan.ready_us).length;
  summary.repeated_sample_receipt_count = scan.repeated_receipts;
  if (issues.length) return finish('INVALID', issues[0]);
  const cc = validateCriteriaV2(criteria); diagnostics.criteria_errors = cc.errors;
  if (!cc.valid) { summary.startup_status = 'CRITERIA_UNCONFIGURED'; return finish('NO_OFFICIAL_RESULT', 'CRITERIA_UNCONFIGURED'); }
  if (scan.ready_us === null) return finish('NO_OFFICIAL_RESULT', 'INTENDED_LINKAGE_NOT_ESTABLISHED');
  const duration = criteria.startup_stabilization_policy.mode === 'none' ? 0 : us(criteria.startup_stabilization_policy.duration_ms);
  const start = scan.ready_us + duration;
  if (!Number.isSafeInteger(start) || start > end) { summary.startup_status = 'NOT_COMPLETED'; return finish('NO_OFFICIAL_RESULT', 'STARTUP_NOT_COMPLETED_WITHIN_SCOPE'); }
  summary.effective_start_mono_ms = start / 1000; summary.startup_status = 'COMPLETED';
  diagnostics.startup = primary.filter((e) => e.time_us >= scan.ready_us && e.time_us < start).map((e) => ({ event: e.event, event_seq: e.event_seq, mono_ms: e.time_us / 1000 }));
  summary.startup_diagnostic_count = diagnostics.startup.length;
  const interval = us(criteria.observation_interval_ms);
  const total = Math.floor((end - start) / interval) + 1;
  // Operational resource guard, not a research gate/threshold: refuse rather
  // than silently truncate a grid. Interval still has no inferred default.
  if (!Number.isSafeInteger(total) || total > 1_000_000) return finish('NO_OFFICIAL_RESULT', 'OBSERVATION_OUTPUT_LIMIT_EXCEEDED');
  let cursor = 0;
  for (let k = 0; k < total; k++) {
    const tick = start + k * interval;
    while (cursor + 1 < scan.states.length && scan.states[cursor + 1].time_us <= tick) cursor++;
    observations.push(observation(scan.states[cursor], tick, k, { ready: scan.ready_us, start, criteria, sender, warnings }));
  }
  const valid = observations.filter((e) => e.status === 'OK'), na = observations.filter((e) => e.status === 'NA');
  summary.observation_count = observations.length; summary.valid_count = valid.length; summary.na_count = na.length;
  summary.na_count_by_reason = countBy(na, 'diagnostic_reason');
  summary.repeated_sample_count = observations.filter((e) => e.repeated_sample_id).length;
  summary.stale_target_sample_count = na.filter((e) => e.diagnostic_reason === 'STALE_TARGET_SAMPLE').length;
  summary.m3_distance_m = distribution(valid.map((e) => e.m3_distance_m));
  for (const age of ['receipt_age_ms', 'sample_freshness_age_ms']) summary[age] = {
    all: distribution(observations.map((e) => e[age])), valid: distribution(valid.map((e) => e[age])),
  };
  summary.observation_provenance_counts = { route: countBy(observations, 'route_provenance_verification_status'), receipt: countBy(observations, 'receipt_provenance_verification_status') };
  for (const kind of ['route', 'receipt']) summary.gps_supporting_quality_summary[`${kind}_observation_status_counts`] =
    countBy(observations.map((e) => ({ status: typeof e.gps_quality_status[kind] === 'string' ? e.gps_quality_status[kind] : e.gps_quality_status[kind].status })), 'status');
  return finish(valid.length ? 'VALID' : 'NO_OFFICIAL_RESULT', valid.length ? null : 'ZERO_VALID_OBSERVATIONS');
}

export function analyzeFilesV2({ manifestPath, criteriaPath, navigationPath, senderPath }) {
  let manifest = null, criteria = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    criteria = JSON.parse(readFileSync(criteriaPath, 'utf8'));
    const checked = validateManifestV2(manifest);
    if (!checked.valid) return analyzeRunV2({ manifest, criteria, navigationEvents: [], senderEvents: [] });
    const inputs = {};
    for (const [part, override] of [['navigation', navigationPath], ['sender', senderPath]]) {
      const declared = realpathSync(resolve(dirname(resolve(manifestPath)), manifest[part].file));
      if (override && realpathSync(resolve(override)) !== declared) throw new Error('MANIFEST_FILE_BINDING_MISMATCH');
      const bytes = readFileSync(declared), sha256 = createHash('sha256').update(bytes).digest('hex');
      if (manifest[part].sha256 !== undefined && manifest[part].sha256 !== sha256) throw new Error('MANIFEST_HASH_MISMATCH');
      inputs[part] = { file: declared, sha256, events: parseJsonlV2(bytes.toString('utf8')) };
    }
    return analyzeRunV2({ manifest, criteria, navigationEvents: inputs.navigation.events, senderEvents: inputs.sender.events,
      inputFiles: { navigation: { file: inputs.navigation.file, sha256: inputs.navigation.sha256 }, sender: { file: inputs.sender.file, sha256: inputs.sender.sha256 } } });
  } catch (error) {
    const result = analyzeRunV2({ manifest, criteria, navigationEvents: [], senderEvents: [] });
    result.summary.run_validity = 'INVALID'; result.summary.diagnostic_reason = 'INPUT_FILE_ERROR';
    result.issues = [error.message]; return result;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = {};
  let badArgs = false;
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--table') args.table = true;
    else if (['--manifest', '--criteria', '--navigation', '--sender'].includes(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[key.slice(2)] = process.argv[++i];
    else badArgs = true;
  }
  if (badArgs || !args.manifest || !args.criteria) {
    console.error('Usage: node scripts/analyze-m3-v2.mjs --manifest <json> --criteria <json> [--navigation <jsonl> --sender <jsonl>] [--table]');
    process.exitCode = 2;
  } else {
    const result = analyzeFilesV2({ manifestPath: args.manifest, criteriaPath: args.criteria, navigationPath: args.navigation, senderPath: args.sender });
    if (args.table) {
      console.error('index\tmono_ms\tdistance_m\treceipt_age_ms\tsample_freshness_age_ms\treason');
      for (const e of result.observations) console.error([e.observation_index, e.observation_mono_ms, e.m3_distance_m ?? 'N/A',
        e.receipt_age_ms, e.sample_freshness_age_ms, e.diagnostic_reason ?? 'OK'].join('\t'));
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.summary.run_validity === 'VALID' ? 0 : 1;
  }
}
