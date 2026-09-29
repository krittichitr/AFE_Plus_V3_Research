#!/usr/bin/env node
// Controlled fixtures for the M3 (Route-to-Target Reference Location
// Discrepancy) offline analyzer. No field data — synthetic JSONL events only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { analyzeRun, parseJsonl, validateManifest, validateCriteria, CHECKPOINTS } from './analyze-m3.mjs';
import { haversineMeters, EARTH_RADIUS_M, isValidLatLng } from './m3-haversine.mjs';

const root = resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);

const RUN_ID = 'run-m3-fixture';
const NAV_SESSION = 'nav-session-1';
const SENDER_SESSION = 'sender-session-1';
const SYSTEM = 'D-TANS';
const SERVER_BASE_MS = 1_700_000_000_000;
const NAV_OFFSET_MS = 1000;
const SENDER_OFFSET_MS = 2000;
const BASE_LAT = 13.7563;
const BASE_LNG = 100.5018;

function pt(i) { return { lat: BASE_LAT + i * 0.0001, lng: BASE_LNG }; }
function sampleId(seq, sessionId = SENDER_SESSION) { return `${sessionId}:T${String(seq).padStart(6, '0')}`; }

function navClockSync({ rttMs = 40, offsetMs = NAV_OFFSET_MS, success = true, runId = RUN_ID } = {}) {
  return {
    event: 'clock_sync', event_seq: 2, research_run_id: runId,
    success, rtt_ms: rttMs, estimated_clock_offset_ms: offsetMs,
    server_wall_clock_ms: 1, client_send_wall_ms: 1, client_receive_wall_ms: 1,
    wall_clock_ms: 1, wall_clock_utc: new Date(1).toISOString(),
  };
}
function senderClockSync({ rttMs = 60, offsetMs = SENDER_OFFSET_MS, success = true, runId = RUN_ID, sessionId = SENDER_SESSION } = {}) {
  return {
    event: 'clock_sync', sender_session_id: sessionId, research_run_id: runId,
    success, rtt_ms: rttMs, estimated_clock_offset_ms: offsetMs,
    server_wall_clock_ms: 1, client_send_wall_ms: 1, client_receive_wall_ms: 1, wall_clock_utc: new Date(1).toISOString(),
  };
}

function routeActive({ eventSeq, serverTimeOffsetMs, routeUpdateId, targetSampleId, targetRef, activationSeq, sessionId = NAV_SESSION, runId = RUN_ID, routeVersion = null }) {
  const wallClockMs = SERVER_BASE_MS + serverTimeOffsetMs - NAV_OFFSET_MS;
  return {
    event: 'route_active', event_seq: eventSeq, research_run_id: runId, system_version: 'V3',
    wall_clock_ms: wallClockMs, wall_clock_utc: new Date(wallClockMs).toISOString(), mono_ms: 0,
    session_id: sessionId, route_update_id: routeUpdateId, target_sample_id: targetSampleId,
    target_ref_lat: targetRef ? targetRef.lat : null, target_ref_lng: targetRef ? targetRef.lng : null,
    route_activation_seq: activationSeq, route_version: routeVersion,
  };
}

function targetSample({ seq, serverTimeOffsetMs, cumulativeDistanceM, coord = pt(seq), sessionId = SENDER_SESSION, runId = RUN_ID, sourceTimestampValid = true, idOverride }) {
  const sourceTimestampMs = sourceTimestampValid ? SERVER_BASE_MS + serverTimeOffsetMs - SENDER_OFFSET_MS : Number.NaN;
  return {
    event: 'target_sample', sender_session_id: sessionId, research_run_id: runId,
    target_sample_id: idOverride ?? sampleId(seq, sessionId), sequence: seq, target_lat: coord.lat, target_lng: coord.lng,
    accuracy_m: 1, source_timestamp_ms: sourceTimestampMs, wall_clock_utc: new Date(SERVER_BASE_MS + serverTimeOffsetMs).toISOString(),
    mono_ms: 0, cumulative_distance_m: cumulativeDistanceM,
  };
}

function baseInitialRoute(overrides = {}) {
  return routeActive({ eventSeq: 3, serverTimeOffsetMs: 0, routeUpdateId: 'ru-1', targetSampleId: sampleId(2), targetRef: pt(2), activationSeq: 1, ...overrides });
}

