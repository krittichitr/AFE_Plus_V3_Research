import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeM4, parseJsonl } from './analyze-m4.mjs';

let passed = 0;
function check(name, rows, expected) {
  const result = analyzeM4(rows);
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(result[field], value, `${name}: ${field}`);
  }
  if (result.status !== 'OK') {
    assert.equal(result.median_interval_ms, null, `${name}: invalid median`);
    assert.equal(result.p95_interval_ms, null, `${name}: invalid p95`);
  }
  passed += 1;
  return result;
}

function fixture({ platform = 'web', callbacks = [500, 1500, 2500, 3500],
  before = [], after = [], between = [], start = 0, stop = 4_000,
  dropped = 0, includeHealth = true, includeStart = true, includeStop = true } = {}) {
  const us = (ms) => ms * 1000;
  const rows = [{ event: 'run_start', monotonic_us: 0 }];
  for (const ms of before) rows.push({ event: 'raw_location_received', monotonic_us: us(ms), coordinate_valid: true, latitude: 16.7, longitude: 100.1 });
  if (includeStart) rows.push({ event: 'walking_window_start', monotonic_us: us(start), walking_window_id: 'walk-1', annotation_source: 'manual_operator' });
  for (const item of callbacks) rows.push(typeof item === 'number'
    ? { event: 'raw_location_received', monotonic_us: us(item), coordinate_valid: true, latitude: 16.7, longitude: 100.1 }
    : { event: 'raw_location_received', coordinate_valid: true, latitude: 16.7, longitude: 100.1, ...item });
  for (const event of between) {
    const nextLocation = rows.findIndex((row) => row.event === 'raw_location_received'
      && row.monotonic_us > event.monotonic_us);
    if (nextLocation < 0) rows.push(event);
    else rows.splice(nextLocation, 0, event);
  }
  if (includeStop) rows.push({ event: 'walking_window_stop', monotonic_us: us(stop), walking_window_id: 'walk-1', annotation_source: 'manual_operator' });
  for (const ms of after) rows.push({ event: 'raw_location_received', monotonic_us: us(ms), coordinate_valid: true, latitude: 16.7, longitude: 100.1 });
  rows.push({ event: 'run_stop', monotonic_us: us(Math.max(stop + 1000, 6_000)) });
  for (const [index, row] of rows.entries()) {
    row.event_seq = index + 1;
    row.research_run_id = 'controlled-run';
    row.platform = platform;
    if (row.event === 'raw_location_received') row.location_sample_id = index + 1;
  }
  if (includeHealth) rows.push({
    event: 'logger_health', event_seq: rows.length + 1,
    research_run_id: 'controlled-run', platform, monotonic_us: us(7_000),
    attempted_events: rows.length + dropped, stored_events: rows.length,
    dropped_events: dropped, export_format: 'jsonl', export_requested: true,
  });
  return rows;
}

