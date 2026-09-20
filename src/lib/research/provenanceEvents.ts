import { probeResearchClockSync, type ClockSyncResult } from './clockSync';

export type ResearchLoggerStatus = 'IDLE' | 'RECORDING' | 'STOPPED';
export type ResearchClockStatus = 'NOT_SYNCED' | 'OK' | 'FAILED';

export type ResearchEventInput = {
  event: string;
  [key: string]: unknown;
};

export type ResearchEvent = {
  event: string;
  event_seq: number;
  research_run_id: string;
  platform: 'web';
  system_version: 'V3';
  monotonic_us: number;
  wall_clock_utc?: string;
  wall_clock_ms?: number;
  mono_ms?: number;
  [key: string]: unknown;
};

export type ResearchLoggerSnapshot = {
  status: ResearchLoggerStatus;
  researchRunId: string | null;
  eventCount: number;
  attemptedEvents: number;
  droppedEvents: number;
  clockStatus: ResearchClockStatus;
  hasData: boolean;
  exported: boolean;
};

type AppendOptions = {
  allowStopped?: boolean;
  control?: boolean;
  hot?: boolean;
  capturedPerformanceMs?: number;
  sequenceAlias?: string;
};

const MAX_EVENTS = 100_000;
const CONTROL_EVENT_RESERVE = 2;
const ORDINARY_EVENT_LIMIT = MAX_EVENTS - CONTROL_EVENT_RESERVE;
const WEB_SOURCE_BASELINE = 'research/v3-web-instrumentation@2e5d7738b0387107cde71eb28d8e53964b43408a';
const listeners = new Set<() => void>();

let events: ResearchEvent[] = [];
let status: ResearchLoggerStatus = 'IDLE';
let researchRunId: string | null = null;
let eventSeq = 0;
let attemptedEvents = 0;
let droppedEvents = 0;
let droppedByEvent: Record<string, number> = {};
let firstDroppedEventSeq: number | null = null;
let lastDroppedEventSeq: number | null = null;
let firstDroppedMonotonicUs: number | null = null;
let lastDroppedMonotonicUs: number | null = null;
let highWaterMark = 0;
let clockStatus: ResearchClockStatus = 'NOT_SYNCED';
let exported = false;
let runGeneration = 0;
let runPerformanceOriginMs = 0;
let runWallClockOriginMs = 0;

let snapshot: ResearchLoggerSnapshot = createSnapshot();

function createSnapshot(): ResearchLoggerSnapshot {
  return {
    status,
    researchRunId,
    eventCount: events.length,
    attemptedEvents,
    droppedEvents,
    clockStatus,
    hasData: events.length > 0,
    exported,
  };
}

function publish(): void {
  snapshot = createSnapshot();
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Research UI notification must never affect navigation behavior.
    }
  });
}

function wallClockFields(): Pick<ResearchEvent, 'wall_clock_utc' | 'wall_clock_ms' | 'mono_ms'> {
  const wallClockMs = Date.now();
  return {
    wall_clock_utc: new Date(wallClockMs).toISOString(),
    wall_clock_ms: wallClockMs,
    mono_ms: performance.now(),
  };
}

function toRunMonotonicUs(performanceMs: number): number {
  return Math.max(0, Math.round((performanceMs - runPerformanceOriginMs) * 1000));
}

function appendForRun(
  input: ResearchEventInput,
  expectedRunId: string,
  options: AppendOptions = {},
): number | null {
  const acceptsState = status === 'RECORDING'
    || (options.allowStopped === true && status === 'STOPPED' && !exported);
  if (!acceptsState || researchRunId !== expectedRunId) return null;

  const { event, ...details } = input;
  const capturedPerformanceMs = options.capturedPerformanceMs ?? performance.now();
  const monotonicUs = toRunMonotonicUs(capturedPerformanceMs);
  eventSeq += 1;
  attemptedEvents += 1;
  const nextEventSeq = eventSeq;
  const limit = options.control ? MAX_EVENTS : ORDINARY_EVENT_LIMIT;

  if (events.length >= limit) {
    droppedEvents += 1;
    droppedByEvent[event] = (droppedByEvent[event] ?? 0) + 1;
    firstDroppedEventSeq ??= nextEventSeq;
    firstDroppedMonotonicUs ??= monotonicUs;
    lastDroppedEventSeq = nextEventSeq;
    lastDroppedMonotonicUs = monotonicUs;
    if (!options.hot || droppedEvents % 128 === 0) publish();
    return null;
  }

  const sequenceAlias = options.sequenceAlias
    ? { [options.sequenceAlias]: nextEventSeq }
    : {};
  events.push(Object.freeze({
    event,
    ...details,
    ...sequenceAlias,
    event_seq: nextEventSeq,
    research_run_id: expectedRunId,
    platform: 'web',
    system_version: 'V3',
    monotonic_us: monotonicUs,
    ...(options.hot ? {} : wallClockFields()),
  }));
  highWaterMark = Math.max(highWaterMark, events.length);
  if (!options.hot) publish();
  return nextEventSeq;
}

function defaultRunId(): string {
  return `M45-WEB-${new Date().toISOString().replace(/[-:.]/g, '')}`;
}

function loggerHealthDetails(): Record<string, unknown> {
  return {
    buffer_capacity: MAX_EVENTS,
    control_event_reserve: CONTROL_EVENT_RESERVE,
    attempted_events: attemptedEvents,
    stored_events: events.length,
    dropped_events: droppedEvents,
    dropped_by_event: { ...droppedByEvent },
    first_dropped_event_seq: firstDroppedEventSeq,
    last_dropped_event_seq: lastDroppedEventSeq,
    first_dropped_monotonic_us: firstDroppedMonotonicUs,
    last_dropped_monotonic_us: lastDroppedMonotonicUs,
    high_water_mark: highWaterMark,
  };
}

