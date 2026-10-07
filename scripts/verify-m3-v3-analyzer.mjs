#!/usr/bin/env node
// Synthetic deterministic cases. No Main data, network, runtime or thresholds.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { analyzeRunV3, analyzeFilesV3, distribution, parseJsonl, parseSampleId, validateManifest, ConfigurationError } from './analyze-m3-v3.mjs';
import { haversineMeters, EARTH_RADIUS_M } from './m3-haversine.mjs';

const CURRENT = '11111111-1111-4111-8111-111111111111', OLD = '22222222-2222-4222-8222-222222222222';
const NAV = 'nav-session', RUN = 'Synthetic Navigation label';
const id = (n, session = CURRENT) => n == null ? null : `${session}:T${String(n).padStart(6, '0')}`;
const point = (n) => ({ lat: 13 + n * 0.001, lng: 100 });
const ref = (n, extra = {}) => ({ target_sample_id: id(n), target_ref_lat: point(n ?? 2).lat, target_ref_lng: point(n ?? 2).lng, ...extra });
const receipt = (time, n, extra = {}) => ({ event: 'target_received', mono_ms: time, ...ref(n), ...extra });
const active = (time, update, seq, n, extra = {}) => ({ event: 'route_active', mono_ms: time, session_id: NAV,
  route_update_id: update, route_activation_seq: seq, route_version: seq, route_signature: `signature-${seq}`,
  research_request_phase: seq === 1 ? 'init' : 'incremental', ...ref(n), ...extra });
const start = (time, update, n = 2, system = 'V3', extra = {}) => ({ event: 'm1_frontend_start', mono_ms: time,
  source: 'frontend', clock_domain: 'browser_performance', session_id: NAV, route_update_id: update,
  target_sample_id: id(n), update_type: system === 'V2' ? 'normal' : 'incremental', ...extra });
const end = (time, update, duration = 3, n = 2, seq = 2, system = 'V3', extra = {}) => ({ event: 'm1_frontend_end', mono_ms: time,
  source: 'frontend', clock_domain: 'browser_performance', session_id: NAV, route_update_id: update,
  target_sample_id: id(n), update_type: system === 'V2' ? 'normal' : 'incremental', m1_eligible: true, success: true,
  route_activation_seq: seq, route_version: seq, duration_ms: duration, ...extra });
const outcome = (time, update, reason, system = 'V3', extra = {}) => ({ event: 'm1_frontend_outcome', mono_ms: time,
  source: 'frontend', clock_domain: 'browser_performance', session_id: NAV, route_update_id: update,
  target_sample_id: id(2), update_type: system === 'V2' ? 'normal' : 'incremental', m1_eligible: false, success: false,
  failure_reason: reason, ...extra });
const seed = () => [receipt(1, 1), active(2, 'init', 1, 1), receipt(3, 2)];
const body = (system = 'V3') => [...seed(), start(4, 'update-1', 2, system), active(6, 'update-1', 2, 2), end(7, 'update-1', 3, 2, 2, system)];
function manifest(system = 'V3', extra = {}) {
  return { schema_version: 'm3-manifest-v3', protocol_version: 'M3-PROTOCOL-V3', system_version: system,
    navigation: { file: 'nav.jsonl', research_run_id: RUN, session_id: NAV, sha256: null }, sender: null, ...extra };
}
function log(items = body(), system = 'V3') {
  const stop = Math.max(0, ...items.map((e) => e.mono_ms)) + 1;
  const all = [{ event: 'run_start', mono_ms: 0 }, ...items, { event: 'run_stop', mono_ms: stop, dropped_events: 0 },
    { event: 'logger_health', mono_ms: stop + 1, dropped_events: 0 }];
  return all.map((e, i) => ({ system_version: system, research_run_id: RUN, ...e,
    event_seq: i + 1, mono_ms: 1000 + e.mono_ms,
    ...(system === 'V3' ? { monotonic_us: Math.round(e.mono_ms * 1000) } : {}) }));
}
function trace(nums = [1, 2, 3], session = CURRENT) {
  return nums.map((n) => ({ event: 'target_sample', sender_session_id: session, target_sample_id: id(n, session), sequence: n,
    target_lat: point(n).lat, target_lng: point(n).lng, accuracy_m: 5, speed_mps: 1, source_timestamp_ms: n * 1000,
    mono_ms: n * 765, wall_clock_ms: n * 987, research_run_id: 'Independent Sender label' }));
}
const run = ({ system = 'V3', items, events, m, sender = null, ...extra } = {}) => analyzeRunV3({
  manifest: m ?? manifest(system), navigationEvents: events ?? log(items ?? body(system), system), senderEvents: sender, ...extra });
const rows = (r) => [...r.official_observations, ...r.unavailable_successful_candidates, ...r.diagnostic_only.paired_candidates_from_invalid_run];
const row = (r, update = 'update-1') => rows(r).find((r) => r.route_update_id === update);
const errors = (r) => r.diagnostic_only.validation_errors.map((e) => e.code);
function valid(r, count = 1) {
  assert.equal(r.summary.run_validation_status, 'VALID', JSON.stringify(r.diagnostic_only.validation_errors));
  assert.equal(r.summary.successful_eligible_M1_count, count); assert.equal(r.summary.official_paired_M3_count, count);
  assert.equal(r.summary.m3_unavailable_count, 0); assert.equal(r.summary.pairing_complete, true);
  assert.equal(r.official_observations.length, count); assert.equal(r.summary.official_m3_distance_m.count, count);
}
function invalid(r, reason) {
  assert.equal(r.summary.run_validation_status, 'INVALID'); assert.equal(r.summary.pairing_complete, false);
  for (const field of ['mean', 'median', 'p95', 'max', 'min']) assert.equal(r.summary.official_m3_distance_m[field], null);
  assert.equal(r.official_observations.length, 0);
  if (reason) assert.ok(errors(r).includes(reason), `${reason}: ${JSON.stringify(errors(r))}`);
}
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
}

