import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROTOCOL = 'M4-PROTOCOL-V1';
const FATAL_CODES = new Set([
  'LOCATION_SERVICE_DISABLED',
  'LOCATION_PERMISSION_DENIED',
  'LOCATION_PERMISSION_DENIED_FOREVER',
  'PERMISSION_DENIED',
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validCoordinate(row) {
  return row.coordinate_valid === true
    && finiteNumber(row.latitude) && row.latitude >= -90 && row.latitude <= 90
    && finiteNumber(row.longitude) && row.longitude >= -180 && row.longitude <= 180;
}

function errorLabel(row) {
  return String(row.error_code ?? row.error_type ?? row.error_message ?? 'UNKNOWN');
}

function isFatalError(row, rows, stopUs) {
  const code = errorLabel(row).toUpperCase();
  if (FATAL_CODES.has(code) || row.error_code === 1) return true;
  // A stream error with a later usable callback is observable as a transient gap.
  return !rows.some((candidate) => candidate.event === 'raw_location_received'
    && validCoordinate(candidate) && finiteNumber(candidate.monotonic_us)
    && candidate.monotonic_us > row.monotonic_us
    && candidate.monotonic_us <= stopUs);
}

function lifecycleInterrupted(row) {
  if (row.event === 'lifecycle_page_hidden' || row.event === 'navigation_screen_disposed') return true;
  if (row.event === 'location_subscription_state' && row.state === 'stopped') return true;
  if (row.event === 'lifecycle_visibility_changed' && row.visibility_state !== 'visible') return true;
  if (row.event === 'lifecycle_state_changed' && row.lifecycle_state !== 'resumed') return true;
  if ('visibility_state' in row && row.visibility_state != null && row.visibility_state !== 'visible') return true;
  if ('lifecycle_state' in row && row.lifecycle_state != null && row.lifecycle_state !== 'resumed') return true;
  return false;
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function analyzeM4(rows) {
  const output = {
    protocol: PROTOCOL,
    research_run_id: null,
    platform: null,
    walking_window_id: null,
    walking_window_start_us: null,
    walking_window_stop_us: null,
    walking_window_duration_ms: null,
    raw_callback_count: 0,
    valid_callback_count: 0,
    invalid_callback_count: 0,
    interval_count: 0,
    median_interval_ms: null,
    p95_interval_ms: null,
    min_interval_ms: null,
    max_interval_ms: null,
    location_error_count: 0,
    location_error_types: [],
    dropped_events: null,
    lifecycle_event_count: 0,
    status: 'INCOMPLETE_LOG',
    diagnostic_reason: 'Input is not a complete JSONL run',
    intervals: [],
  };
  const fail = (status, reason) => ({ ...output, status, diagnostic_reason: reason });
  if (!Array.isArray(rows) || rows.length < 4 || rows.some((row) => !row || typeof row !== 'object'
    || Array.isArray(row) || typeof row.event !== 'string')) {
    return fail('INCOMPLETE_LOG', 'Missing or malformed event rows');
  }

  const starts = rows.filter((row) => row.event === 'run_start');
  const stops = rows.filter((row) => row.event === 'run_stop');
  const healthRows = rows.filter((row) => row.event === 'logger_health');
  if (starts.length !== 1 || stops.length !== 1 || healthRows.length !== 1) {
    return fail('INCOMPLETE_LOG', 'Require exactly one run_start, run_stop and logger_health');
  }
  const runStart = starts[0];
  const runStop = stops[0];
  const health = healthRows[0];
  const runId = runStart.research_run_id;
  const platform = runStart.platform;
  if (typeof runId !== 'string' || !runId || !['web', 'mobile'].includes(platform)
    || rows.some((row) => row.research_run_id !== runId || row.platform !== platform)) {
    return fail('INCOMPLETE_LOG', 'Mixed or missing research_run_id/platform');
  }
  output.research_run_id = runId;
  output.platform = platform;
  output.dropped_events = health.dropped_events;
  if (Number.isSafeInteger(health.dropped_events) && health.dropped_events > 0) {
    return fail('DROPPED_EVENTS', 'Logger dropped one or more events');
  }
  if (rows[0] !== runStart || rows.at(-1) !== health || rows.indexOf(runStop) <= 0
    || !Number.isSafeInteger(runStart.event_seq) || !Number.isSafeInteger(runStop.event_seq)
    || !Number.isSafeInteger(health.event_seq)
    || rows.some((row, index) => !Number.isSafeInteger(row.event_seq)
      || !finiteNumber(row.monotonic_us)
      || (index > 0 && row.event_seq !== rows[index - 1].event_seq + 1))) {
    return fail('INCOMPLETE_LOG', 'Run boundary/order/event_seq is incomplete');
  }
  if (!finiteNumber(runStart.monotonic_us) || !finiteNumber(runStop.monotonic_us)
    || runStop.monotonic_us <= runStart.monotonic_us
    || !Number.isSafeInteger(health.dropped_events)
    || !Number.isSafeInteger(health.attempted_events)
    || !Number.isSafeInteger(health.stored_events)
    || health.stored_events !== rows.length - 1
    || health.attempted_events !== health.stored_events + health.dropped_events
    || health.export_format !== 'jsonl' || health.export_requested !== true) {
    return fail('INCOMPLETE_LOG', 'Invalid run times or logger_health counters/export evidence');
  }
  output.dropped_events = health.dropped_events;

  const walkStarts = rows.filter((row) => row.event === 'walking_window_start');
  const walkStops = rows.filter((row) => row.event === 'walking_window_stop');
  if (walkStarts.length === 0 && walkStops.length === 0) {
    return fail('NO_WALKING_WINDOW', 'No explicit walking window');
  }
  if (walkStarts.length !== 1 || walkStops.length !== 1) {
    return fail('PROTOCOL_ERROR', 'Walking window requires one start and one stop');
  }
  const walkStart = walkStarts[0];
  const walkStop = walkStops[0];
  if (typeof walkStart.walking_window_id !== 'string' || !walkStart.walking_window_id
    || walkStart.walking_window_id !== walkStop.walking_window_id
    || walkStart.annotation_source !== 'manual_operator'
    || walkStop.annotation_source !== 'manual_operator'
    || !finiteNumber(walkStart.monotonic_us) || !finiteNumber(walkStop.monotonic_us)
    || walkStart.monotonic_us < runStart.monotonic_us
    || walkStop.monotonic_us > runStop.monotonic_us
    || walkStop.monotonic_us <= walkStart.monotonic_us
    || walkStop.event_seq <= walkStart.event_seq) {
    return fail('PROTOCOL_ERROR', 'Invalid walking window ID, time, order or annotation source');
  }
  output.walking_window_id = walkStart.walking_window_id;
  output.walking_window_start_us = walkStart.monotonic_us;
  output.walking_window_stop_us = walkStop.monotonic_us;
  output.walking_window_duration_ms = (walkStop.monotonic_us - walkStart.monotonic_us) / 1000;
  const inWindow = (row) => finiteNumber(row.monotonic_us)
    && row.monotonic_us >= walkStart.monotonic_us
    && row.monotonic_us <= walkStop.monotonic_us;
  const windowRows = rows.filter(inWindow);
  const raw = windowRows.filter((row) => row.event === 'raw_location_received');
  const valid = raw.filter(validCoordinate);
  output.raw_callback_count = raw.length;
  output.valid_callback_count = valid.length;
  output.invalid_callback_count = raw.length - valid.length;
  const errors = rows.filter((row) => row.event === 'raw_location_error');
  output.location_error_count = errors.length;
  output.location_error_types = [...new Set(errors.map(errorLabel))].sort();
  output.lifecycle_event_count = windowRows.filter((row) => row.event.startsWith('lifecycle_')
    || row.event === 'navigation_screen_disposed'
    || (row.event === 'location_subscription_state' && row.state === 'stopped')).length;

  // Fatal preflight failures can precede walking start; retain them for validation.
  const relevantErrors = rows.filter((row) => row.event === 'raw_location_error'
    && finiteNumber(row.monotonic_us)
    && row.monotonic_us >= runStart.monotonic_us && row.monotonic_us <= walkStop.monotonic_us);
  if (windowRows.some(lifecycleInterrupted)) {
    return fail('LIFECYCLE_INTERRUPTED', 'Foreground/screen/subscription lifecycle interrupted walking');
  }
  if (relevantErrors.some((row) => isFatalError(row, rows, walkStop.monotonic_us))) {
    return fail('LOCATION_STREAM_ERROR', 'Fatal or unrecovered location error');
  }
  if (valid.some((row) => !Number.isSafeInteger(row.event_seq)
    || !Number.isSafeInteger(row.location_sample_id)
    || row.location_sample_id !== row.event_seq)) {
    return fail('INCOMPLETE_LOG', 'Valid callback missing location_sample_id/event_seq');
  }
  for (let index = 1; index < valid.length; index += 1) {
    if (!finiteNumber(valid[index].monotonic_us)
      || valid[index].monotonic_us <= valid[index - 1].monotonic_us) {
      return fail('NON_MONOTONIC_TIMESTAMP', 'Valid callback receipt timestamps do not increase in event order');
    }
  }
  if (valid.length < 2) return fail('INSUFFICIENT_CALLBACKS', 'Fewer than two valid callbacks inside walking window');

  output.intervals = valid.slice(1).map((row, index) => {
    const previous = valid[index];
    return {
      previous_location_sample_id: previous.location_sample_id,
      current_location_sample_id: row.location_sample_id,
      previous_monotonic_us: previous.monotonic_us,
      current_monotonic_us: row.monotonic_us,
      interval_ms: (row.monotonic_us - previous.monotonic_us) / 1000,
    };
  });
  const sorted = output.intervals.map((row) => row.interval_ms).sort((a, b) => a - b);
  output.interval_count = sorted.length;
  output.median_interval_ms = median(sorted);
  output.p95_interval_ms = sorted[Math.ceil(0.95 * sorted.length) - 1];
  output.min_interval_ms = sorted[0];
  output.max_interval_ms = sorted.at(-1);
  output.status = 'OK';
  output.diagnostic_reason = null;
  return output;
}

export function parseJsonl(input) {
  return input.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function main(args) {
  let inputPath;
  let intervalsPath;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--input') inputPath = args[index + 1];
    else if (args[index] === '--intervals-output') intervalsPath = args[index + 1];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!inputPath) throw new Error('Usage: node scripts/analyze-m4.mjs --input run.jsonl [--intervals-output intervals.json]');
  let result;
  try {
    result = analyzeM4(parseJsonl(readFileSync(inputPath, 'utf8')));
  } catch (error) {
    result = analyzeM4([]);
    result.diagnostic_reason = `Cannot parse JSONL: ${error.message}`;
  }
  const { intervals, ...summary } = result;
  if (intervalsPath) writeFileSync(intervalsPath, `${JSON.stringify(intervals, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'OK') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
