import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { BackendResearchEvent, UpdateResponse } from '@/lib/navigation/types';
import { journalM2Attempt, markM2RunInvalid, type M2Attempt } from './m2Journal';
import type { NextApiResponse } from 'next';

export type BackendRequestKind = 'init' | 'update';

type BackendResearchContext = {
  researchRunId: string;
  routeUpdateId: string;
  targetSampleId: string | null;
  targetRefLat: number;
  targetRefLng: number;
  requestKind: BackendRequestKind;
  requestPhase: RouteProvenanceRequestPhase | null;
  sessionId: string | null;
  m2ResearchMode: boolean;
  m2RunToken: string | null;
  m2InstrumentationError: string | null;
  m2AttemptIndexes: Map<string, number>;
  m2Writes: Promise<unknown>[];
  events: BackendResearchEvent[];
  physicalAttemptCount: number;
  m1Candidate: null | {
    physicalAttemptCountAtStart: number;
    provisionalEnd: null | {
      server_wall_clock_ms: number;
      backend_mono_ms: number;
    };
    terminalEventIndex: number | null;
  };
};

const storage = new AsyncLocalStorage<BackendResearchContext>();

type RouteProvenanceRequestPhase = 'init' | 'restore' | 'incremental';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function researchContextFromRequestBody(
  body: unknown,
  requestKind: BackendRequestKind,
): Omit<BackendResearchContext, 'events' | 'physicalAttemptCount' | 'm1Candidate' | 'm2AttemptIndexes' | 'm2Writes' | 'm2InstrumentationError'> | null {
  if (!isRecord(body) || !isRecord(body.routeProvenance)) return null;
  const provenance = body.routeProvenance;
  if (
    typeof provenance.research_run_id !== 'string' || provenance.research_run_id.length === 0 ||
    typeof provenance.route_update_id !== 'string' || provenance.route_update_id.length === 0 ||
    !(typeof provenance.target_sample_id === 'string' || provenance.target_sample_id === null) ||
    typeof provenance.target_ref_lat !== 'number' || !Number.isFinite(provenance.target_ref_lat) ||
    typeof provenance.target_ref_lng !== 'number' || !Number.isFinite(provenance.target_ref_lng)
  ) return null;
  if (provenance.m2_research_mode === true &&
      (typeof provenance.m2_run_token !== 'string' || provenance.m2_run_token.length === 0)) return null;

  return {
    researchRunId: provenance.research_run_id,
    routeUpdateId: provenance.route_update_id,
    targetSampleId: provenance.target_sample_id,
    targetRefLat: provenance.target_ref_lat,
    targetRefLng: provenance.target_ref_lng,
    requestKind,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    m2ResearchMode: provenance.m2_research_mode === true,
    m2RunToken: typeof provenance.m2_run_token === 'string' ? provenance.m2_run_token : null,
    requestPhase:
      provenance.research_request_phase === 'init' ||
      provenance.research_request_phase === 'restore' ||
      provenance.research_request_phase === 'incremental'
        ? provenance.research_request_phase
        : null,
  };
}

export function withBackendResearchContext<T>(
  seed: Omit<BackendResearchContext, 'events' | 'physicalAttemptCount' | 'm1Candidate' | 'm2AttemptIndexes' | 'm2Writes' | 'm2InstrumentationError'> | null,
  operation: () => Promise<T>,
  response?: NextApiResponse,
): Promise<T> {
  if (!seed) return operation();
  const context: BackendResearchContext = {
    ...seed,
    events: [],
    physicalAttemptCount: 0,
    m2AttemptIndexes: new Map(),
    m2Writes: [],
    m2InstrumentationError: null,
    m1Candidate: null,
  };
  return storage.run(context, async () => {
    let responseSend: Promise<unknown> | null = null;
    if (response) {
      const originalJson = response.json.bind(response);
      response.json = ((body: unknown) => {
        const send = () => originalJson(context.m2InstrumentationError && body && typeof body === 'object'
          ? { ...body, m2_instrumentation_error: context.m2InstrumentationError } : body);
        if (context.m2Writes.length === 0) return send();
        // Await research writes only after routing/retry work is finished.
        responseSend = Promise.allSettled(context.m2Writes).then(send);
        return response;
      }) as typeof response.json;
    }
    const result = await operation();
    if (responseSend) await responseSend;
    return result;
  });
}

export function trackM2JournalWrite(write: Promise<unknown>): void {
  storage.getStore()?.m2Writes.push(write);
}

export function isM2ResearchRequest(): boolean { return storage.getStore()?.m2ResearchMode === true; }

export function markM2InstrumentationFailure(reason: string): void {
  const context = storage.getStore();
  if (!context?.m2ResearchMode) return;
  context.m2InstrumentationError = reason;
  trackM2JournalWrite(markM2RunInvalid(context.researchRunId, reason).catch(() => {}));
}

function baseEvent(context: BackendResearchContext, event: BackendResearchEvent['event']): BackendResearchEvent {
  return {
    event,
    research_run_id: context.researchRunId,
    route_update_id: context.routeUpdateId,
    target_sample_id: context.targetSampleId,
    target_ref_lat: context.targetRefLat,
    target_ref_lng: context.targetRefLng,
    source: 'backend',
    server_wall_clock_ms: Date.now(),
    backend_mono_ms: performance.now(),
  };
}

export function getBackendResearchEvents(): BackendResearchEvent[] {
  return storage.getStore()?.events.slice() ?? [];
}

