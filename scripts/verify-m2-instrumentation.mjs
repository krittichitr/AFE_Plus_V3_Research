#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { validateM2Journal } from './validate-m2-journal.mjs';

const root = resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);
const route = { code: 'Ok', routes: [{ distance: 10, duration: 10, legs: [{ steps: [] }] }] };

function harness(fetchImpl, journalGate = null, journalFails = false) {
  const attempts = [];
  const outcomes = [];
  const order = [];
  const invalid = [];
  const cache = new Map();
  const stubs = {
    '@/config/navigation-env': { env: { MAPBOX_ACCESS_TOKEN: 'fixture-token', MAPBOX_PROFILE: 'driving' } },
    '@/lib/research/m2Journal': {
      journalM2Attempt: async (attempt) => { if (journalGate) await journalGate; if (journalFails) return false; attempts.push(attempt); order.push('ack'); return true; },
      journalM2Outcome: async (_runId, outcome) => { outcomes.push(outcome); return true; },
      markM2RunInvalid: async (_runId, reason) => { invalid.push(reason); if (journalFails) throw new Error('marker_unavailable'); },
    },
    '@/lib/navigation/logger': {
      createLogger: () => ({ info() {}, warn() {}, error() {} }),
      MapboxApiError: class MapboxApiError extends Error {},
    },
  };
  function load(file) {
    const path = file.endsWith('.ts') ? file : `${file}.ts`;
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const source = readFileSync(path, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = (id) => {
      if (Object.hasOwn(stubs, id)) return stubs[id];
      if (id.startsWith('@/')) return load(join(root, 'src', id.slice(2)));
      if (id.startsWith('.')) {
        const resolved = resolve(dirname(path), id);
        if (resolved.endsWith('/navigation/logger')) return stubs['@/lib/navigation/logger'];
        if (resolved.endsWith('/research/m2Journal')) return stubs['@/lib/research/m2Journal'];
        return load(resolved);
      }
      return nativeRequire(id);
    };
    new Function('require', 'module', 'exports', 'fetch', code)(localRequire, module, module.exports, fetchImpl);
    return module.exports;
  }
  return { load, attempts, outcomes, order, invalid };
}

function seed(kind, phase = kind) {
  return {
    researchRunId: 'run-fixture', routeUpdateId: `update-${kind}`, targetSampleId: 'sender:T000001',
    targetRefLat: 13, targetRefLng: 100, requestKind: kind, requestPhase: phase,
    sessionId: kind === 'init' ? null : 'session-1',
    m2ResearchMode: true, m2RunToken: 'fixture-token',
  };
}

function loadRealJournal(redisMock) {
  const file = join(root, 'src/lib/research/m2Journal.ts');
  const source = readFileSync(file, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => id === 'ioredis' ? { default: redisMock } : nativeRequire(id), module, module.exports);
  return module.exports;
}

async function verify() {
  let fetchCalls = 0;
  let h;
  const okFetch = async () => { fetchCalls++; h.order.push('fetch'); return { ok: true, status: 200, json: async () => route }; };
  h = harness(okFetch);
  const backend = h.load(join(root, 'src/lib/research/backendResearch.ts'));
  const mapbox = h.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  const bubble = h.load(join(root, 'src/lib/navigation/bubble.graph.ts'));
  const point = { lat: 13, lng: 100 };
  await backend.withBackendResearchContext(seed('init'), async () => {
    await Promise.all([mapbox.fetchMultiProfileDirections(point, point), bubble.fetchBubbleRays(point)]);
  });
  assert.equal(fetchCalls, 10);
  assert.equal(h.attempts.length, 10);
  let acknowledged = 0;
  let fetched = 0;
  for (const event of h.order) {
    if (event === 'ack') acknowledged++;
    if (event === 'fetch') { fetched++; assert(acknowledged >= fetched); }
  }
  assert.equal(new Set(h.attempts.map((item) => item.mapbox_attempt_id)).size, 10);
  assert.equal(h.attempts.filter((item) => item.request_purpose === 'target_ray').length, 8);
  assert.equal(new Set(h.attempts.filter((item) => item.request_purpose === 'target_ray').map((item) => item.ray_direction)).size, 8);
  assert(h.attempts.every((item) => item.operation === 'initial_graph' && item.request_phase === 'initial'));

  await backend.withBackendResearchContext(seed('update', 'incremental'), async () => {});
  assert.equal(fetchCalls, 10); // Incremental graph reuse reaches no Directions site.
  await backend.withBackendResearchContext(seed('update', 'incremental'), async () => {
    await mapbox.fetchMultiProfileDirections(point, point);
  });
  assert.equal(fetchCalls, 12);
  assert(h.attempts.slice(-2).every((item) => item.operation === 'graph_refetch' && item.request_phase === 'navigation'));

  let retryCalls = 0;
  const retryHarness = harness(async () => {
    retryCalls++;
    if (retryCalls === 1) return { ok: false, status: 503, text: async () => 'failed' };
    return { ok: true, status: 200, json: async () => route };
  });
  const retryBackend = retryHarness.load(join(root, 'src/lib/research/backendResearch.ts'));
  const retryClient = retryHarness.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  await retryBackend.withBackendResearchContext(seed('init'), () => retryClient.fetchDirections(point, point, { profile: 'driving' }));
  assert.equal(retryCalls, 2);
  assert.equal(retryHarness.attempts.length, 2);
  assert.notEqual(retryHarness.attempts[0].mapbox_attempt_id, retryHarness.attempts[1].mapbox_attempt_id);
  assert.equal(retryHarness.outcomes[0].success, false);
  assert.equal(retryHarness.outcomes[0].http_status, 503);

  const rejected = harness(async () => { throw new Error('network'); });
  const rejectedBackend = rejected.load(join(root, 'src/lib/research/backendResearch.ts'));
  const rejectedClient = rejected.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  await rejectedBackend.withBackendResearchContext(seed('init'), async () => {
    for (let i = 0; i < 3; i++) await assert.rejects(rejectedClient.fetchDirections(point, point));
    const before = rejected.attempts.length;
    await assert.rejects(rejectedClient.fetchDirections(point, point));
    assert.equal(rejected.attempts.length, before); // OPEN rejected before callback.
  });
  assert(rejected.outcomes.every((item) => item.success === false));

  let failedFetches = 0;
  const failedJournal = harness(async () => { failedFetches++; return { ok: true, status: 200, json: async () => route }; }, null, true);
  const failedBackend = failedJournal.load(join(root, 'src/lib/research/backendResearch.ts'));
  const failedClient = failedJournal.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  await failedBackend.withBackendResearchContext(seed('init'), async () => {
    await assert.rejects(failedClient.fetchDirections(point, point), /M2_DURABLE_ATTEMPT_ACK_FAILED|Circuit/);
  });
  assert.equal(failedFetches, 0);
  assert.equal(failedJournal.attempts.length, 0);
  assert(failedJournal.invalid.includes('M2_DURABLE_ATTEMPT_ACK_FAILED'));

  let normalFetches = 0;
  const normalHarness = harness(async () => { normalFetches++; return { ok: true, status: 200, json: async () => route }; }, null, true);
  const normalBackend = normalHarness.load(join(root, 'src/lib/research/backendResearch.ts'));
  const normalClient = normalHarness.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  await normalBackend.withBackendResearchContext({ ...seed('init'), m2ResearchMode: false, m2RunToken: null },
    () => normalClient.fetchDirections(point, point));
  assert.equal(normalFetches, 1);
  assert.equal(normalHarness.attempts.length, 0);

  const journal = {
    research_run_id: 'run-fixture', integrity_status: 'COMPLETE',
    complete_for_m2: true, attempts: h.attempts, outcomes: h.outcomes, journal_errors: [],
  };
  const valid = validateM2Journal(journal);
  assert.equal(valid.valid, true, valid.errors.join(','));
  assert.deepEqual([valid.initial, valid.additional, valid.total], [10, 2, 12]);
  assert.equal(validateM2Journal({ ...journal, attempts: [...h.attempts, h.attempts[0]] }).valid, false);
  assert.equal(validateM2Journal({ ...journal, complete_for_m2: false }).valid, false);
  assert.equal(validateM2Journal({ ...journal, outcomes: [{ mapbox_attempt_id: 'absent' }] }).valid, false);

  let releaseJournal;
  const delayedJournal = new Promise((resolve) => { releaseJournal = resolve; });
  let barrierFetchCalls = 0;
  const barrierHarness = harness(async () => {
    barrierFetchCalls++;
    return { ok: true, status: 200, json: async () => route };
  }, delayedJournal);
  const barrierBackend = barrierHarness.load(join(root, 'src/lib/research/backendResearch.ts'));
  const barrierClient = barrierHarness.load(join(root, 'src/lib/navigation/mapbox.client.ts'));
  let responseSent = false;
  const response = { json() { responseSent = true; return this; } };
  const pendingResponse = barrierBackend.withBackendResearchContext(seed('init'), async () => {
    await barrierClient.fetchDirections(point, point, { profile: 'driving' });
    response.json({ success: true });
  }, response);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(barrierFetchCalls, 0); // Fetch must wait for durable acknowledgement.
  assert.equal(responseSent, false);
  releaseJournal();
  await pendingResponse;
  assert.equal(barrierFetchCalls, 1);
  assert.equal(responseSent, true);
  const timedAttempts = h.attempts.map((item, index) => ({ ...item, dispatch_wall_clock_ms: index < 10 ? 100 + index : 200 + (index - 10) * 10 }));
  const checkpointResult = validateM2Journal(
    { ...journal, attempts: timedAttempts },
    { research_run_id: 'run-fixture', sender_session_id: 'sender', initial_route_accepted_wall_clock_ms: 150, sender_to_dispatch_clock_offset_ms: 0 },
    [50, 100, 150, 200, 300, 500].map((distance, index) => ({ event: 'target_sample', sender_session_id: 'sender', cumulative_distance_m: distance, source_timestamp_ms: 205 + index * 20 })),
  );
  assert.equal(checkpointResult.valid, true);
  assert.deepEqual([checkpointResult.cumulative[0], checkpointResult.cumulative[50], checkpointResult.cumulative[100]], [10, 11, 12]);

  // A fresh journal module (simulated new server process) can retrieve the
  // attempt without any navigation API response or browser-imported event.
  const savedRedisUrl = process.env.REDIS_URL;
  const savedUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.REDIS_URL = 'redis://fixture';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const persisted = new Map();
  let failNextWrite = false;
  class FakeRedis {
    async eval(script, _count, key, ...args) {
      if (failNextWrite) { failNextWrite = false; throw new Error('fixture_store_failure'); }
      const fields = persisted.get(key) ?? {};
      if (script.includes("'__start') == 1")) {
        if (fields.__start) return 0;
        Object.assign(fields, { __schema: 'm2-v2', __start: args[0], __token: args[1] });
      } else if (script.includes("'__stop') == 1") && !script.includes("ARGV[2]) == 1")) {
        if (fields.__token !== args[0] || fields.__stop) return 0;
        fields.__stop = args[1];
        if (args[2] === '1') fields.__invalid = 'client_reported_invalid';
      } else {
        if (fields.__token !== args[0] || fields.__stop || fields[args[1]]) return 0;
        fields[args[1]] = args[2];
      }
      persisted.set(key, fields);
      return 1;
    }
    async hset(key, ...items) {
      if (failNextWrite) { failNextWrite = false; throw new Error('fixture_store_failure'); }
      const fields = persisted.get(key) ?? {};
      for (let i = 0; i < items.length; i += 2) fields[items[i]] = items[i + 1];
      persisted.set(key, fields);
    }
    async hgetall(key) { return persisted.get(key) ?? {}; }
  }
  try {
    const writer = loadRealJournal(FakeRedis);
    const runToken = await writer.journalM2RunStart('run-fixture');
    assert.equal(typeof runToken, 'string');
    assert.equal(await writer.journalM2Attempt({ ...h.attempts[0], m2_run_token: runToken }), true);
    assert.equal(await writer.journalM2Outcome('run-fixture', h.outcomes[0]), true);
    assert.equal(await writer.journalM2RunStop('run-fixture', runToken), true);
    const reader = loadRealJournal(FakeRedis);
    const recovered = await reader.readM2Journal('run-fixture');
    assert.equal(recovered.complete_for_m2, true);
    assert.equal(recovered.attempts.length, 1);
    assert.equal(recovered.attempts[0].mapbox_attempt_id, h.attempts[0].mapbox_attempt_id);
    const pendingToken = await writer.journalM2RunStart('run-pending');
    assert.equal(await writer.journalM2Attempt({ ...h.attempts[1], research_run_id: 'run-pending', m2_run_token: pendingToken }), true);
    assert.equal(await writer.journalM2RunStop('run-pending', pendingToken), true);
    const pending = await reader.readM2Journal('run-pending');
    assert.equal(pending.complete_for_m2, false);
    assert(pending.journal_errors.some((item) => item.startsWith('outcome_pending:')));
    assert.equal(await writer.journalM2RunStart('run-fixture'), null); // stale run ID cannot be reused.
    assert.equal(await writer.journalM2RunStop('run-pending', 'stale-token'), false);
    failNextWrite = true;
    assert.equal(await writer.journalM2Attempt({ ...h.attempts[1], m2_run_token: runToken }), false);
    const incomplete = await reader.readM2Journal('run-fixture');
    assert.equal(incomplete.complete_for_m2, false);
    assert(incomplete.journal_errors.some((item) => item.includes('run_invalid')));
    delete process.env.REDIS_URL;
    const unavailableWriter = loadRealJournal(FakeRedis);
    assert.equal(await unavailableWriter.journalM2RunStart('run-other'), null);
    const unavailable = await unavailableWriter.readM2Journal('run-other');
    assert.equal(unavailable.complete_for_m2, false);
    assert.match(unavailable.integrity_status, /DURABILITY NOT AVAILABLE/);
  } finally {
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedRedisUrl;
    if (savedUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = savedUpstashUrl;
    if (savedUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = savedUpstashToken;
  }

  console.log('PASS: V3 10 init attempts, refetch/incremental classification, retry, failure, circuit OPEN, response-loss recovery, journal failure, validator integrity');
}

await verify();