function baseSenderSamples() {
  return [
    targetSample({ seq: 1, serverTimeOffsetMs: -500, cumulativeDistanceM: 0 }),
    targetSample({ seq: 2, serverTimeOffsetMs: 100, cumulativeDistanceM: 10 }),
    targetSample({ seq: 3, serverTimeOffsetMs: 500, cumulativeDistanceM: 61 }),
    targetSample({ seq: 4, serverTimeOffsetMs: 900, cumulativeDistanceM: 112 }),
    targetSample({ seq: 5, serverTimeOffsetMs: 1300, cumulativeDistanceM: 163 }),
    targetSample({ seq: 6, serverTimeOffsetMs: 1700, cumulativeDistanceM: 214 }),
    targetSample({ seq: 7, serverTimeOffsetMs: 2100, cumulativeDistanceM: 316 }),
    targetSample({ seq: 8, serverTimeOffsetMs: 2500, cumulativeDistanceM: 520 }),
  ];
}

function buildNav({ routeActives = [baseInitialRoute()], runStart = true, runStop = true, droppedEvents = 0, runId = RUN_ID, clock = navClockSync() } = {}) {
  const events = [];
  if (runStart) events.push({ event: 'run_start', event_seq: 1, research_run_id: runId, wall_clock_ms: 0, wall_clock_utc: new Date(0).toISOString() });
  if (clock) events.push(clock);
  events.push(...routeActives);
  events.push({ event: 'logger_health', event_seq: 99, research_run_id: runId, dropped_events: droppedEvents });
  if (runStop) events.push({ event: 'run_stop', event_seq: 100, research_run_id: runId });
  return events;
}

function buildSender({ samples = baseSenderSamples(), senderStart = true, senderStop = true, runId = RUN_ID, sessionId = SENDER_SESSION, clock = senderClockSync() } = {}) {
  const events = [];
  if (senderStart) events.push({ event: 'sender_start', sender_session_id: sessionId, research_run_id: runId, wall_clock_utc: new Date(0).toISOString() });
  if (clock) events.push(clock);
  events.push(...samples);
  if (senderStop) events.push({ event: 'sender_stop', sender_session_id: sessionId, research_run_id: runId, wall_clock_utc: new Date(1).toISOString() });
  return events;
}

function baseManifest() {
  return {
    schema_version: 'm3-manifest-v1', protocol_version: 'M3-PROTOCOL-V1', research_run_id: RUN_ID, system: SYSTEM,
    navigation_session_id: NAV_SESSION, sender_session_id: SENDER_SESSION,
    navigation_log_file: 'nav.jsonl', sender_trace_file: 'sender.jsonl',
  };
}
function baseCriteria() {
  return { schema_version: 'm3-criteria-v1', max_rtt_ms: 200, max_clock_uncertainty_ms: 300, max_clock_drift_ms: 50, max_route_reference_match_distance_m: 5 };
}

function run(overrides = {}) {
  return analyzeRun({
    navigationEvents: overrides.navigationEvents ?? buildNav(overrides.nav),
    senderEvents: overrides.senderEvents ?? buildSender(overrides.sender),
    manifest: overrides.manifest ?? baseManifest(),
    criteria: overrides.criteria ?? baseCriteria(),
  });
}

function byCheckpoint(results, m) {
  return results.find((r) => r.checkpoint_m === m);
}

