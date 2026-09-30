#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);
function loadTs(relativePath, mocks = {}) {
  const source = readFileSync(join(root, relativePath), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => id in mocks ? mocks[id] : nativeRequire(id);
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

const distance = loadTs('src/lib/research/targetSender/distance.ts');
const quality = loadTs('src/lib/research/targetSender/distanceQuality.ts', { './distance': distance });
const scheduleModule = loadTs('src/lib/research/clockSyncSchedule.ts');
const clockModule = loadTs('src/lib/research/clockSync.ts');
const sample = (sequence, lng, timestamp, accuracy = 5) => Object.freeze({
  targetSampleId: 'session:T' + String(sequence).padStart(6, '0'),
  sequence, latitude: 16.7, longitude: lng, accuracy, sourceTimestamp: timestamp,
});
const a = sample(1, 100.1, 1000);
const b = sample(2, 100.100001, 2000);
const originalA = { ...a };
const originalB = { ...b };
const rawDistance = distance.haversineDistanceMeters(a, b);
const unconfigured = quality.evaluateDistanceSegment({
  from: a, to: b, rawCumulativeDistanceM: rawDistance,
  previousValidatedDistanceM: null, startupReady: false,
  rule: quality.CALIBRATION_DISTANCE_RULE,
});
assert.ok(rawDistance > 0);
assert.equal(unconfigured.segment_distance_m, rawDistance);
assert.equal(unconfigured.segment_validation_status, 'CALIBRATION_UNCONFIGURED');
assert.equal(unconfigured.validated_cumulative_distance_m, null);
assert.equal(unconfigured.segment_valid_for_distance, null);
assert.ok(unconfigured.rejection_reasons.includes('CALIBRATION_UNCONFIGURED'));
assert.deepEqual(a, originalA);
assert.deepEqual(b, originalB);

const fixtureRule = {
  ...quality.CALIBRATION_DISTANCE_RULE,
  max_accuracy_m: 10,
  max_speed_mps: 5,
  min_source_delta_ms: 100,
  max_source_gap_ms: 5000,
  stationary_deadband_m: 0.5,
  startup_ready_rule: { min_consecutive_acceptable_samples: 2 },
};
assert.equal(quality.isDistanceRuleConfigured(quality.CALIBRATION_DISTANCE_RULE), false);
assert.equal(quality.isDistanceRuleConfigured(fixtureRule), true);
const evaluate = (from, to, extra = {}) => quality.evaluateDistanceSegment({
  from, to, rawCumulativeDistanceM: 100,
  previousValidatedDistanceM: 20, startupReady: true,
  rule: fixtureRule, ...extra,
});
const still = evaluate(a, b);
assert.equal(still.segment_validation_status, 'REJECTED');
assert.equal(still.validated_cumulative_distance_m, 20);
assert.ok(still.rejection_reasons.includes('STATIONARY_RULE'));
const nonpositive = evaluate(a, sample(2, 100.10001, 1000));
assert.equal(nonpositive.segment_speed_mps, null);
assert.ok(nonpositive.rejection_reasons.includes('INVALID_OR_NONMONOTONIC_SOURCE_TIME'));
const fast = evaluate(a, sample(2, 100.101, 2000));
assert.ok(fast.rejection_reasons.includes('IMPLAUSIBLE_SPEED'));
const poor = evaluate(a, sample(2, 100.10001, 2000, 50));
assert.ok(poor.rejection_reasons.includes('UNKNOWN_OR_POOR_ACCURACY'));
const gap = evaluate(a, sample(2, 100.10001, 12000));
assert.ok(gap.rejection_reasons.includes('LONG_GAP_REACQUISITION'));
const interrupted = evaluate(a, sample(2, 100.10001, 2000), { interveningRejectedObservation: true });
assert.equal(interrupted.segment_validation_status, 'UNRESOLVED');
assert.ok(interrupted.rejection_reasons.includes('UNRESOLVED_DISTANCE_GAP'));
assert.equal(interrupted.validated_cumulative_distance_m, 20);
const next = evaluate(sample(2, 100.10001, 2000), sample(3, 100.10002, 3000));
assert.equal(next.from_target_sample_id, 'session:T000002');
assert.equal(next.to_target_sample_id, 'session:T000003');

const senderSource = readFileSync(join(root, 'src/pages/research/target-sender.tsx'), 'utf8');
const apiSource = readFileSync(join(root, 'src/lib/research/targetSender/targetApi.ts'), 'utf8');
const navSource = readFileSync(join(root, 'src/lib/research/provenanceEvents.ts'), 'utf8');
assert.ok(senderSource.includes('queueSend(sample, identity, sessionGeneration)'));
assert.ok(senderSource.includes('raw_cumulative_distance_m: nextCumulativeDistanceM'));
assert.ok(senderSource.includes('callback_index: callbackIndexRef.current'));
assert.ok(senderSource.includes('speed_mps: sample.speed'));
assert.ok(senderSource.includes('validated_cumulative_distance_m: validatedDistanceRef.current'));
assert.ok(senderSource.includes("event: 'gps_observation_rejected'"));
assert.ok(senderSource.includes('interveningRejectedObservation: interveningRejectedObservationRef.current'));
assert.ok(apiSource.includes('latitude: input.sample.latitude'));
assert.ok(apiSource.includes('longitude: input.sample.longitude'));
assert.ok(apiSource.includes('target_sample_id: input.sample.targetSampleId'));
assert.ok(navSource.includes('beginClockSyncSchedule(researchRunId, generation)'));
assert.equal(scheduleModule.CALIBRATION_CLOCK_SYNC_INTERVAL_MS, 60_000);
const template = JSON.parse(readFileSync(join(root, 'scripts/m3-distance-quality.template.json'), 'utf8'));
assert.equal(template.max_accuracy_m, null);
assert.equal(template.max_speed_mps, null);
assert.equal(template.startup_ready_rule, null);

const oldFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ server_wall_clock_ms: Date.now() }) };
  };
  const result = await clockModule.probeResearchClockSync();
  assert.equal(calls, 3);
  assert.equal(result.subprobes.length, 3);
  assert.deepEqual(result.subprobes.map((probe) => probe.probe_index), [0, 1, 2]);
  assert.equal(result.success, true);
  assert.equal(result.selected_rtt_ms, result.rtt_ms);
  assert.ok(result.subprobes.every((probe) => Number.isFinite(probe.client_send_mono_ms) &&
    Number.isFinite(probe.client_receive_mono_ms)));
} finally {
  globalThis.fetch = oldFetch;
}

