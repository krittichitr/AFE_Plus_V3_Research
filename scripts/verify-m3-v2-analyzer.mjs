#!/usr/bin/env node
// All numeric criteria below are SYNTHETIC test inputs, never research defaults.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { analyzeRunV2, analyzeFilesV2, distribution, validateCriteriaV2, parseJsonlV2 } from './analyze-m3-v2.mjs';
import { haversineMeters } from './m3-haversine.mjs';

const SESSION = 'sender-current', OLD = 'sender-previous', NAV = 'navigation-session';
const id = (n, session = SESSION) => `${session}:T${String(n).padStart(6, '0')}`;
const point = (n) => ({ lat: 13 + n * 0.001, lng: 100 });
const sample = (n, session = SESSION) => ({ event: 'target_sample', sender_session_id: session, research_run_id: 'Sender label',
  target_sample_id: id(n, session), sequence: n, callback_index: n, target_lat: point(n).lat, target_lng: point(n).lng,
  accuracy_m: 1, speed_mps: 1, source_timestamp_ms: 1_700_000_000_000 + n * 1000,
  mono_ms: n * 700, cumulative_distance_m: null, validated_cumulative_distance_m: null });
const reference = (event, mono_ms, n = 1, extra = {}) => ({ event, mono_ms, target_sample_id: id(n),
  target_ref_lat: point(n).lat, target_ref_lng: point(n).lng,
  ...(event === 'route_active' ? { session_id: NAV, route_update_id: `route-${mono_ms}`, route_activation_seq: mono_ms, route_version: mono_ms } : {}), ...extra });
const receipt = (time, n = 1, extra = {}) => reference('target_received', time, n, extra);
const route = (time, n = 1, extra = {}) => reference('route_active', time, n, extra);
function navLog(primary = [receipt(500), route(1000), receipt(2000, 2), receipt(3000, 3)], { version = 'V3', start = 0, stop = 6000, after = [] } = {}) {
  const all = [{ event: 'run_start', mono_ms: start }, ...primary, { event: 'run_stop', mono_ms: stop }, ...after];
  const health = { event: 'logger_health', mono_ms: Math.max(stop, ...after.map((e) => e.mono_ms)) + 1, dropped_events: 0,
    ...(version === 'V2' ? { total_events: all.length, m2_complete: false } : {
      stored_events: all.length, attempted_events: all.length, dropped_by_event: {},
      first_dropped_event_seq: null, last_dropped_event_seq: null,
      first_dropped_monotonic_us: null, last_dropped_monotonic_us: null, high_water_mark: all.length,
    }) };
  return [...all, health].map((e, i) => ({ ...e, event_seq: i + 1, research_run_id: 'Navigation label', system_version: version,
    ...(version === 'V3' ? { platform: 'web', monotonic_us: Math.round((e.mono_ms - start) * 1000) } : {}) }));
}
function senderLog(samples = Array.from({ length: 5 }, (_, i) => sample(i + 1)), session = SESSION) {
  return [{ event: 'sender_start', sender_session_id: session, research_run_id: 'Sender label' }, ...samples,
    { event: 'sender_stop', sender_session_id: session, research_run_id: 'Sender label' }];
}
const manifest = () => ({ schema_version: 'm3-manifest-v2', protocol_version: 'M3-PROTOCOL-V2', system: 'D-TANS',
  navigation: { file: 'nav.jsonl', session_id: NAV, run_id_label: 'Navigation label' },
  sender: { file: 'sender.jsonl', sender_session_id: SESSION, run_id_label: 'Sender label' },
  analysis_scope: { policy: 'single_continuous_navigation_session', end_policy: 'run_stop' },
  observation_start_policy: 'linkage_ready_plus_configured_startup_stabilization' });
