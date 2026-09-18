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
  system_version: 'V3';
  wall_clock_utc: string;
  wall_clock_ms: number;
  mono_ms: number;
  [key: string]: unknown;
};

export type ResearchLoggerSnapshot = {
  status: ResearchLoggerStatus;
  researchRunId: string | null;
  eventCount: number;
  droppedEvents: number;
  clockStatus: ResearchClockStatus;
  hasData: boolean;
  exported: boolean;
};

const MAX_EVENTS = 100_000;
const ORDINARY_EVENT_LIMIT = MAX_EVENTS - 1;
const listeners = new Set<() => void>();

let events: ResearchEvent[] = [];
let status: ResearchLoggerStatus = 'IDLE';
let researchRunId: string | null = null;
let eventSeq = 0;
let droppedEvents = 0;
let clockStatus: ResearchClockStatus = 'NOT_SYNCED';
let exported = false;
let runGeneration = 0;

let snapshot: ResearchLoggerSnapshot = createSnapshot();

function createSnapshot(): ResearchLoggerSnapshot {
  return {
    status,
    researchRunId,
    eventCount: events.length,
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

function nowFields(): Pick<ResearchEvent, 'wall_clock_utc' | 'wall_clock_ms' | 'mono_ms'> {
  const wallClockMs = Date.now();
  return {
    wall_clock_utc: new Date(wallClockMs).toISOString(),
    wall_clock_ms: wallClockMs,
    mono_ms: performance.now(),
  };
}

function appendForRun(
  input: ResearchEventInput,
  expectedRunId: string,
  options: { allowStopped?: boolean; control?: boolean } = {},
): boolean {
  const acceptsState = status === 'RECORDING' || (options.allowStopped === true && status === 'STOPPED' && !exported);
  if (!acceptsState || researchRunId !== expectedRunId) return false;

  const limit = options.control ? MAX_EVENTS : ORDINARY_EVENT_LIMIT;
  if (events.length >= limit) {
    droppedEvents += 1;
    publish();
    return false;
  }

  const { event, ...details } = input;
  eventSeq += 1;
  events.push(Object.freeze({
    event,
    ...details,
    event_seq: eventSeq,
    research_run_id: expectedRunId,
    system_version: 'V3',
    ...nowFields(),
  }));
  publish();
  return true;
}

function defaultRunId(): string {
  return `V3-${new Date().toISOString().replace(/[-:.]/g, '')}`;
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
  droppedEvents = 0;
  clockStatus = 'NOT_SYNCED';
  exported = false;
  status = 'RECORDING';
  runGeneration += 1;
  const generation = runGeneration;

  appendForRun({ event: 'run_start' }, researchRunId, { control: true });
  void recordClockSync(researchRunId, generation);
  return researchRunId;
}

export function stopResearchRun(): void {
  if (status !== 'RECORDING' || !researchRunId) return;
  appendForRun({ event: 'run_stop' }, researchRunId, { control: true });
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
  droppedEvents = 0;
  clockStatus = 'NOT_SYNCED';
  exported = false;
  publish();
}

export function appendResearchProvenanceEvent(input: ResearchEventInput): boolean {
  if (status !== 'RECORDING' || !researchRunId) return false;
  return appendForRun(input, researchRunId);
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
      ...details
    } = record;
    if (appendForRun({ event, ...details }, expectedRunId, { allowStopped: true })) appended += 1;
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

export function exportResearchLog(): void {
  if (!researchRunId || events.length === 0) return;
  const health: ResearchEvent = {
    event: 'logger_health',
    event_seq: eventSeq + 1,
    research_run_id: researchRunId,
    system_version: 'V3',
    ...nowFields(),
    total_events: events.length,
    dropped_events: droppedEvents,
  };
  const jsonl = `${[...events, health].map((event) => JSON.stringify(event)).join('\n')}\n`;
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