let now = 0;
let nextTimerId = 0;
const timers = new Map();
const timerDelays = [];
const pending = [];
const recorded = [];
const incompleteRounds = [];
const schedule = scheduleModule.startClockSyncSchedule({
  intervalMs: scheduleModule.CALIBRATION_CLOCK_SYNC_INTERVAL_MS,
  now: () => now,
  setTimer: (callback, delayMs) => {
    timerDelays.push(delayMs);
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  },
  clearTimer: (id) => { timers.delete(id); },
  probe: () => new Promise((resolve) => pending.push(resolve)),
  record: (round, result, error) => recorded.push({ round, result, error }),
  recordIncomplete: (round) => incompleteRounds.push(round),
});
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const clockResult = (success) => ({
  success, subprobes: [0, 1, 2].map((probe_index) => ({ probe_index, success })),
});
await flush();
assert.equal(pending.length, 1);
assert.equal(recorded.length, 0);
assert.equal(timers.size, 0, 'a second round cannot start while the first is in flight');
now = 250;
pending.shift()(clockResult(true));
await flush();
assert.equal(recorded.length, 1);
assert.equal(recorded[0].round.sync_index, 0);
assert.equal(recorded[0].round.sync_phase, 'initial');
assert.equal(timers.size, 1);
assert.equal(timerDelays[0], 59_750, 'the next round stays anchored to START');

now = 60_000;
const firstTimer = timers.entries().next().value;
timers.delete(firstTimer[0]);
firstTimer[1]();
await flush();
assert.equal(pending.length, 1);
assert.equal(recorded.length, 1);
now = 60_200;
pending.shift()(clockResult(false));
await flush();
assert.equal(recorded.length, 2);
assert.equal(recorded[1].round.sync_index, 1);
assert.equal(recorded[1].round.sync_phase, 'periodic');
assert.equal(recorded[1].result.success, false);
assert.equal(timers.size, 1);
assert.equal(timerDelays[1], 59_800);

now = 120_000;
const secondTimer = timers.entries().next().value;
timers.delete(secondTimer[0]);
secondTimer[1]();
await flush();
assert.equal(pending.length, 1);
schedule.stop();
assert.equal(incompleteRounds.length, 1);
assert.equal(incompleteRounds[0].sync_index, 2);
pending.shift()(clockResult(true));
await flush();
assert.equal(recorded.length, 2, 'late completion must not append');
assert.equal(timers.size, 0, 'STOP must cancel future periodic rounds');
schedule.stop();
assert.equal(incompleteRounds.length, 1, 'STOP is idempotent');

console.log('PASS: M3 calibration distance, raw payload, detailed probes, periodic scheduling, failures, and stop/late safety');
