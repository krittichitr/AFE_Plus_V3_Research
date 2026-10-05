#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);
const transpile = (path) => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = (path, dependencies = {}, globals = {}) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), transpile(path))(
    (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : nativeRequire(id),
    module, module.exports, ...Object.values(globals),
  );
  return module.exports;
};

const previousRedis = process.env.REDIS_URL;
const previousUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const previousUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.REDIS_URL = 'redis://fixture';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const records = new Map();
class RedisMock {
  async hgetall(key) { return records.get(key) ?? {}; }
}
const journalLib = load(resolve(root, 'src/lib/research/m2Journal.ts'), {
  ioredis: { default: RedisMock },
});
const run = 'v3-01';
const token = 'run-token-01';
const key = (id) => `research:m2:${encodeURIComponent(id)}`;
const attempt = { event: 'm2_mapbox_attempt', research_run_id: run, m2_run_token: token,
  mapbox_attempt_id: 'attempt-1', request_phase: 'initial', operation: 'initial_graph' };
const outcome = { event: 'm2_mapbox_outcome', mapbox_attempt_id: 'attempt-1', success: true };
records.set(key(run), { __schema: 'm2-v2', __start: '1', __stop: '2', __token: token,
  'a:attempt-1': JSON.stringify(attempt), 'o:attempt-1': JSON.stringify(outcome) });
records.set(key('other-run'), { __schema: 'm2-v2', __start: '1', __stop: '2', __token: 'other-token' });
records.set(key('not-stopped'), { __schema: 'm2-v2', __start: '1', __token: 'pending-token' });

try {
  assert.equal(await journalLib.authorizeM2JournalExport(run, token), true);
  assert.equal(await journalLib.authorizeM2JournalExport(run, 'wrong-token'), false);
  assert.equal(await journalLib.authorizeM2JournalExport('other-run', token), false);
  assert.equal(await journalLib.authorizeM2JournalExport('not-stopped', 'pending-token'), false);

  const handler = load(resolve(root, 'src/pages/api/research/m2-journal.ts'), {
    '@/lib/research/m2Journal': journalLib,
  }).default;
  const invoke = async (body) => {
    const res = { statusCode: 200, body: null, headers: {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
      setHeader(name, value) { this.headers[name] = value; return this; } };
    await handler({ method: 'POST', body }, res);
    return res;
  };
  const denied = await invoke({ boundary: 'export', research_run_id: 'other-run', m2_run_token: token });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.attempts, undefined);
  const pending = await invoke({ boundary: 'export', research_run_id: 'not-stopped', m2_run_token: 'pending-token' });
  assert.equal(pending.statusCode, 403);
  const allowed = await invoke({ boundary: 'export', research_run_id: run, m2_run_token: token });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.complete_for_m2, true);
  assert.equal(allowed.body.attempts[0].mapbox_attempt_id, 'attempt-1');
  assert.equal(allowed.headers['Cache-Control'], 'no-store');

  records.set(key(run), { ...records.get(key(run)), __invalid: 'fixture_invalid' });
  const incomplete = await invoke({ boundary: 'export', research_run_id: run, m2_run_token: token });
  assert.equal(incomplete.statusCode, 200);
  assert.equal(incomplete.body.complete_for_m2, false);
  assert.equal(incomplete.body.integrity_status, 'INCOMPLETE');
  assert(incomplete.body.journal_errors.includes('run_invalid:fixture_invalid'));

  let downloadedName = null;
  let downloadedBlob = null;
  const dom = {
    visibilityState: 'visible',
    createElement: () => ({ click() { downloadedName = this.download; } }),
  };
  const urlApi = {
    createObjectURL(blob) { downloadedBlob = blob; return 'blob:fixture'; },
    revokeObjectURL() {},
  };
  const browserFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.boundary === 'start') return { ok: true, json: async () => ({ m2_run_token: token }) };
    if (request.boundary === 'stop') return { ok: true, json: async () => ({ saved: true }) };
    assert.equal(request.boundary, 'export');
    assert.equal(request.research_run_id, run);
    assert.equal(request.m2_run_token, token);
    return { ok: true, json: async () => incomplete.body };
  };
  const browser = load(resolve(root, 'src/lib/research/provenanceEvents.ts'), {
    './clockSync': { probeResearchClockSync: async () => ({ success: true }) },
    './clockSyncSchedule': null,
  }, { fetch: browserFetch, document: dom, URL: urlApi, Blob });
  await assert.rejects(browser.exportM2ResearchJournal(), /Run authorization unavailable/);
  await browser.startM2ResearchRun(run);
  await assert.rejects(browser.exportM2ResearchJournal(), /Run authorization unavailable/);
  browser.stopResearchRun();
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(browser.getResearchLoggerSnapshot().m2Status, 'STOPPED');
  const browserResult = await browser.exportM2ResearchJournal();
  assert.equal(browserResult.complete_for_m2, false);
  assert.equal(downloadedName, 'v3-01-m2-journal.json');
  assert.deepEqual(JSON.parse(await downloadedBlob.text()), incomplete.body);
  browser.clearResearchRun();
  await assert.rejects(browser.exportM2ResearchJournal(), /Run authorization unavailable/);
  const reloaded = load(resolve(root, 'src/lib/research/provenanceEvents.ts'), {
    './clockSync': { probeResearchClockSync: async () => ({ success: true }) },
    './clockSyncSchedule': null,
  }, { fetch: browserFetch, document: dom, URL: urlApi, Blob });
  await assert.rejects(reloaded.exportM2ResearchJournal(), /Run authorization unavailable/);

  const panel = readFileSync(resolve(root, 'src/components/research/ResearchLogPanel.tsx'), 'utf8');
  assert.match(panel, /setExpanded\(false\)/);
  assert.match(panel, /setExpanded\(true\)/);
  assert.match(panel, /EXPORT M2 JOURNAL/);
  const browserFiles = ['src/components/research/ResearchLogPanel.tsx',
    'src/lib/research/provenanceEvents.ts', 'src/pages/location.tsx',
    'src/lib/research/navigationResearchQuery.ts'];
  for (const file of browserFiles) {
    assert(!readFileSync(resolve(root, file), 'utf8').includes('M2_RESEARCH_EXPORT_TOKEN'), file);
    assert(!readFileSync(resolve(root, file), 'utf8').includes('NEXT_PUBLIC_M2_'), file);
  }
  console.log('PASS: run-scoped stopped export, unrelated ID denial, incomplete truth, browser filename and secret boundary');
} finally {
  if (previousRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previousRedis;
  if (previousUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = previousUpstashUrl;
  if (previousUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = previousUpstashToken;
}