for (const system of ['V2', 'V3']) {
  test(`01/02 ${system} successful exact pair`, () => {
    const r = run({ system }); valid(r); const x = row(r);
    assert.equal(x.previous_route_update_id, 'init'); assert.equal(x.previous_route_activation_seq, 1);
    assert.equal(x.latest_received_target_sample_id, id(2)); assert.equal(x.new_activation_sequence, 2);
    assert.equal(x.m1_duration_ms, 3); assert.equal(x.m3_pre_replan_distance_m, haversineMeters(point(1), point(2)));
  });
  test(`03 ${system} initial excluded and activation seeds state`, () => {
    const items = system === 'V2' ? [receipt(0.5, 1), start(0.75, 'init', 1, system, { update_type: 'initial' }),
      active(2, 'init', 1, 1), outcome(2.5, 'init', 'excluded_initial', system, { update_type: 'initial', target_sample_id: id(1) }),
      receipt(3, 2), ...body(system).slice(3)] : body(system);
    const r = run({ system, items }); valid(r); assert.equal(row(r).previous_route_update_id, 'init');
    if (system === 'V2') assert.equal(r.summary.excluded_attempt_counts_by_reason.excluded_initial, 1);
  });
}
test('03b V3 first polling response is excluded', () => {
  const r = run({ items: [...seed(), start(4, 'first'), active(5, 'first', 2, 2), outcome(6, 'first', 'initial_route', 'V3', { update_type: 'initial' }),
    receipt(7, 3), start(8, 'update-1', 3), active(9, 'update-1', 3, 3), end(10, 'update-1', 2, 3, 3)] });
  valid(r); assert.equal(row(r).previous_route_update_id, 'first');
});
test('04 latest of multiple moving receipts selected; lag grows', () => {
  const r1 = run(), r2 = run({ items: [...seed(), receipt(3.25, 3), receipt(3.5, 4), ...body().slice(3)] });
  valid(r2); assert.equal(row(r2).latest_received_target_sample_id, id(4));
  assert.equal(row(r2).m3_pre_replan_distance_m, haversineMeters(point(1), point(4)));
  assert.ok(row(r2).m3_pre_replan_distance_m > row(r1).m3_pre_replan_distance_m);
});
test('05 zero discrepancy remains official numeric zero', () => {
  const r = run({ items: body().map((e) => e.event === 'route_active' && e.route_update_id === 'init' ? { ...e, ...ref(2) } : e) });
  valid(r); assert.equal(row(r).m3_pre_replan_distance_m, 0); assert.equal(r.summary.official_m3_distance_m.mean, 0);
});
test('06 equal numeric distances remain two observations', () => {
  const r = run({ items: [...body(), receipt(8, 1), start(9, 'update-2', 1), active(10, 'update-2', 3, 1), end(12, 'update-2', 3, 1, 3)] });
  valid(r, 2); assert.equal(row(r).m3_pre_replan_distance_m, row(r, 'update-2').m3_pre_replan_distance_m);
  assert.deepEqual(r.official_observations.map((e) => e.replan_index), [1, 2]);
});
test('07 repeated sample updates latest receipt but preserves first seen', () => {
  const r = run({ items: [...seed(), receipt(3.5, 2), ...body().slice(3)] }); valid(r);
  const x = row(r); assert.equal(x.latest_receipt_mono_ms, 1003.5); assert.equal(x.first_seen_mono_ms, 1003);
  assert.equal(x.receipt_age_ms, 0.5); assert.equal(x.first_seen_age_ms, 1); assert.equal(x.latest_receipt_repeated_sample, true);
  assert.equal(r.summary.repeated_sample_receipt_count, 1);
});
test('07b returned older sample stays latest without resetting first seen', () => {
  const r = run({ items: [...seed(), receipt(3.5, 1), ...body().slice(3)] }); valid(r);
  assert.equal(row(r).latest_received_target_sample_id, id(1)); assert.equal(row(r).first_seen_mono_ms, 1001);
  assert.equal(row(r).m3_pre_replan_distance_m, 0);
  assert.equal(row(r).latest_receipt_sample_sequence_regression, true);
  assert.ok(row(r).warnings.includes('LATEST_RECEIPT_SAMPLE_SEQUENCE_REGRESSION'));
});
test('08 null sample IDs with usable coordinates are valid and remain null', () => {
  const r = run({ items: body().map((e) => 'target_sample_id' in e ? { ...e, target_sample_id: null } : e) }); valid(r);
  const x = row(r); assert.equal(x.previous_route_target_sample_id, null); assert.equal(x.latest_received_target_sample_id, null);
  assert.equal(x.previous_route_provenance_status, 'NAV_COORDINATES_ONLY'); assert.equal(x.first_seen_age_ms, null);
});
test('08b opaque sample IDs remain diagnostic, not fabricated sessions', () => {
  const items = body().map((e) => 'target_sample_id' in e ? { ...e, target_sample_id: `opaque-${e.target_sample_id}` } : e);
  const r = run({ items }); valid(r); assert.equal(row(r).latest_target_sender_session_id, null);
  assert.equal(parseSampleId('anything:T1'), null);
});
test('09 new activation cannot replace the old route in frozen snapshot', () => {
  const r = run(); valid(r); assert.equal(row(r).previous_route_event_seq, 3);
  assert.notEqual(row(r).previous_route_event_seq, row(r).new_activation_event_seq);
  assert.equal(row(r).previous_route_target_sample_id, id(1));
});
test('10 future target receipt during await never leaks', () => {
  const r = run({ items: [...body().slice(0, 4), receipt(5, 50), ...body().slice(4)] }); valid(r);
  assert.equal(row(r).latest_received_target_sample_id, id(2)); assert.equal(row(r).first_seen_mono_ms, 1003);
});
test('11 equal-time lower seq known; higher seq future', () => {
  const r = run({ items: [...seed().slice(0, 2), receipt(4, 2), start(4, 'update-1'), receipt(4, 3), active(4, 'update-1', 2, 2), end(7, 'update-1')] });
  valid(r); assert.equal(row(r).latest_received_target_sample_id, id(2)); assert.equal(row(r).previous_route_target_sample_id, id(1));
});
test('12 switching same-time receipt order changes selection causally', () => {
  const before = run({ items: [...seed(), receipt(4, 3), start(4, 'update-1'), active(6, 'update-1', 2, 2), end(7, 'update-1')] });
  const after = run({ items: [...seed(), start(4, 'update-1'), receipt(4, 3), active(6, 'update-1', 2, 2), end(7, 'update-1')] });
  valid(before); valid(after); assert.equal(row(before).latest_received_target_sample_id, id(3)); assert.equal(row(after).latest_received_target_sample_id, id(2));
});
test('11b equal-time preceding activation is old state', () => {
  const r = run({ items: [...seed(), active(4, 'excluded-refetch', 2, 3), start(4, 'update-1'), active(6, 'update-1', 3, 2), end(7, 'update-1', 3, 2, 3)] });
  valid(r); assert.equal(row(r).previous_route_update_id, 'excluded-refetch');
});