const regular = check('A regular', fixture(), {
  status: 'OK', raw_callback_count: 4, valid_callback_count: 4,
  interval_count: 3, median_interval_ms: 1000, p95_interval_ms: 1000,
});
assert.equal(regular.intervals.length, 3);
check('B odd median', fixture({ callbacks: [500, 600, 800, 1100] }), { status: 'OK', median_interval_ms: 200 });
check('C even median', fixture({ callbacks: [500, 600, 800, 1100, 1500] }), { status: 'OK', median_interval_ms: 250 });
const cumulative = [500];
for (let step = 1; step <= 20; step += 1) cumulative.push(cumulative.at(-1) + step);
check('D nearest rank', fixture({ callbacks: cumulative }), { status: 'OK', interval_count: 20, p95_interval_ms: 19 });
check('E one callback', fixture({ callbacks: [500] }), { status: 'INSUFFICIENT_CALLBACKS', interval_count: 0 });
check('F before start', fixture({ start: 1000, before: [500], callbacks: [1500, 2500] }), { status: 'OK', raw_callback_count: 2, interval_count: 1, median_interval_ms: 1000 });
check('G after stop', fixture({ stop: 3000, callbacks: [500, 1500, 2500], after: [3500] }), { status: 'OK', raw_callback_count: 3, interval_count: 2 });
check('H inclusive boundary', fixture({ callbacks: [0, 4000] }), { status: 'OK', raw_callback_count: 2, median_interval_ms: 4000 });
check('I duplicate time', fixture({ callbacks: [500, 500] }), { status: 'NON_MONOTONIC_TIMESTAMP' });
check('J backwards time', fixture({ callbacks: [1500, 500] }), { status: 'NON_MONOTONIC_TIMESTAMP' });
check('K invalid coordinate', fixture({ callbacks: [500, { monotonic_us: 1_500_000, coordinate_valid: false, latitude: null }, 2500] }), {
  status: 'OK', raw_callback_count: 3, valid_callback_count: 2,
  invalid_callback_count: 1, interval_count: 1, median_interval_ms: 2000,
});
check('L duplicate coordinates', fixture({ callbacks: [500, 1500] }), { status: 'OK', valid_callback_count: 2, interval_count: 1 });
check('M transient error', fixture({ callbacks: [500, 2500], between: [{ event: 'raw_location_error', monotonic_us: 1_500_000, error_code: 3 }] }), {
  status: 'OK', location_error_count: 1, interval_count: 1, median_interval_ms: 2000,
});
check('N fatal error', fixture({ between: [{ event: 'raw_location_error', monotonic_us: 3_700_000, error_code: 1 }] }), { status: 'LOCATION_STREAM_ERROR', location_error_count: 1 });
check('O dropped', fixture({ dropped: 1 }), { status: 'DROPPED_EVENTS', dropped_events: 1 });
check('P missing health', fixture({ includeHealth: false }), { status: 'INCOMPLETE_LOG' });
check('Q no window', fixture({ includeStart: false, includeStop: false }), { status: 'NO_WALKING_WINDOW' });
check('Q partial window', fixture({ includeStop: false }), { status: 'PROTOCOL_ERROR' });
const duplicateStart = fixture();
duplicateStart.splice(2, 0, { ...duplicateStart[1] });
duplicateStart.forEach((row, index) => { row.event_seq = index + 1; if (row.event === 'raw_location_received') row.location_sample_id = index + 1; });
duplicateStart.at(-1).stored_events = duplicateStart.length - 1;
duplicateStart.at(-1).attempted_events = duplicateStart.length - 1;
check('R duplicate starts', duplicateStart, { status: 'PROTOCOL_ERROR' });
check('S stop before start', fixture({ start: 4000, stop: 4000 }), { status: 'PROTOCOL_ERROR' });
const web = check('T Web', fixture({ platform: 'web' }), { status: 'OK', interval_count: 3, median_interval_ms: 1000, p95_interval_ms: 1000 });
const mobile = check('U Mobile', fixture({ platform: 'mobile' }), { status: 'OK', interval_count: 3, median_interval_ms: 1000, p95_interval_ms: 1000 });
assert.deepEqual([web.interval_count, web.median_interval_ms, web.p95_interval_ms], [mobile.interval_count, mobile.median_interval_ms, mobile.p95_interval_ms]);
check('V lifecycle', fixture({ between: [{ event: 'lifecycle_visibility_changed', monotonic_us: 2_000_000, visibility_state: 'hidden' }] }), { status: 'LIFECYCLE_INTERRUPTED' });
check('W stationary before walking', fixture({ start: 15_000, stop: 20_000, before: [500, 1500, 2500], callbacks: [15_500, 16_500] }), {
  status: 'OK', raw_callback_count: 2, interval_count: 1, median_interval_ms: 1000,
});
check('mobile paused', fixture({ platform: 'mobile', between: [{ event: 'lifecycle_state_changed', monotonic_us: 2_000_000, lifecycle_state: 'paused' }] }), { status: 'LIFECYCLE_INTERRUPTED' });
check('missing run stop', fixture().filter((row) => row.event !== 'run_stop'), { status: 'INCOMPLETE_LOG' });
check('parse JSONL', parseJsonl(fixture().map((row) => JSON.stringify(row)).join('\n')), { status: 'OK' });

const directory = mkdtempSync(join(tmpdir(), 'm4-fixture-'));
try {
  const input = join(directory, 'web.jsonl');
  const intervalsOutput = join(directory, 'intervals.json');
  writeFileSync(input, `${fixture().map((row) => JSON.stringify(row)).join('\n')}\n`);
  const cli = spawnSync(process.execPath, [new URL('./analyze-m4.mjs', import.meta.url).pathname,
    '--input', input, '--intervals-output', intervalsOutput], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).median_interval_ms, 1000);
  assert.equal(JSON.parse(readFileSync(intervalsOutput, 'utf8')).length, 3);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const webSource = readFileSync(new URL('../src/pages/navigation.tsx', import.meta.url), 'utf8');
assert.match(webSource, /\(pos\) => \{\s*const receiptPerformanceMs = performance\.now\(\);/);
assert.match(webSource, /\{ enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 \}/);
console.log(`M4-PROTOCOL-V1 controlled fixtures passed: ${passed}`);