const criteria = () => ({ schema_version: 'm3-criteria-v2', protocol_version: 'M3-PROTOCOL-V2', criteria_id: 'SYNTHETIC-FIXTURE-ONLY',
  observation_interval_ms: 1000, max_sample_freshness_age_ms: 100000,
  gps_quality_policy: { mode: 'diagnostic_only' }, startup_stabilization_policy: { mode: 'none' },
  unresolved_gps_gap_policy: { mode: 'diagnostic_only' } });
const run = (overrides = {}) => analyzeRunV2({ navigationEvents: navLog(), senderEvents: senderLog(), manifest: manifest(), criteria: criteria(), ...overrides });
const times = (r) => r.observations.map((e) => e.observation_mono_ms);
const at = (r, time) => r.observations.find((e) => e.observation_mono_ms === time);
const invalid = (r) => { assert.equal(r.summary.run_validity, 'INVALID'); assert.equal(r.summary.m3_distance_m.mean, null); assert.equal(r.observations.length, 0); };
const noResult = (r, reason) => { assert.equal(r.summary.run_validity, 'NO_OFFICIAL_RESULT'); if (reason) assert.equal(r.summary.diagnostic_reason, reason); assert.equal(r.summary.m3_distance_m.mean, null); };
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}

for (const [system, version] of [['AFE-Plus V.2', 'V2'], ['D-TANS', 'V3']]) {
  test(`A/C ${version}: differing labels valid, exact membership verified`, () => {
    const m = manifest(); m.system = system;
    const nav = navLog(undefined, { version }), raw = JSON.stringify(nav);
    const r = run({ manifest: m, navigationEvents: nav });
    assert.equal(r.summary.run_validity, 'VALID'); assert.deepEqual(r.summary.warnings, ['RUN_ID_LABEL_MISMATCH']);
    assert.equal(r.summary.navigation_run_id_label, 'Navigation label'); assert.equal(r.summary.sender_run_id_label, 'Sender label');
    assert.equal(r.observations[0].route_provenance_verification_status, 'VERIFIED');
    assert.equal(r.observations[0].receipt_provenance_verification_status, 'VERIFIED');
    assert.equal(JSON.stringify(nav), raw); // No raw label/record mutation.
  });
}
test('B wrong selected Sender session', () => { const m = manifest(); m.sender.sender_session_id = OLD; invalid(run({ manifest: m })); });
test('D old route reference and advancing targets increase M3', () => {
  const r = run(); assert.equal(at(r, 1000).m3_distance_m, 0);
  assert.ok(at(r, 2000).m3_distance_m > 0); assert.ok(at(r, 3000).m3_distance_m > at(r, 2000).m3_distance_m);
  assert.equal(at(r, 3000).m3_distance_m, haversineMeters(point(1), point(3)));
});
test('E/F candidate ignored; accepted route changes reference only after acceptance', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2000, 2), reference('route_update_end', 2500, 2), route(3500, 2)]) });
  assert.equal(at(r, 3000).route_target_sample_id, id(1)); assert.equal(at(r, 4000).route_target_sample_id, id(2));
  assert.ok(at(r, 3000).m3_distance_m > 0); assert.equal(at(r, 4000).m3_distance_m, 0);
});
test('G no future receipt or first-seen lookup used retroactively', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2500, 2)]) });
  assert.equal(at(r, 2000).latest_received_target_sample_id, id(1)); assert.equal(at(r, 2000).first_seen_nav_mono_ms, 500);
  assert.equal(at(r, 3000).first_seen_nav_mono_ms, 2500);
});
test('H freshness limit boundary uses >, not >=', () => {
  const c = criteria(); c.max_sample_freshness_age_ms = 500;
  const r = run({ criteria: c, navigationEvents: navLog([receipt(500), route(1000)]) });
  assert.equal(at(r, 1000).status, 'OK'); assert.equal(at(r, 2000).diagnostic_reason, 'STALE_TARGET_SAMPLE');
});
test('I missing receipt never fabricates official rows', () => {
  const r = run({ navigationEvents: navLog([route(1000)]) }); noResult(r, 'INTENDED_LINKAGE_NOT_ESTABLISHED');
  assert.equal(r.observations.length, 0); assert.equal(r.summary.na_count, 0); assert.equal(r.summary.linkage_ready_mono_ms, null);
});
test('J missing accepted route never fabricates official rows', () => {
  const r = run({ navigationEvents: navLog([receipt(500)]) }); noResult(r, 'INTENDED_LINKAGE_NOT_ESTABLISHED');
  assert.equal(r.observations.length, 0); assert.equal(r.summary.effective_start_mono_ms, null);
});
for (const version of ['V2', 'V3']) {
  for (const corrupt of ['drop', 'no-stop', 'no-health', 'sequence', 'counter', 'extra-start', 'not-terminal']) {
    test(`K ${version} strict logger health: ${corrupt}`, () => {
      let nav = navLog(undefined, { version }); const m = manifest(); m.system = version === 'V2' ? 'AFE-Plus V.2' : 'D-TANS';
      if (corrupt === 'drop') nav.at(-1).dropped_events = 1;
      if (corrupt === 'no-stop') nav = nav.filter((e) => e.event !== 'run_stop');
      if (corrupt === 'no-health') nav.pop();
      if (corrupt === 'sequence') nav[2].event_seq = nav[1].event_seq;
      if (corrupt === 'counter') nav.at(-1)[version === 'V2' ? 'total_events' : 'attempted_events']++;
      if (corrupt === 'extra-start') nav[1].event = 'run_start';
      if (corrupt === 'not-terminal') nav.reverse();
      invalid(run({ navigationEvents: nav, manifest: m }));
    });
  }
}
test('L previous Sender initial route is diagnostic only', () => {
  const r = run({ navigationEvents: navLog([route(100, 1, { target_sample_id: id(1, OLD) }), receipt(500), route(2000)]) });
  assert.equal(r.summary.run_validity, 'VALID'); assert.equal(r.summary.linkage_ready_mono_ms, 2000);
  assert.equal(r.summary.pre_linkage_diagnostic_count, 2); assert.equal(r.summary.na_count, 0);
  assert.equal(r.diagnostics.pre_linkage[0].route_status, 'FOREIGN_SESSION'); assert.deepEqual(times(r), [2000, 3000, 4000, 5000, 6000]);
});
test('M intended receipt first; readiness at accepted route', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1750)]) });
  assert.equal(r.summary.linkage_ready_mono_ms, 1750); assert.equal(r.observations[0].observation_mono_ms, 1750);
});
test('N intended route first; readiness at receipt', () => {
  const r = run({ navigationEvents: navLog([route(500), receipt(1750)]) });
  assert.equal(r.summary.linkage_ready_mono_ms, 1750); assert.equal(r.observations[0].sample_freshness_age_ms, 0);
});
test('O readiness not rounded to run_start or interval multiples', () => {
  const r = run({ navigationEvents: navLog([receipt(700), route(1234.567, 1, { route_activation_seq: 1 })], { start: 50, stop: 4234.567 }) });
  assert.deepEqual(times(r), [1234.567, 2234.567, 3234.567, 4234.567]);
});
test('P run_start shift does not change physical grid or freshness', () => {
  const r = run(), shifted = run({ navigationEvents: navLog(undefined, { start: 200 }) });
  assert.deepEqual(r.observations, shifted.observations);
});
test('Q no intended linkage -> null statistics/zero rows', () => {
  const r = run({ navigationEvents: navLog([route(1000, 1, { target_sample_id: id(1, OLD) }), receipt(2000)]) });
  noResult(r, 'INTENDED_LINKAGE_NOT_ESTABLISHED'); assert.equal(r.summary.observation_count, 0); assert.equal(r.summary.na_count, 0);
});
test('R equal timestamps use final event_seq state, including readiness', () => {
  const r = run({ navigationEvents: navLog([receipt(1000), route(1000), receipt(1000, 2)]) });
  assert.equal(r.observations[0].latest_received_target_sample_id, id(2)); assert.equal(r.summary.linkage_ready_mono_ms, 1000);
  const none = run({ navigationEvents: navLog([receipt(1000), route(1000), route(1000, 1, { route_activation_seq: 1001, target_sample_id: id(1, OLD) })]) });
  noResult(none, 'INTENDED_LINKAGE_NOT_ESTABLISHED');
});
test('S Sender clocks/source time/sync cannot change primary results', () => {
  const sender = senderLog().map((e) => ({ ...e, mono_ms: -987654321, wall_clock_ms: 9, source_timestamp_ms: -99999999 }));
  sender.splice(1, 0, { event: 'clock_sync', sender_session_id: SESSION, research_run_id: 'Sender label', success: false, rtt_ms: 999999, estimated_clock_offset_ms: 987654 });
  assert.deepEqual(run().observations, run({ senderEvents: sender }).observations);
});
test('T equivalent V2 and V3 local timelines', () => {
  const m = manifest(); m.system = 'AFE-Plus V.2';
  assert.deepEqual(run().observations, run({ manifest: m, navigationEvents: navLog(undefined, { version: 'V2' }) }).observations);
});
test('U repeated cached sample is stale despite recent polling', () => {
  const c = criteria(); c.max_sample_freshness_age_ms = 2000; c.observation_interval_ms = 1000;
  const r = run({ criteria: c, senderEvents: senderLog(Array.from({ length: 100 }, (_, i) => sample(i + 1))),
    navigationEvents: navLog([route(9000, 100), receipt(10000, 100), receipt(12000, 100), receipt(14000, 100)], { stop: 16000 }) });
  const row = at(r, 15000);
  assert.equal(row.first_seen_nav_mono_ms, 10000); assert.equal(row.latest_receipt_nav_mono_ms, 14000);
  assert.equal(row.receipt_age_ms, 1000); assert.equal(row.sample_freshness_age_ms, 5000); assert.equal(row.repeated_sample_id, true);
  assert.equal(row.m3_distance_m, null); assert.equal(row.status, 'NA'); assert.equal(row.diagnostic_reason, 'STALE_TARGET_SAMPLE');
  assert.equal(at(r, 16000).sample_freshness_age_ms, 6000); assert.equal(r.summary.stale_target_sample_count, 4);
});
test('V/W new ID first-seen and old returning ID preserve separate ages', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2000, 2), receipt(3000, 1)]) });
  assert.equal(at(r, 2000).first_seen_nav_mono_ms, 2000); assert.equal(at(r, 3000).first_seen_nav_mono_ms, 500);
  assert.equal(at(r, 3000).sample_freshness_age_ms, 2500); assert.equal(at(r, 3000).receipt_age_ms, 0);
});
test('X null ID after linkage has no coordinate-only fallback', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2000, 1, { target_sample_id: null })]) });
  assert.equal(at(r, 2000).m3_distance_m, null); assert.equal(at(r, 2000).receipt_provenance_verification_status, 'UNAVAILABLE');
});
test('X null route ID before readiness cannot establish linkage', () => {
  noResult(run({ navigationEvents: navLog([receipt(500), route(1000, 1, { target_sample_id: null })]) }), 'INTENDED_LINKAGE_NOT_ESTABLISHED');
});
test('Y multiple Sender sessions select manifest session only', () => {
  const r = run({ senderEvents: [...senderLog([sample(1, OLD)], OLD), ...senderLog()] });
  assert.equal(r.summary.run_validity, 'VALID'); assert.deepEqual(r.diagnostics.other_sender_sessions, [OLD]);
  assert.equal(r.diagnostics.calibration.gps.sample_count, 5);
});
test('Z duplicate claimed ID invalid', () => { const sender = senderLog(); sender.splice(2, 0, sample(1)); invalid(run({ senderEvents: sender })); });
test('Z absent claimed ID invalid even with null criteria', () => { invalid(run({ navigationEvents: navLog([receipt(500, 99), route(1000)]), criteria: null })); });
test('Z prefix alone insufficient: sequence/session inconsistency', () => { const sender = senderLog(); sender[1].sequence = 2; invalid(run({ senderEvents: sender })); });
test('Z raw coordinate equality required, proximity not enough', () => { invalid(run({ navigationEvents: navLog([receipt(500, 1, { target_ref_lat: point(1).lat + 1e-9 }), route(1000)]) })); });
test('AA/AH null criteria template fails closed without numeric rows', () => {
  const c = JSON.parse(readFileSync(new URL('./m3-v2-criteria.template.json', import.meta.url)));
  const r = run({ criteria: c }); noResult(r, 'CRITERIA_UNCONFIGURED'); assert.equal(r.observations.length, 0);
  assert.equal(r.summary.linkage_ready_mono_ms, 1000); assert.equal(r.summary.effective_start_mono_ms, null);
  assert.equal(Object.hasOwn(c, 'target_age_ms'), false);
});
for (const field of ['observation_interval_ms', 'max_sample_freshness_age_ms', 'gps_quality_policy', 'startup_stabilization_policy', 'unresolved_gps_gap_policy']) {
  test(`AA null ${field} cannot infer default`, () => { const c = criteria(); c[field] = null; noResult(run({ criteria: c }), 'CRITERIA_UNCONFIGURED'); });
}
test('AA invalid/sub-microsecond interval fails closed', () => {
  for (const value of [0, -1, NaN, Infinity, 0.00001]) { const c = criteria(); c.observation_interval_ms = value; assert.equal(validateCriteriaV2(c).valid, false); }
});
test('AB null cumulative/validated distances irrelevant', () => { assert.equal(run().summary.run_validity, 'VALID'); });
test('AD quality reject never falls back or re-anchors', () => {
  const c = criteria(); c.gps_quality_policy = { mode: 'thresholds', max_accuracy_m: 10, max_speed_mps: 10,
    missing_accuracy: 'reject', missing_speed: 'reject', missing_source_timestamp: 'reject' };
  const sender = senderLog(); sender[2].accuracy_m = 11;
  const r = run({ criteria: c, senderEvents: sender, navigationEvents: navLog([receipt(500), route(1000), receipt(2000, 2), receipt(4500, 3)]) });
  assert.equal(at(r, 2000).diagnostic_reason, 'GPS_QUALITY_REJECTED'); assert.equal(at(r, 3000).latest_received_target_sample_id, id(2));
  assert.deepEqual(times(r), [1000, 2000, 3000, 4000, 5000, 6000]); assert.equal(at(r, 5000).status, 'OK');
});
test('AD route reference quality also gates numeric M3', () => {
  const c = criteria(); c.gps_quality_policy = { mode: 'thresholds', max_accuracy_m: 10, max_speed_mps: 10,
    missing_accuracy: 'reject', missing_speed: 'reject', missing_source_timestamp: 'reject' };
  const sender = senderLog(); sender[1].accuracy_m = 11;
  const r = run({ criteria: c, senderEvents: sender }); noResult(r, 'ZERO_VALID_OBSERVATIONS');
  assert.ok(r.observations.every((e) => e.gps_quality_status.route.status === 'REJECTED'));
});
test('GPS missing fields require explicit allow/reject policy', () => {
  const c = criteria(); c.gps_quality_policy = { mode: 'thresholds', max_accuracy_m: 10, max_speed_mps: 10,
    missing_accuracy: 'reject', missing_speed: 'allow', missing_source_timestamp: 'allow' };
  const sender = senderLog(); sender[1].accuracy_m = null; noResult(run({ criteria: c, senderEvents: sender }), 'ZERO_VALID_OBSERVATIONS');
  c.gps_quality_policy.missing_accuracy = 'allow'; assert.equal(run({ criteria: c, senderEvents: sender }).summary.run_validity, 'VALID');
});
test('Explicit unresolved source gap policy is supporting quality only', () => {
  const c = criteria(); c.unresolved_gps_gap_policy = { mode: 'reject', max_source_gap_ms: 500, reject_rejected_callbacks: true };
  const r = run({ criteria: c }); assert.equal(at(r, 2000).diagnostic_reason, 'GPS_QUALITY_REJECTED'); assert.deepEqual(times(r), times(run()));
});
test('AE zero valid official observations retain null distance statistics', () => {
  const c = criteria(); c.max_sample_freshness_age_ms = 0;
  const r = run({ criteria: c, navigationEvents: navLog([receipt(500), route(1000)]) }); noResult(r, 'ZERO_VALID_OBSERVATIONS');
  assert.equal(r.summary.valid_count, 0); assert.equal(r.summary.observation_count, 6); assert.equal(r.summary.m3_distance_m.max, null);
});
for (const corruption of ['reset', 'missing', 'negative', 'infinite', 'after-stop']) {
  test(`AF malformed primary local time: ${corruption}`, () => {
    const nav = navLog(); const e = nav[3];
    if (corruption === 'reset') e.mono_ms = 1;
    if (corruption === 'missing') delete e.mono_ms;
    if (corruption === 'negative') e.mono_ms = -1;
    if (corruption === 'infinite') e.mono_ms = Infinity;
    if (corruption === 'after-stop') e.mono_ms = 99999;
    invalid(run({ navigationEvents: nav }));
  });
}
test('AG configured startup duration preserves first-seen and phase', () => {
  const c = criteria(); c.startup_stabilization_policy = { mode: 'fixed_duration', duration_ms: 250 };
  const r = run({ criteria: c }); assert.equal(r.summary.effective_start_mono_ms, 1250);
  assert.equal(r.observations[0].first_seen_nav_mono_ms, 500); assert.equal(r.observations[0].sample_freshness_age_ms, 750);
  assert.deepEqual(times(r), [1250, 2250, 3250, 4250, 5250]);
  c.startup_stabilization_policy.duration_ms = 99999; noResult(run({ criteria: c }), 'STARTUP_NOT_COMPLETED_WITHIN_SCOPE');
});
test('AI foreign Sender after linkage cannot relink, even between grid ticks', () => {
  invalid(run({ navigationEvents: navLog([receipt(500), route(1000), receipt(1500, 1, { target_sample_id: id(1, OLD) }), receipt(1700)]) }));
});
test('AI foreign Sender during startup cannot relink', () => {
  const c = criteria(); c.startup_stabilization_policy = { mode: 'fixed_duration', duration_ms: 2000 };
  invalid(run({ criteria: c, navigationEvents: navLog([receipt(500), route(1000), route(1500, 1, { target_sample_id: id(1, OLD) })]) }));
});
test('Post-stop import artifacts do not extend official scope', () => {
  const r = run({ navigationEvents: navLog(undefined, { after: [{ event: 'route_update_end', source: 'backend', mono_ms: 9999 }] }) });
  assert.equal(r.summary.run_validity, 'VALID'); assert.equal(times(r).at(-1), 6000);
});
test('V3 contradictory terminal drop metadata is invalid', () => {
  const nav = navLog(); nav.at(-1).first_dropped_event_seq = 2; invalid(run({ navigationEvents: nav }));
});
test('V3 run_stop pre-append counters are not terminal counters', () => {
  const nav = navLog(); const stop = nav.find((e) => e.event === 'run_stop');
  stop.stored_events = stop.event_seq - 1; stop.attempted_events = stop.event_seq - 1;
  assert.equal(run({ navigationEvents: nav }).summary.run_validity, 'VALID');
});
test('Same-time repeated receipts counted individually; first-seen unchanged', () => {
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2000), receipt(2000)]) });
  assert.equal(r.summary.repeated_sample_receipt_count, 2); assert.equal(at(r, 2000).first_seen_nav_mono_ms, 500);
});
test('M2 incomplete flag is not a primary M3 validity gate', () => {
  const m = manifest(); m.system = 'AFE-Plus V.2'; assert.equal(run({ manifest: m, navigationEvents: navLog(undefined, { version: 'V2' }) }).summary.run_validity, 'VALID');
});
test('Selected Navigation session is enforced', () => {
  invalid(run({ navigationEvents: navLog([receipt(500), route(1000, 1, { session_id: 'wrong' })]) }));
});
test('Derived start cannot be authoritative manifest input', () => {
  const m = manifest(); m.effective_start_mono_ms = 123; invalid(run({ manifest: m }));
});
test('Explicit scope end clips output without changing start/first-seen', () => {
  const m = manifest(); m.analysis_scope.end_mono_ms = 3500; const r = run({ manifest: m });
  assert.deepEqual(times(r), [1000, 2000, 3000]); assert.equal(r.observations[0].first_seen_nav_mono_ms, 500);
});
test('Linear-interpolated summary statistics and separate ages', () => {
  assert.deepEqual(distribution([0, 10, 20]), { n: 3, min: 0, mean: 10, median: 10, p95: 19, max: 20 });
  const r = run({ navigationEvents: navLog([receipt(500), route(1000), receipt(2000)]) });
  assert.notDeepEqual(r.summary.receipt_age_ms.all, r.summary.sample_freshness_age_ms.all);
  assert.equal(r.summary.m3_distance_m.n, r.summary.valid_count); assert.equal(Object.hasOwn(r.observations[0], 'target_age_ms'), false);
});
test('Malformed JSONL rejects non-record/invalid JSON with line evidence', () => {
  assert.throws(() => parseJsonlV2('{bad}\n'), /line_1/); assert.throws(() => parseJsonlV2('null\n'), /record_1/);
});