for (const reason of ['blocked', 'graph_refetch', 'fallback', 'no_change', 'stale', 'superseded', 'presentation_held', 'aborted',
  'api_or_transport_error', 'rate_limited', 'invalid_response', 'failed']) {
  test(`13-19 V3 ${reason} diagnostic only despite provisional incremental start`, () => {
    const r = run({ items: [...seed(), start(4, 'excluded'), outcome(5, 'excluded', reason), ...body().slice(3).map((e) => ({ ...e, mono_ms: e.mono_ms + 3 }))] });
    valid(r); assert.equal(r.summary.excluded_attempt_counts_by_reason[reason], 1);
    assert.equal(r.diagnostic_only.excluded_attempts[0].route_update_id, 'excluded');
  });
}
for (const reason of ['graph_refetch', 'fallback']) {
  test(`14/15 V3 accepted ${reason} route seeds next eligible attempt`, () => {
    const r = run({ items: [...seed(), start(4, 'excluded'), outcome(5, 'excluded', reason, 'V3', { update_type: reason }),
      active(6, 'excluded', 2, 2), receipt(7, 3), start(8, 'update-1', 3), active(9, 'update-1', 3, 3), end(10, 'update-1', 2, 3, 3)] });
    valid(r); assert.equal(row(r).previous_route_update_id, 'excluded');
  });
}
test('16 V2 style reload excluded but activation updates old state', () => {
  const r = run({ system: 'V2', items: [...seed(), start(4, 'style', 2, 'V2', { update_type: 'style_reload' }), active(5, 'style', 2, 2),
    outcome(6, 'style', 'excluded_style_reload', 'V2', { update_type: 'style_reload' }), receipt(7, 3), start(8, 'update-1', 3, 'V2'),
    active(9, 'update-1', 3, 3), end(10, 'update-1', 2, 3, 3, 'V2')] });
  valid(r); assert.equal(row(r).previous_route_update_id, 'style'); assert.equal(r.summary.excluded_attempt_counts_by_reason.excluded_style_reload, 1);
});
test('17 V2 duplicate geometry success remains eligible', () => {
  const r = run({ system: 'V2', items: body('V2').map((e) => e.event === 'route_active' ? { ...e, route_signature: 'identical-body' } : e) }); valid(r);
});
for (const reason of ['route_error', 'no_usable_route', 'route_source_unavailable', 'unmounted', 'aborted']) {
  test(`19/20 V2 ${reason} excluded`, () => {
    const r = run({ system: 'V2', items: [...seed(), start(4, 'excluded', 2, 'V2'), outcome(5, 'excluded', reason, 'V2'),
      ...body('V2').slice(3).map((e) => ({ ...e, mono_ms: e.mono_ms + 3 }))] });
    valid(r); assert.equal(r.summary.excluded_attempt_counts_by_reason[reason], 1);
  });
}
test('20 V3 stable acceptance does not require M5 renderer/video evidence', () => {
  const r = run({ items: [...body(), { event: 'renderer_source_unavailable', mono_ms: 8 }] }); valid(r);
});
test('21 missing previous route keeps claimed success and unavailable row', () => {
  const r = run({ items: body().filter((e) => e.route_update_id !== 'init') }); invalid(r, 'MISSING_PREVIOUS_ROUTE');
  assert.equal(r.summary.successful_eligible_M1_count, 1); assert.equal(r.summary.official_paired_M3_count, 0);
  assert.equal(row(r).m3_pre_replan_distance_m, null); assert.equal(row(r).status, 'M3_UNAVAILABLE');
});
test('22 missing receipt cannot backfill from request/future receipt', () => {
  const r = run({ items: [...body().filter((e) => e.event !== 'target_received').slice(0, 2), receipt(5, 2), ...body().slice(4)] });
  invalid(r, 'MISSING_LATEST_TARGET_RECEIPT'); assert.equal(row(r).latest_received_target_sample_id, null);
});
for (const kind of ['route_active', 'target_received']) {
  test(`23 current invalid ${kind} cannot fall back to earlier valid state`, () => {
    const bad = kind === 'route_active' ? active(3.5, 'bad-route', 2, 3, { target_ref_lat: null }) : receipt(3.5, 3, { target_ref_lat: null });
    const tail = body().slice(3).map((e) => e.event === 'route_active' || e.event === 'm1_frontend_end' ? { ...e, route_activation_seq: 3, route_version: 3 } : e);
    const r = run({ items: [...seed(), bad, ...tail] }); invalid(r, 'INVALID_REFERENCE_COORDINATES');
    assert.equal(row(r).status, 'M3_UNAVAILABLE');
    if (kind === 'route_active') assert.equal(row(r).previous_route_update_id, 'bad-route');
    else assert.equal(row(r).latest_received_target_sample_id, id(3));
  });
}
for (const coordinate of [NaN, Infinity, null, '13.002', 91, -91]) {
  test(`24 invalid latitude ${String(coordinate)}`, () => {
    invalid(run({ items: body().map((e) => e.event === 'target_received' && e.target_sample_id === id(2) ? { ...e, target_ref_lat: coordinate } : e) }), 'INVALID_REFERENCE_COORDINATES');
  });
}
test('24 numeric zero coordinates are valid', () => {
  const r = run({ items: body().map((e) => 'target_ref_lat' in e ? { ...e, target_ref_lat: 0, target_ref_lng: 0 } : e) }); valid(r);
  assert.equal(row(r).m3_pre_replan_distance_m, 0);
});
for (const [field, value, reason] of [['session_id', 'other-nav', 'NAVIGATION_SESSION_MISMATCH'],
  ['research_run_id', 'other-run', 'NAVIGATION_RUN_MISMATCH'], ['system_version', 'V2', 'SYSTEM_VERSION_MISMATCH'],
  ['route_update_id', 'other-update', 'M1_START_COUNT']]) {
  test(`25 wrong terminal ${field} fails closed without denominator shrink`, () => {
    const events = log(); events.find((e) => e.event === 'm1_frontend_end')[field] = value;
    const r = run({ events }); invalid(r, reason); assert.equal(r.summary.successful_eligible_M1_count, 1);
  });
}
test('25b receipt explicitly from another Navigation session invalid', () => {
  invalid(run({ items: body().map((e) => e.event === 'target_received' ? { ...e, session_id: 'other' } : e) }), 'NAVIGATION_SESSION_MISMATCH');
});
test('26 wrong explicitly bound current Sender rejected', () => {
  const m = manifest(); m.sender = { intended_current_sender_session_ids: [OLD] };
  invalid(run({ m }), 'WRONG_CURRENT_SENDER_SESSION');
});
test('27 legitimate old-route Sender history retained and flagged', () => {
  const m = manifest(); m.sender = { intended_current_sender_session_ids: [CURRENT] };
  // The old reference is from OLD; current receipts and request remain CURRENT.
  const items = body().map((e) => e.route_update_id === 'init' ? { ...e, target_sample_id: id(1, OLD) } : e);
  const r = run({ m, items, sender: trace() }); valid(r);
  assert.equal(row(r).previous_route_provenance_status, 'TRACE_REFERENCE_NOT_FOUND');
  assert.equal(row(r).latest_target_provenance_status, 'TRACE_VERIFIED');
  assert.ok(row(r).warnings.includes('OLD_ROUTE_DIFFERENT_SENDER_SESSION'));
  assert.equal(row(r).previous_route_target_sample_id, id(1, OLD));
});
test('28 optional trace absent does not invalidate primary pair', () => {
  const r = run(); valid(r); assert.equal(row(r).previous_route_provenance_status, 'TRACE_NOT_SUPPLIED');
});
test('28b exact optional trace verifies refs and exposes GPS diagnostics only', () => {
  const samples = trace().map((e) => ({ ...e, accuracy_m: 1000000, speed_mps: 1000000 }));
  const r = run({ sender: samples }); valid(r);
  assert.equal(row(r).previous_route_provenance_status, 'TRACE_VERIFIED'); assert.equal(row(r).sender_gps_diagnostics.latest_target.accuracy_m, 1000000);
});
test('29 same claimed sample ID different coordinates is not a repeat', () => {
  invalid(run({ items: [...seed(), receipt(3.5, 2, { target_ref_lat: 14 }), ...body().slice(3)] }), 'SAMPLE_COORDINATE_CONTRADICTION');
});
test('29b trace coordinate contradiction fails closed', () => {
  invalid(run({ sender: trace().map((e) => e.sequence === 2 ? { ...e, target_lat: 14 } : e) }), 'TRACE_COORDINATE_CONTRADICTION');
});
test('30 trace identity/session contradiction rejected', () => {
  invalid(run({ sender: trace().map((e) => e.sequence === 2 ? { ...e, sender_session_id: OLD } : e) }), 'TRACE_SAMPLE_IDENTITY_CONTRADICTION');
});
test('30b ambiguous trace duplicate cannot attest', () => {
  const r = run({ sender: [...trace(), { ...trace()[1], accuracy_m: 99 }] }); invalid(r, 'AMBIGUOUS_TRACE_SAMPLE');
  assert.equal(row(r).latest_target_provenance_status, 'TRACE_AMBIGUOUS');
});
test('30c identical duplicate trace records diagnosed, do not change coordinates', () => {
  const r = run({ sender: [...trace(), { ...trace()[1] }] }); valid(r);
  assert.equal(row(r).latest_target_duplicate_trace_records, 1);
});
test('30f explicit Sender session contradicting sample ID fails closed', () => {
  invalid(run({ items: body().map((e) => e.event === 'target_received' ? { ...e, sender_session_id: OLD } : e) }), 'SAMPLE_SENDER_SESSION_CONTRADICTION');
});
test('24b invalid longitude rejected without latitude/longitude swaps', () => {
  invalid(run({ items: body().map((e) => e.event === 'target_received' ? { ...e, target_ref_lng: 181 } : e) }), 'INVALID_REFERENCE_COORDINATES');
});
test('19b malformed excluded outcome cannot masquerade as complete failed attempt', () => {
  invalid(run({ items: [...seed(), start(4, 'bad'), outcome(5, 'bad', 'failed', 'V3', { update_type: 'unknown' })] }), 'INVALID_M1_OUTCOME_TYPE');
});
test('35f duration mismatch and activation version mismatch invalidate success', () => {
  const duration = run({ items: body().map((e) => e.event === 'm1_frontend_end' ? { ...e, duration_ms: 9 } : e) }); invalid(duration, 'INVALID_M1_DURATION');
  const version = run({ items: body().map((e) => e.event === 'm1_frontend_end' ? { ...e, route_version: 9 } : e) }); invalid(version, 'NEW_ACTIVATION_IDENTITY_MISMATCH');
});
test('35g request sample identities must agree but do not replace latest receipt', () => {
  invalid(run({ items: body().map((e) => e.event === 'm1_frontend_end' ? { ...e, target_sample_id: id(9) } : e) }), 'M1_REQUEST_SAMPLE_ID_MISMATCH');
});
test('40e hot/final-health microseconds are typed, not forced into a different raw capture instant', () => {
  const events = log(); events.at(-1).monotonic_us += 100;
  valid(run({ events })); // Actual final-health writer captures us and mono separately.
  events.at(-1).monotonic_us = -1; invalid(run({ events }), 'INVALID_MONOTONIC_US');
});
for (const system of ['V2', 'V3']) {
  test(`31 ${system} drops invalid even when sequences are contiguous`, () => {
    const events = log(body(system), system); events.at(-1).dropped_events = 1;
    invalid(run({ system, events }), 'LOGGER_DROPPED_EVENTS');
  });
}
test('31b V3 dropped attempted seq gap invalid', () => {
  const events = log(); events.slice(5).forEach((e) => { e.event_seq++; }); events.at(-1).dropped_events = 1;
  invalid(run({ events }), 'EVENT_SEQUENCE_GAP');
});
test('31c nonzero dropped_by_event with total zero still invalid', () => {
  const events = log(); events.at(-1).dropped_by_event = { target_received: 1 }; invalid(run({ events }), 'LOGGER_DROPPED_EVENTS');
});
test('32 missing health invalid', () => { invalid(run({ events: log().slice(0, -1) }), 'MISSING_FINAL_LOGGER_HEALTH'); });
for (const dropped of [null, -1, 0.5, '0']) {
  test(`32 unusable health ${String(dropped)}`, () => {
    const events = log(); events.at(-1).dropped_events = dropped; invalid(run({ events }), 'UNUSABLE_LOGGER_HEALTH');
  });
}
test('32b primary clock reversal is not sorted away', () => {
  const events = log(); events.find((e) => e.event === 'm1_frontend_start').mono_ms = 1002;
  invalid(run({ events }), 'PRIMARY_CLOCK_REVERSAL');
});
test('32c sequence reversal/duplicate invalid', () => {
  const events = log(); events[4].event_seq = 3; invalid(run({ events }), 'INVALID_EVENT_SEQUENCE');
});
test('32d run stop missing and duplicate run start rejected', () => {
  const a = run({ events: log().filter((e) => e.event !== 'run_stop') }); invalid(a, 'RUN_STOP_COUNT');
  const events = log(); events[2].event = 'run_start'; invalid(run({ events }), 'RUN_START_COUNT');
});
for (const reason of ['aborted', 'presentation_held']) {
  test(`33 stop with explicit ${reason} pending closure is complete diagnostic`, () => {
    const r = run({ items: [...seed(), start(4, 'pending'), outcome(5, 'pending', reason)] });
    assert.equal(r.summary.run_validation_status, 'NO_ELIGIBLE_REPLANS'); assert.equal(r.summary.pairing_complete, true);
    assert.equal(r.summary.excluded_attempt_counts_by_reason[reason], 1);
  });
}
test('34 missing terminal is incomplete, not presumed failure', () => {
  const r = run({ items: [...seed(), start(4, 'pending')] }); invalid(r, 'INCOMPLETE_OR_DUPLICATE_M1_TERMINAL');
  assert.equal(r.diagnostic_only.excluded_attempts[0].exclusion_reason, 'INCOMPLETE_M1_CHAIN');
});
for (const missing of ['m1_frontend_start', 'route_active']) {
  test(`35 claimed successful terminal missing ${missing}`, () => {
    const r = run({ items: body().filter((e) => !(e.route_update_id === 'update-1' && e.event === missing)) });
    invalid(r); assert.equal(r.summary.successful_eligible_M1_count, 1); assert.equal(r.summary.m3_unavailable_count, 1);
  });
}
test('35b duplicate success terminals retain every claim, none official', () => {
  const r = run({ items: [...body(), end(7.5, 'update-1', 3.5)] }); invalid(r, 'INCOMPLETE_OR_DUPLICATE_M1_TERMINAL');
  assert.equal(r.summary.successful_eligible_M1_count, 2); assert.equal(r.summary.m3_unavailable_count, 2);
});
test('35c duplicate start rejected', () => {
  invalid(run({ items: [...body().slice(0, 4), start(4.5, 'update-1'), ...body().slice(4)] }), 'M1_START_COUNT');
});
test('35d duplicate activation identity rejected', () => {
  invalid(run({ items: [...body().slice(0, 5), active(6.5, 'update-1', 3, 2), end(7, 'update-1')] }), 'DUPLICATE_ACTIVATION_IDENTITY');
});
test('35e false flag on claimed end does not shrink denominator', () => {
  const r = run({ items: body().map((e) => e.event === 'm1_frontend_end' ? { ...e, success: false } : e) });
  invalid(r, 'INVALID_SUCCESSFUL_M1_CONTRACT'); assert.equal(r.summary.successful_eligible_M1_count, 1);
});
for (const position of ['before-start', 'after-terminal']) {
  test(`36 new activation ${position} rejected even with matching UUID`, () => {
    const items = position === 'before-start' ? [...seed(), active(3.5, 'update-1', 2, 2), start(4, 'update-1'), end(7, 'update-1')]
      : [...seed(), start(4, 'update-1'), end(7, 'update-1'), active(8, 'update-1', 2, 2)];
    invalid(run({ items }), 'NEW_ACTIVATION_OUTSIDE_M1_INTERVAL');
  });
}
test('37 overlapping V2 completions pair by UUID and start order', () => {
  const r = run({ system: 'V2', items: [...seed(), start(4, 'slow', 2, 'V2'), receipt(5, 3), start(6, 'fast', 3, 'V2'),
    active(7, 'fast', 2, 3), end(8, 'fast', 2, 3, 2, 'V2'), active(9, 'slow', 3, 2), end(10, 'slow', 6, 2, 3, 'V2')] });
  valid(r, 2); assert.deepEqual(r.official_observations.map((e) => e.route_update_id), ['slow', 'fast']);
  assert.equal(row(r, 'slow').latest_received_target_sample_id, id(2)); assert.equal(row(r, 'fast').latest_received_target_sample_id, id(3));
  assert.equal(row(r, 'slow').previous_route_update_id, 'init'); assert.equal(row(r, 'fast').previous_route_update_id, 'init');
});
for (const diagnostic of [{ event: 'mapbox_http_attempt' }, { event: 'route_update_end', m1_eligible: false },
  { event: 'route_update_end', refetchReason: 'graph_rebuild' }, { event: 'route_update_received', mapboxApiCalled: true }]) {
  test(`38 V3 terminal contradicts ${JSON.stringify(diagnostic)}`, () => {
    const r = run({ items: [...body(), { mono_ms: 8, source: 'backend', session_id: NAV, route_update_id: 'update-1', ...diagnostic }] });
    invalid(r, 'V3_INCREMENTAL_CLASSIFICATION_CONTRADICTION');
  });
}
test('39 backend receipt/activation impersonations cannot change state', () => {
  const backend = { source: 'backend', session_id: NAV, route_update_id: 'other', backend_mono_ms: -999, server_wall_clock_ms: -123 };
  const r = run({ items: [...seed(), receipt(3.5, 9, backend), active(3.75, 'other', 99, 9, backend), ...body().slice(3)] });
  valid(r); assert.equal(row(r).latest_received_target_sample_id, id(2)); assert.equal(row(r).previous_route_update_id, 'init');
});
test('39b backend import after run_stop allowed before final health', () => {
  const events = log(); const health = events.pop();
  events.push({ event: 'route_update_end', source: 'backend', system_version: 'V3', research_run_id: RUN, session_id: NAV,
    route_update_id: 'update-1', event_seq: events.at(-1).event_seq + 1, mono_ms: -2000, backend_mono_ms: -1, m1_eligible: true, success: true });
  events.push({ ...health, event_seq: events.at(-1).event_seq + 1 }); const r = run({ events }); valid(r);
});
test('40 V3 origin and microseconds agree; raw times preserved', () => {
  const r = run(); valid(r); assert.equal(row(r).m1_start_mono_ms, 1004); assert.equal(row(r).m1_start_monotonic_us, 4000);
});
test('40b inconsistent monotonic_us rejected', () => {
  const events = log(); events.find((e) => e.event === 'm1_frontend_start').monotonic_us++;
  invalid(run({ events }), 'MONOTONIC_US_MISMATCH');
});
test('40c missing mono_ms cannot fall back to monotonic_us', () => {
  const events = log(); delete events.find((e) => e.event === 'm1_frontend_start').mono_ms;
  invalid(run({ events }), 'INVALID_PRIMARY_MONO_MS');
});
test('40d optional absent monotonic_us is not a new runtime requirement', () => {
  const events = log(); events.forEach((e) => { delete e.monotonic_us; }); valid(run({ events }));
});
function thirty(system = 'V3') {
  const items = [receipt(1, 1), active(2, 'init', 1, 1)];
  for (let i = 1; i <= 30; i++) {
    const t = i * 10, n = i + 1, update = `update-${i}`;
    items.push(receipt(t, n), start(t + 1, update, n, system), active(t + 2, update, i + 1, n), end(t + 3, update, 2, n, i + 1, system));
  }
  return items;
}
for (const system of ['V2', 'V3']) {
  test(`41 ${system} exactly 30 M1 successes => exactly 30 M3 pairs`, () => { valid(run({ system, items: thirty(system) }), 30); });
}
test('42 30 successes / 29 pairs invalid; every candidate retained', () => {
  const r = run({ items: thirty().filter((e) => e.route_update_id !== 'init') }); invalid(r);
  assert.equal(r.summary.successful_eligible_M1_count, 30); assert.equal(r.summary.official_paired_M3_count, 29);
  assert.equal(r.summary.m3_unavailable_count, 1); assert.equal(rows(r).length, 30);
});
test('43 zero eligible is no numeric official result', () => {
  const r = run({ items: seed() }); assert.equal(r.summary.run_validation_status, 'NO_ELIGIBLE_REPLANS');
  assert.deepEqual(r.summary.official_m3_distance_m, distribution([])); assert.equal(r.summary.pairing_complete, true);
});
test('43b one observation all statistics equal value', () => {
  const r = run(); valid(r); const value = row(r).m3_pre_replan_distance_m;
  for (const field of ['mean', 'median', 'p95', 'max', 'min']) assert.equal(r.summary.official_m3_distance_m[field], value);
});
test('44 known Haversine latitude fixture', () => { close(haversineMeters({ lat: 13, lng: 100 }, { lat: 13.001, lng: 100 }), EARTH_RADIUS_M * 0.001 * Math.PI / 180); });
test('44b identical/symmetric/equator/coordinate order', () => {
  assert.equal(haversineMeters(point(1), point(1)), 0); close(haversineMeters(point(1), point(2)), haversineMeters(point(2), point(1)));
  close(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), EARTH_RADIUS_M * Math.PI / 180);
  assert.throws(() => haversineMeters({ lat: 100, lng: 13 }, point(1))); assert.throws(() => haversineMeters([100, 13], point(1)));
});
test('44c antimeridian wrap', () => { close(haversineMeters({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 }), EARTH_RADIUS_M * 0.002 * Math.PI / 180); });
test('45 median/P95 interpolation and no silent invalid numeric filtering', () => {
  const d = distribution([30, 0, 10, 20]); assert.equal(d.mean, 15); assert.equal(d.median, 15); close(d.p95, 28.5);
  assert.equal(distribution([10, 20]).p95, 19.5); assert.equal(distribution([10, 20, 90]).median, 20);
  for (const values of [[NaN], [Infinity], ['1'], [null]]) assert.throws(() => distribution(values));
});
test('46 Sender/server/wall clocks do not affect selection/distance', () => {
  const a = run({ sender: trace() }), events = log(); events.forEach((e) => { e.wall_clock_ms = -9e9; e.server_wall_clock_ms = 1; e.backend_mono_ms = -1; });
  const b = run({ events, sender: trace().map((e) => ({ ...e, mono_ms: -1000, wall_clock_ms: -3000, source_timestamp_ms: -5000 })) });
  valid(b); assert.equal(row(a).m3_pre_replan_distance_m, row(b).m3_pre_replan_distance_m);
  assert.equal(row(a).m1_start_mono_ms, row(b).m1_start_mono_ms);
});
for (const protocol of ['V1', 'V2']) {
  test(`47 legacy ${protocol} protocol explicitly rejected`, () => {
    const m = manifest(); m.protocol_version = `M3-PROTOCOL-${protocol}`; assert.throws(() => validateManifest(m), ConfigurationError);
  });
}
for (const field of ['observation_interval_ms', 'criteria', 'freshness_cutoff', 'gps_quality_policy', 'startup_stabilization_policy', 'distance_checkpoints']) {
  test(`47 forbidden old policy ${field} rejected`, () => { assert.throws(() => validateManifest({ ...manifest(), [field]: null }), ConfigurationError); });
}
test('47b unknown nested configuration and malformed hashes rejected', () => {
  const m = manifest(); m.navigation.observation_interval_ms = 1000; assert.throws(() => validateManifest(m), ConfigurationError);
  const h = manifest(); h.navigation.sha256 = 'bad'; assert.throws(() => validateManifest(h), ConfigurationError);
});
test('48 pure analyzer never mutates input arrays/objects', () => {
  const events = log(), sender = trace(), m = manifest(); const before = JSON.stringify({ events, sender, m });
  valid(run({ events, sender, m })); assert.equal(JSON.stringify({ events, sender, m }), before);
});
test('48b malformed JSONL records do not become official', () => {
  const parsed = parseJsonl(`${JSON.stringify(log()[0])}\n{bad}\n[]\nnull\n`); assert.equal(parsed.errors.length, 3);
  invalid(run({ events: log(), inputErrors: parsed.errors }), 'INVALID_JSONL_RECORD');
});