async function recordClockSync(expectedRunId: string, generation: number): Promise<void> {
  const result = await probeResearchClockSync();
  if (generation !== runGeneration || researchRunId !== expectedRunId) return;

  clockStatus = result.success ? 'OK' : 'FAILED';
  appendForRun({ event: 'clock_sync', ...result }, expectedRunId, { allowStopped: true });
  publish();
}

export function startResearchRun(requestedRunId: string): string | null {
  if (status === 'RECORDING') return researchRunId;

  researchRunId = requestedRunId.trim().slice(0, 200) || defaultRunId();
  events = [];
  eventSeq = 0;
  attemptedEvents = 0;
  droppedEvents = 0;
  droppedByEvent = {};
  firstDroppedEventSeq = null;
  lastDroppedEventSeq = null;
  firstDroppedMonotonicUs = null;
  lastDroppedMonotonicUs = null;
  highWaterMark = 0;
  clockStatus = 'NOT_SYNCED';
  exported = false;
  runPerformanceOriginMs = performance.now();
  runWallClockOriginMs = Date.now();
  status = 'RECORDING';
  runGeneration += 1;
  const generation = runGeneration;

  appendForRun({
    event: 'run_start',
    source_baseline: WEB_SOURCE_BASELINE,
    monotonic_clock: 'performance.now',
    monotonic_unit: 'microseconds',
    run_wall_clock_origin_ms: runWallClockOriginMs,
    run_wall_clock_origin_utc: new Date(runWallClockOriginMs).toISOString(),
    buffer_capacity: MAX_EVENTS,
    visibility_state: typeof document === 'undefined' ? null : document.visibilityState,
    location_subscription_id: 'primary_navigation_watch',
    location_subscription_active_at_run_start: true,
    location_settings: { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 },
  }, researchRunId, { control: true, capturedPerformanceMs: runPerformanceOriginMs });
  void recordClockSync(researchRunId, generation);
  return researchRunId;
}

export function stopResearchRun(): void {
  if (status !== 'RECORDING' || !researchRunId) return;
  appendForRun({ event: 'run_stop', ...loggerHealthDetails() }, researchRunId, { control: true });
  status = 'STOPPED';
  publish();
}

export function clearResearchRun(): void {
  if (status === 'RECORDING') return;
  runGeneration += 1;
  events = [];
  status = 'IDLE';
  researchRunId = null;
  eventSeq = 0;
  attemptedEvents = 0;
  droppedEvents = 0;
  droppedByEvent = {};
  firstDroppedEventSeq = null;
  lastDroppedEventSeq = null;
  firstDroppedMonotonicUs = null;
  lastDroppedMonotonicUs = null;
  highWaterMark = 0;
  clockStatus = 'NOT_SYNCED';
  exported = false;
  runPerformanceOriginMs = 0;
  runWallClockOriginMs = 0;
  publish();
}

export function appendResearchProvenanceEvent(input: ResearchEventInput): boolean {
  if (status !== 'RECORDING' || !researchRunId) return false;
  return appendForRun(input, researchRunId) !== null;
}

/** Hot-path M4/M5 append. Serialization and I/O are deferred until export. */
export function appendResearchObservationAt(
  input: ResearchEventInput,
  capturedPerformanceMs: number,
  sequenceAlias?: string,
): number | null {
  if (status !== 'RECORDING' || !researchRunId) return null;
  return appendForRun(input, researchRunId, {
    hot: true,
    capturedPerformanceMs,
    sequenceAlias,
  });
}

export function appendBackendResearchEvents(rawEvents: unknown, expectedRunId: string | null): number {
  if (!expectedRunId || !Array.isArray(rawEvents)) return 0;
  let appended = 0;

  for (const rawEvent of rawEvents) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const record = rawEvent as Record<string, unknown>;
    if (
      typeof record.event !== 'string' ||
      record.research_run_id !== expectedRunId ||
      record.source !== 'backend' ||
      typeof record.server_wall_clock_ms !== 'number' ||
      typeof record.backend_mono_ms !== 'number'
    ) continue;

    const {
      event,
      research_run_id: _researchRunId,
      event_seq: _eventSeq,
      system_version: _systemVersion,
      wall_clock_utc: _wallClockUtc,
      wall_clock_ms: _wallClockMs,
      mono_ms: _monoMs,
      monotonic_us: _monotonicUs,
      platform: _platform,
      ...details
    } = record;
    if (appendForRun({ event, ...details }, expectedRunId, { allowStopped: true }) !== null) appended += 1;
  }

  return appended;
}

export function getRecordingResearchRunId(): string | null {
  return status === 'RECORDING' ? researchRunId : null;
}

export function getResearchProvenanceEvents(): readonly ResearchEvent[] {
  return events;
}

export function getResearchLoggerSnapshot(): ResearchLoggerSnapshot {
  return snapshot;
}

export function subscribeResearchLogger(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function buildResearchJsonl(): string | null {
  if (!researchRunId || events.length === 0 || status === 'RECORDING') return null;
  const health: ResearchEvent = {
    event: 'logger_health',
    event_seq: eventSeq + 1,
    research_run_id: researchRunId,
    platform: 'web',
    system_version: 'V3',
    monotonic_us: toRunMonotonicUs(performance.now()),
    ...wallClockFields(),
    ...loggerHealthDetails(),
    export_format: 'jsonl',
    export_requested: true,
  };
  return `${[...events, health].map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export function exportResearchLog(): void {
  const jsonl = buildResearchJsonl();
  if (!researchRunId || jsonl === null) return;
  const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${researchRunId}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
  exported = true;
  publish();
}

export type { ClockSyncResult };