const temp = mkdtempSync(join(tmpdir(), 'm3-v2-fixture-'));
try {
  const navPath = join(temp, 'nav.jsonl'), senderPath = join(temp, 'sender.jsonl'), manifestPath = join(temp, 'manifest.json'), criteriaPath = join(temp, 'criteria.json');
  const jsonl = (es) => es.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(navPath, jsonl(navLog())); writeFileSync(senderPath, jsonl(senderLog()));
  writeFileSync(criteriaPath, JSON.stringify(criteria()));
  const m = manifest(); const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(m)); saveManifest();
  test('AC real file binding, relative paths and SHA256', () => {
    m.navigation.sha256 = createHash('sha256').update(readFileSync(navPath)).digest('hex'); saveManifest();
    assert.equal(analyzeFilesV2({ manifestPath, criteriaPath }).summary.run_validity, 'VALID');
    m.navigation.sha256 = '0'.repeat(64); saveManifest(); invalid(analyzeFilesV2({ manifestPath, criteriaPath }));
    delete m.navigation.sha256; saveManifest();
    invalid(analyzeFilesV2({ manifestPath, criteriaPath, navigationPath: senderPath }));
  });
  test('Actual CLI emits JSON and correct success/closed/error exit statuses', () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'analyze-m3-v2.mjs');
    const invoke = () => spawnSync(process.execPath, [cli, '--manifest', manifestPath, '--criteria', criteriaPath], { encoding: 'utf8' });
    let result = invoke(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary.run_validity, 'VALID');
    const table = spawnSync(process.execPath, [cli, '--manifest', manifestPath, '--criteria', criteriaPath, '--table'], { encoding: 'utf8' });
    assert.equal(JSON.parse(table.stdout).summary.run_validity, 'VALID'); assert.match(table.stderr, /sample_freshness_age_ms/);
    writeFileSync(criteriaPath, readFileSync(new URL('./m3-v2-criteria.template.json', import.meta.url)));
    result = invoke(); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).summary.diagnostic_reason, 'CRITERIA_UNCONFIGURED');
    writeFileSync(navPath, 'not-json'); result = invoke(); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).summary.run_validity, 'INVALID');
  });
} finally { rmSync(temp, { recursive: true, force: true }); }

console.log(`M3-PROTOCOL-V2 controlled tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
