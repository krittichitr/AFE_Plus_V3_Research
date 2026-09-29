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
  m2Status: 'OFF' | 'STARTING' | 'READY' | 'STOPPING' | 'STOPPED' | 'INVALID';
  m2Error: string | null;
  walkingState: 'NOT_STARTED' | 'ACTIVE' | 'COMPLETED';
  walkingWindowId: string | null;
  videoSyncId: string | null;
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
let m2Status: ResearchLoggerSnapshot['m2Status'] = 'OFF';
let m2RunToken: string | null = null;
let m2Error: string | null = null;
let m2StartGeneration = 0;
let runGeneration = 0;
let runPerformanceOriginMs = 0;
let runWallClockOriginMs = 0;
let walkingState: ResearchLoggerSnapshot['walkingState'] = 'NOT_STARTED';
let walkingWindowId: string | null = null;
let videoSyncId: string | null = null;
let videoSyncSequence = 0;

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
    m2Status,
    m2Error,
    walkingState,
    walkingWindowId,
    videoSyncId,
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

function wallClockFields(capturedPerformanceMs = performance.now()): Pick<ResearchEvent, 'wall_clock_utc' | 'wall_clock_ms' | 'mono_ms'> {
  const wallClockMs = Date.now();
  return {
    wall_clock_utc: new Date(wallClockMs).toISOString(),
    wall_clock_ms: wallClockMs,
    mono_ms: capturedPerformanceMs,
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
    ...(options.hot ? {} : wallClockFields(capturedPerformanceMs)),
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

export async function startM2ResearchRun(requestedRunId: string): Promise<string | null> {
  if (status === 'RECORDING' || m2Status === 'STARTING') return null;
  const runId = requestedRunId.trim().slice(0, 200) || defaultRunId();
  const generation = ++m2StartGeneration;
  m2Status = 'STARTING';
  m2Error = null;
  publish();
  try {
    const response = await fetch('/api/research/m2-journal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ research_run_id: runId, boundary: 'start' }),
    });
    const result = await response.json() as { m2_run_token?: unknown; integrity_status?: string };
    if (!response.ok || typeof result.m2_run_token !== 'string' || !result.m2_run_token) {
      throw new Error(result.integrity_status || 'M2_DURABILITY_NOT_AVAILABLE');
    }
    if (generation !== m2StartGeneration) return null;
    m2RunToken = result.m2_run_token;
    const startedId = startResearchRun(runId);
    m2Status = 'READY';
    publish();
    return startedId;
  } catch (error) {
    if (generation !== m2StartGeneration) return null;
    m2Status = 'INVALID';
    m2Error = error instanceof Error ? error.message : 'M2_DURABILITY_NOT_AVAILABLE';
    publish();
    return null;
  }
}

export function getReadyM2ResearchContext(): { researchRunId: string; token: string } | null {
  return status === 'RECORDING' && m2Status === 'READY' && researchRunId && m2RunToken
    ? { researchRunId, token: m2RunToken } : null;
}

export function invalidateM2ResearchRun(reason: string): void {
  if (!m2RunToken || !researchRunId || m2Status === 'INVALID') return;
  m2Status = 'INVALID';
  m2Error = reason;
  appendForRun({ event: 'm2_integrity_error', reason }, researchRunId, { allowStopped: true });
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
  walkingState = 'NOT_STARTED';
  walkingWindowId = null;
  videoSyncId = null;
  videoSyncSequence = 0;
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
  if (m2RunToken) {
    const stoppedRunId = researchRunId;
    const token = m2RunToken;
    const invalid = m2Status === 'INVALID';
    m2Status = 'STOPPING';
    void fetch('/api/research/m2-journal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ research_run_id: stoppedRunId, m2_run_token: token, boundary: 'stop', invalid }),
    }).then((response) => {
      if (!response.ok) throw new Error('M2_STOP_NOT_JOURNALED');
      if (researchRunId === stoppedRunId) m2Status = invalid ? 'INVALID' : 'STOPPED';
    }).catch(() => {
      if (researchRunId === stoppedRunId) {
        m2Status = 'INVALID';
        m2Error = 'M2_STOP_NOT_JOURNALED';
      }
    }).finally(publish);
  }
  status = 'STOPPED';
  walkingState = 'NOT_STARTED';
  walkingWindowId = null;
  videoSyncId = null;
  publish();
}

export function startWalkingWindow(): string | null {
  if (status !== 'RECORDING' || !researchRunId || walkingState !== 'NOT_STARTED') return null;
  const id = crypto.randomUUID();
  const recorded = appendForRun({
    event: 'walking_window_start',
    walking_window_id: id,
    annotation_source: 'manual_operator',
  }, researchRunId, { capturedPerformanceMs: performance.now() });
  if (recorded === null) return null;
  walkingWindowId = id;
  walkingState = 'ACTIVE';
  publish();
  return id;
}

export function markVideoSync(): string | null {
  if (status !== 'RECORDING' || !researchRunId) return null;
  const syncId = crypto.randomUUID();
  const nextSequence = videoSyncSequence + 1;
  const recorded = appendForRun({
    event: 'video_sync_marker',
    sync_id: syncId,
    sync_sequence: nextSequence,
    walking_window_id: walkingWindowId,
  }, researchRunId, { capturedPerformanceMs: performance.now() });
  if (recorded === null) return null;
  videoSyncSequence = nextSequence;
  videoSyncId = syncId;
  publish();
  return syncId;
}

export function stopWalkingWindow(): boolean {
  if (status !== 'RECORDING' || !researchRunId || walkingState !== 'ACTIVE' || !walkingWindowId) return false;
  const recorded = appendForRun({
    event: 'walking_window_stop',
    walking_window_id: walkingWindowId,
    annotation_source: 'manual_operator',
  }, researchRunId, { capturedPerformanceMs: performance.now() });
  if (recorded === null) return false;
  walkingState = 'COMPLETED';
  publish();
  return true;
}

export function clearResearchRun(): void {
  if (status === 'RECORDING') return;
  runGeneration += 1;
  m2StartGeneration += 1;
  m2Status = 'OFF';
  m2RunToken = null;
  m2Error = null;
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
  walkingState = 'NOT_STARTED';
  walkingWindowId = null;
  videoSyncId = null;
  videoSyncSequence = 0;
  runPerformanceOriginMs = 0;
  runWallClockOriginMs = 0;
  publish();
}

export function appendResearchProvenanceEvent(input: ResearchEventInput): boolean {
  if (status !== 'RECORDING' || !researchRunId) return false;
  return appendForRun(input, researchRunId) !== null;
}

export function appendResearchProvenanceEventAt(input: ResearchEventInput, capturedPerformanceMs: number): boolean {
  if (status !== 'RECORDING' || !researchRunId) return false;
  return appendForRun(input, researchRunId, { capturedPerformanceMs }) !== null;
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