const temp = mkdtempSync(join(tmpdir(), 'm3-v3-fixtures-'));
const script = fileURLToPath(new URL('./analyze-m3-v3.mjs', import.meta.url));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files({ events = log(), sender = null, m = manifest(), malformed = false } = {}) {
  writeFileSync(join(temp, 'nav.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n${malformed ? '{bad}\n' : ''}`);
  if (sender) { writeFileSync(join(temp, 'sender.jsonl'), `${sender.map((e) => JSON.stringify(e)).join('\n')}\n`); m.sender = { file: 'sender.jsonl', sha256: null }; }
  writeFileSync(join(temp, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`);
  return join(temp, 'manifest.json');
}
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: dirname(temp), encoding: 'utf8' });
try {
  test('48c CLI valid stdout JSON, human stderr, 0, read-only hashes, reproducible', () => {
    const path = files({ sender: trace() }); const paths = [path, join(temp, 'nav.jsonl'), join(temp, 'sender.jsonl')];
    const hashes = paths.map(sha); const a = cli('--manifest', path), b = cli('--manifest', path);
    assert.equal(a.status, 0, a.stderr); valid(JSON.parse(a.stdout)); assert.match(a.stderr, /M1=1, M3=1/); assert.equal(a.stdout, b.stdout);
    assert.deepEqual(paths.map(sha), hashes); assert.equal(JSON.parse(a.stdout).summary.input_file_bindings.navigation.sha256, sha(join(temp, 'nav.jsonl')));
    assert.equal(JSON.parse(a.stdout).summary.input_file_bindings.manifest.sha256, sha(path));
  });
  test('48d table stays on stderr; stdout remains JSON', () => {
    const a = cli('--manifest', files(), '--table'); assert.equal(a.status, 0); valid(JSON.parse(a.stdout)); assert.match(a.stderr, /\tupdate-1\tPAIRED\t/);
  });
  test('48e invalid run exit 1 with JSON and null official statistics', () => {
    const path = files({ events: log(body().filter((e) => e.route_update_id !== 'init')) });
    const a = cli('--manifest', path); assert.equal(a.status, 1); invalid(JSON.parse(a.stdout));
  });
  test('48f no eligible exit 1; no fabricated numeric zero', () => {
    const a = cli('--manifest', files({ events: log(seed()) })); assert.equal(a.status, 1);
    assert.equal(JSON.parse(a.stdout).summary.run_validation_status, 'NO_ELIGIBLE_REPLANS');
  });
  test('30d hash mismatch exits 2 and cannot produce official statistics', () => {
    const m = manifest(); m.navigation.sha256 = '0'.repeat(64); const a = cli('--manifest', files({ m }));
    assert.equal(a.status, 2); assert.equal(JSON.parse(a.stdout).summary.run_validation_status, 'CONFIGURATION_ERROR'); assert.match(a.stderr, /SHA256_MISMATCH/);
  });
  test('30e Sender hash mismatch rejected', () => {
    files({ sender: trace() }); const m = JSON.parse(readFileSync(join(temp, 'manifest.json'))); m.sender.sha256 = '0'.repeat(64);
    writeFileSync(join(temp, 'manifest.json'), JSON.stringify(m)); assert.throws(() => analyzeFilesV3(join(temp, 'manifest.json')), /SHA256_MISMATCH/);
  });
  test('48g malformed raw JSONL returns INVALID exit 1', () => {
    const a = cli('--manifest', files({ malformed: true })); assert.equal(a.status, 1); invalid(JSON.parse(a.stdout), 'INVALID_JSONL_RECORD');
  });
  for (const args of [[], ['--criteria', 'old.json'], ['--manifest'], ['--manifest', '--table'], ['--unknown'], ['--help'], ['--manifest', 'missing.json']]) {
    test(`48h usage/config error ${JSON.stringify(args)} exit 2`, () => {
      const a = cli(...args); assert.equal(a.status, 2); assert.equal(JSON.parse(a.stdout).summary.run_validation_status, 'CONFIGURATION_ERROR');
    });
  }
  test('48i wrong legacy manifest CLI exit 2', () => {
    const m = manifest(); m.schema_version = 'm3-manifest-v2'; const a = cli('--manifest', files({ m })); assert.equal(a.status, 2);
  });
  test('48j manifest-relative paths work from unrelated cwd, real hash binding', () => {
    const path = files(); const m = manifest(); m.navigation.sha256 = sha(join(temp, 'nav.jsonl')); writeFileSync(path, JSON.stringify(m));
    valid(analyzeFilesV3(path));
  });
  test('48k template has only current protocol bindings and no criteria', () => {
    const m = JSON.parse(readFileSync(fileURLToPath(new URL('./m3-v3-manifest.template.json', import.meta.url))));
    assert.equal(m.schema_version, 'm3-manifest-v3'); assert.equal(m.protocol_version, 'M3-PROTOCOL-V3');
    assert.throws(() => validateManifest(m), ConfigurationError); // Template placeholders are never actual bindings.
  });
  test('49 offline module imports only Node built-ins and unchanged Haversine', () => {
    const source = readFileSync(script, 'utf8'); const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.ok(imports.every((name) => name.startsWith('node:') || name === './m3-haversine.mjs'));
  });
} finally { rmSync(temp, { recursive: true, force: true }); }

process.stdout.write(`M3-PROTOCOL-V3: ${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