function loadTsModule(absPath) {
  const source = readFileSync(absPath, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(nativeRequire, module, module.exports);
  return module.exports;
}

function verify() {
  // ─── Structural sanity ───────────────────────────────────────────────────
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => parseJsonl('not json'));
  assert.equal(validateManifest(null).valid, false);
  assert.equal(validateManifest(baseManifest()).valid, true);
  assert.equal(validateManifest({ ...baseManifest(), system: 'V.9' }).valid, false);
  assert.equal(validateCriteria(baseCriteria()).valid, true);
  assert.equal(validateCriteria({ schema_version: 'm3-criteria-v1', max_rtt_ms: null, max_clock_uncertainty_ms: null, max_clock_drift_ms: null, max_route_reference_match_distance_m: null }).missing, true);

  // ─── A: exact coordinate match at checkpoint 0 ───────────────────────────
  {
    const result = run();
    const cp0 = byCheckpoint(result.results, 0);
    assert.equal(cp0.status, 'OK');
    assert.equal(cp0.join_mode, 'ID_VERIFIED');
    assert.equal(cp0.m3_distance_m, 0);
  }

  // ─── B: known geographic offset (independent Haversine cross-check) ─────
  {
    const a = { lat: 13.0, lng: 100.0 };
    const b = { lat: 13.001, lng: 100.0 };
    // Same longitude: great-circle distance reduces exactly to R * delta-lat (radians).
    const expected = EARTH_RADIUS_M * (0.001 * Math.PI / 180);
    assert.ok(Math.abs(haversineMeters(a, b) - expected) < 1e-6, 'haversine known-offset mismatch');
    assert.throws(() => haversineMeters({ lat: 999, lng: 0 }, b));
    assert.equal(isValidLatLng({ lat: 91, lng: 0 }), false);

    // Cross-check against the existing project Haversine helper (research/targetSender/distance.ts).
    const { haversineDistanceMeters } = loadTsModule(join(root, 'src/lib/research/targetSender/distance.ts'));
    const projectValue = haversineDistanceMeters({ latitude: a.lat, longitude: a.lng }, { latitude: b.lat, longitude: b.lng });
    assert.ok(Math.abs(projectValue - haversineMeters(a, b)) < 1e-9, 'diverges from project Haversine helper');
  }

  // ─── C: route target stays on an old sample while target sender advances ─
  {
    const result = run();
    const cp0 = byCheckpoint(result.results, 0);
    const cp500 = byCheckpoint(result.results, 500);
    assert.equal(cp0.route_update_id, 'ru-1');
    assert.equal(cp500.route_update_id, 'ru-1'); // only one route_active exists — reference never advances
    assert.ok(cp500.m3_distance_m > cp0.m3_distance_m);
  }

  // ─── D: new route accepted before a later checkpoint switches the reference ─
  {
    const newRoute = routeActive({ eventSeq: 4, serverTimeOffsetMs: 1000, routeUpdateId: 'ru-2', targetSampleId: sampleId(4), targetRef: pt(4), activationSeq: 2 });
    const result = run({ nav: { routeActives: [baseInitialRoute(), newRoute] } });
    assert.equal(byCheckpoint(result.results, 100).route_update_id, 'ru-1'); // checkpoint100 @ offset900 < 1000
    assert.equal(byCheckpoint(result.results, 150).route_update_id, 'ru-2'); // checkpoint150 @ offset1300 >= 1000
    assert.equal(byCheckpoint(result.results, 150).status, 'OK');
  }

  // ─── E: route accepted after checkpoint must not be used retroactively ──
  {
    const lateRoute = routeActive({ eventSeq: 4, serverTimeOffsetMs: 3000, routeUpdateId: 'ru-late', targetSampleId: sampleId(2), targetRef: pt(2), activationSeq: 2 });
    const result = run({ nav: { routeActives: [baseInitialRoute(), lateRoute] } });
    assert.equal(byCheckpoint(result.results, 500).route_update_id, 'ru-1'); // checkpoint500 @ offset2500 < 3000
  }

  // ─── F: target_sample_id null but route coordinates valid → OK_COORD_ONLY ─
  {
    const result = run({ nav: { routeActives: [baseInitialRoute({ targetSampleId: null })] } });
    const cp0 = byCheckpoint(result.results, 0);
    assert.equal(cp0.status, 'OK_COORD_ONLY');
    assert.equal(cp0.join_mode, 'COORD_ONLY');
    assert.equal(cp0.m3_distance_m, 0);
  }

  // ─── G: target_sample_id present and exact sender sample exists → ID_VERIFIED ─
  {
    const result = run();
    assert.equal(byCheckpoint(result.results, 0).join_mode, 'ID_VERIFIED');
    assert.equal(byCheckpoint(result.results, 0).status, 'OK');
  }

  // ─── H: target_sample_id present but sender sample missing ──────────────
  {
    const result = run({ nav: { routeActives: [baseInitialRoute({ targetSampleId: sampleId(99) })] } });
    const cp0 = byCheckpoint(result.results, 0);
    assert.equal(cp0.status, 'ROUTE_SAMPLE_MISMATCH');
    assert.equal(cp0.m3_distance_m, null);
  }

  // ─── I: duplicate target_sample_id invalidates the run ───────────────────
  {
    const samples = baseSenderSamples();
    samples.push(targetSample({ seq: 9, serverTimeOffsetMs: 2600, cumulativeDistanceM: 600, idOverride: sampleId(2) }));
    const result = run({ sender: { samples } });
    assert.equal(result.summary.run_validity, 'INVALID');
    assert.ok(result.results.every((r) => r.status === 'DUPLICATE_TARGET_SAMPLE_ID' && r.m3_distance_m === null));
  }

  // ─── J: wrong sender session ─────────────────────────────────────────────
  {
    const wrongSession = 'sender-session-WRONG';
    const result = run({
      sender: { samples: baseSenderSamples().map((s) => ({ ...s, sender_session_id: wrongSession, target_sample_id: sampleId(s.sequence, wrongSession) })), sessionId: wrongSession },
    });
    assert.equal(result.summary.run_validity, 'INVALID');
    assert.ok(result.results.every((r) => r.status === 'SENDER_SESSION_MISMATCH'));
  }

  // ─── K: wrong research_run_id ────────────────────────────────────────────
  {
    const wrongRunId = 'run-OTHER';
    const result = run({
      nav: { runId: wrongRunId, clock: navClockSync({ runId: wrongRunId }), routeActives: [baseInitialRoute({ runId: wrongRunId })] },
    });
    assert.equal(result.summary.run_validity, 'INVALID');
    assert.ok(result.results.every((r) => r.status === 'RUN_ID_MISMATCH'));
  }

  // ─── L: no accepted route anywhere in the run ────────────────────────────
  {
    const result = run({ nav: { routeActives: [] } });
    assert.equal(result.summary.run_validity, 'NO_OFFICIAL_RESULT');
    assert.ok(result.results.every((r) => r.status === 'NO_ROUTE' && r.m3_distance_m === null));
  }

  // ─── M: sender trace does not reach the requested checkpoint distance ───
  {
    const result = run({ sender: { samples: baseSenderSamples().slice(0, 7) } }); // stops before the 500 m crossing
    assert.equal(byCheckpoint(result.results, 300).status, 'OK');
    assert.equal(byCheckpoint(result.results, 500).status, 'MISSING_CANONICAL_SAMPLE');
    assert.equal(byCheckpoint(result.results, 500).m3_distance_m, null);
  }

  // ─── N: invalid coordinate on the canonical checkpoint sample ───────────
  {
    const samples = baseSenderSamples();
    samples[1] = { ...samples[1], target_lat: 999 }; // seq 2 == checkpoint 0's anchor
    const result = run({ sender: { samples } });
    const cp0 = byCheckpoint(result.results, 0);
    assert.equal(cp0.status, 'INVALID_COORDINATE');
    assert.equal(cp0.m3_distance_m, null);
  }

  // ─── O: missing clock criteria → no official M3 ──────────────────────────
  {
    const result = run({ criteria: { schema_version: 'm3-criteria-v1', max_rtt_ms: null, max_clock_uncertainty_ms: null, max_clock_drift_ms: null, max_route_reference_match_distance_m: null } });
    assert.equal(result.summary.run_validity, 'NO_OFFICIAL_RESULT');
    assert.ok(result.results.every((r) => r.status === 'CLOCK_SYNC_CRITERIA_MISSING' && r.m3_distance_m === null));
  }

  // ─── P: invalid clock sync (RTT exceeds criteria) ────────────────────────
  {
    const result = run({ nav: { clock: navClockSync({ rttMs: 500 }) } });
    assert.ok(result.results.every((r) => r.status === 'CLOCK_SYNC_INVALID' && r.m3_distance_m === null));
  }

  // ─── Q: multiple route_active before checkpoint → latest one wins ───────
  {
    const r2 = routeActive({ eventSeq: 4, serverTimeOffsetMs: 200, routeUpdateId: 'ru-2', targetSampleId: sampleId(2), targetRef: pt(2), activationSeq: 2 });
    const r3 = routeActive({ eventSeq: 5, serverTimeOffsetMs: 400, routeUpdateId: 'ru-3', targetSampleId: sampleId(2), targetRef: pt(2), activationSeq: 3 });
    const result = run({ nav: { routeActives: [baseInitialRoute(), r2, r3] } });
    assert.equal(byCheckpoint(result.results, 50).route_update_id, 'ru-3'); // checkpoint50 @ offset500, all three <= 500
  }

  // ─── R: one sender sample crosses multiple thresholds at once ───────────
  {
    const samples = [
      targetSample({ seq: 1, serverTimeOffsetMs: -500, cumulativeDistanceM: 0 }),
      targetSample({ seq: 2, serverTimeOffsetMs: 100, cumulativeDistanceM: 10 }), // baseline
      targetSample({ seq: 3, serverTimeOffsetMs: 500, cumulativeDistanceM: 600 }), // delta 590 >= every threshold up to 500
    ];
    const result = run({ sender: { samples } });
    for (const d of [50, 100, 150, 200, 300, 500]) {
      const cp = byCheckpoint(result.results, d);
      assert.equal(cp.checkpoint_sample_id, sampleId(3), `checkpoint ${d} should resolve to the crossing sample`);
      assert.ok(cp.shares_sample_with_checkpoints.length === 5, `checkpoint ${d} should report the other 5 checkpoints sharing its sample`);
    }
    assert.equal(byCheckpoint(result.results, 0).checkpoint_sample_id, sampleId(2));
  }

  // ─── S: checkpoint 0 rebase uses the first sample at/after initial route_active ─
  {
    const result = run();
    for (const cp of result.results) assert.equal(cp.baseline_distance_m, 10);
    const cp0 = byCheckpoint(result.results, 0);
    assert.equal(cp0.checkpoint_sample_id, sampleId(2)); // seq1 (offset -500) precedes the initial route and must be skipped
    assert.equal(cp0.checkpoint_cumulative_distance_m, 10);
  }

  // ─── CHECKPOINTS constant sanity ─────────────────────────────────────────
  assert.deepEqual(CHECKPOINTS, [0, 50, 100, 150, 200, 300, 500]);

  console.log('PASS: M3 analyzer fixtures A-S (checkpoint rebase/crossing, route selection, ID join, clock gate, missing-data states)');
}

verify();