export function recordMapboxHttpAttempt(component: string, physicalRequestId: string = randomUUID()): void {
  const context = storage.getStore();
  if (!context) return;
  try {
    context.physicalAttemptCount += 1;
    context.events.push({
      ...baseEvent(context, 'mapbox_http_attempt'),
      physical_request_id: physicalRequestId,
      request_kind: context.requestKind,
      component,
    });
  } catch {
    // Research instrumentation must not affect the physical request.
  }
}

export function beginM2MapboxAttempt(
  component: string,
  purpose: M2Attempt['request_purpose'],
  rayDirection: string | null = null,
): M2Attempt | null {
  const context = storage.getStore();
  if (!context) return null;
  try {
  const mapboxAttemptId = randomUUID();
  const indexKey = `${purpose}:${rayDirection ?? ''}`;
  const attemptIndex = (context.m2AttemptIndexes.get(indexKey) ?? 0) + 1;
  context.m2AttemptIndexes.set(indexKey, attemptIndex);
  // In research mode, record the physical request only after its durable acknowledgement.
  if (!context.m2ResearchMode) recordMapboxHttpAttempt(component, mapboxAttemptId);
  if (!context.m2ResearchMode) return null;
  return {
    event: 'm2_mapbox_attempt',
    research_run_id: context.researchRunId,
    m2_run_token: context.m2RunToken ?? '',
    session_id: context.sessionId,
    route_update_id: context.routeUpdateId,
    target_sample_id: context.targetSampleId,
    mapbox_attempt_id: mapboxAttemptId,
    request_phase: context.requestKind === 'init' ? 'initial' : 'navigation',
    operation: context.requestKind === 'init' ? 'initial_graph' : 'graph_refetch',
    request_purpose: purpose,
    ray_direction: rayDirection,
    attempt_index: attemptIndex,
    dispatch_wall_clock_ms: Date.now(),
    dispatch_mono_ms: performance.now(),
    clock_domain: 'server_performance',
  };
  } catch {
    return null;
  }
}

export class M2InstrumentationError extends Error {
  constructor() { super('M2_DURABLE_ATTEMPT_ACK_FAILED'); this.name = 'M2InstrumentationError'; }
}

export async function acknowledgeM2MapboxFetch(
  component: string,
  purpose: M2Attempt['request_purpose'],
  rayDirection: string | null = null,
): Promise<M2Attempt | null> {
  const researchMode = isM2ResearchRequest();
  const attempt = beginM2MapboxAttempt(component, purpose, rayDirection);
  if (!researchMode) return null;
  if (!attempt || !attempt.m2_run_token || !await journalM2Attempt(attempt)) {
    markM2InstrumentationFailure('M2_DURABLE_ATTEMPT_ACK_FAILED');
    throw new M2InstrumentationError();
  }
  recordMapboxHttpAttempt(component, attempt.mapbox_attempt_id);
  return attempt;
}

export function startBackendM1Candidate(): void {
  const context = storage.getStore();
  if (
    !context ||
    context.requestKind !== 'update' ||
    context.requestPhase !== 'incremental' ||
    context.m1Candidate
  ) return;
  try {
    context.m1Candidate = {
      physicalAttemptCountAtStart: context.physicalAttemptCount,
      provisionalEnd: null,
      terminalEventIndex: null,
    };
    context.events.push(baseEvent(context, 'route_update_start'));
  } catch {
    context.m1Candidate = null;
  }
}

export function finishBackendM1Candidate(input: {
  m1_eligible: boolean;
  success: boolean;
  usable_route: boolean;
  outcome: string;
}): void {
  const context = storage.getStore();
  const candidate = context?.m1Candidate;
  if (!context || !candidate) return;
  try {
    const terminalEvent: BackendResearchEvent = {
      ...baseEvent(context, 'route_update_end'),
      ...(candidate.provisionalEnd ?? {}),
      ...input,
    };
    if (candidate.terminalEventIndex === null) {
      const terminalEventIndex = context.events.length;
      context.events.push(terminalEvent);
      candidate.terminalEventIndex = terminalEventIndex;
      return;
    }

    const existing = context.events[candidate.terminalEventIndex];
    if (existing?.success === true && input.success === false) {
      context.events[candidate.terminalEventIndex] = terminalEvent;
    }
  } catch {
    // Research instrumentation must never alter the request outcome.
  }
}

export function markBackendM1CandidateReady(): void {
  const context = storage.getStore();
  const candidate = context?.m1Candidate;
  if (!candidate || candidate.provisionalEnd || candidate.terminalEventIndex !== null) return;
  candidate.provisionalEnd = {
    server_wall_clock_ms: Date.now(),
    backend_mono_ms: performance.now(),
  };
}

export function finishBackendM1CandidateFromResponse(
  body: Pick<UpdateResponse, 'success' | 'status' | 'refetchReason' | 'path'>,
): void {
  const context = storage.getStore();
  const candidate = context?.m1Candidate;
  if (!context || !candidate) return;
  const mapboxAttempted = context.physicalAttemptCount > candidate.physicalAttemptCountAtStart;
  const successfulUsableIncremental =
    candidate.provisionalEnd !== null &&
    !mapboxAttempted &&
    body.success === true &&
    body.status === 'OK' &&
    Array.isArray(body.path) &&
    body.path.length >= 2;

  finishBackendM1Candidate({
    m1_eligible: successfulUsableIncremental,
    success: successfulUsableIncremental,
    usable_route: successfulUsableIncremental,
    outcome: successfulUsableIncremental
      ? 'incremental_route_ready'
      : mapboxAttempted
        ? 'ineligible_mapbox_refetch'
        : `ineligible_${body.refetchReason ?? body.status.toLowerCase()}`,
  });
}
