import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = readFileSync(resolve('src/lib/research/provenanceEvents.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
let time = 0;
let nextId = 0;
const fakePerformance = { now: () => ++time };
const fakeCrypto = { randomUUID: () => `SYNC-${++nextId}` };
new Function('require', 'module', 'exports', 'performance', 'crypto', code)(
  (id) => id === './clockSync' ? { probeResearchClockSync: async () => ({ success: false }) } : null,
  module, module.exports, fakePerformance, fakeCrypto,
);
const logger = module.exports;
assert.equal(logger.markVideoSync(), null);
assert.equal(logger.startResearchRun('m5-web-fixture'), 'm5-web-fixture');
const a = logger.markVideoSync();
const windowId = logger.startWalkingWindow();
const b = logger.markVideoSync();
assert.notEqual(a, b);
assert.equal(logger.getResearchLoggerSnapshot().videoSyncId, b);
logger.stopWalkingWindow();
logger.stopResearchRun();
assert.equal(logger.markVideoSync(), null);
assert.equal(logger.getResearchLoggerSnapshot().videoSyncId, null);
const sync = logger.getResearchProvenanceEvents().filter((x) => x.event === 'video_sync_marker');
assert.deepEqual(sync.map((x) => x.sync_id), [a, b]);
assert.deepEqual(sync.map((x) => x.sync_sequence), [1, 2]);
assert.deepEqual(sync.map((x) => x.walking_window_id), [null, windowId]);
assert.ok(sync.every((x) => x.research_run_id === 'm5-web-fixture' && x.platform === 'web'));
assert.ok(sync[0].event_seq < sync[1].event_seq && sync[0].monotonic_us < sync[1].monotonic_us);
process.stdout.write('M5 Web video sync logger contract passed\n');
