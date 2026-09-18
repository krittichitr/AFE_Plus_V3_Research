import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { BackendResearchEvent, UpdateResponse } from '@/lib/navigation/types';

export type BackendRequestKind = 'init' | 'update';

type BackendResearchContext = {
  researchRunId: string;
  routeUpdateId: string;
  targetSampleId: string | null;
  targetRefLat: number;
  targetRefLng: number;
  requestKind: BackendRequestKind;
  requestPhase: RouteProvenanceRequestPhase | null;
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
): Omit<BackendResearchContext, 'events' | 'physicalAttemptCount' | 'm1Candidate'> | null {
  if (!isRecord(body) || !isRecord(body.routeProvenance)) return null;
  const provenance = body.routeProvenance;
  if (
    typeof provenance.research_run_id !== 'string' || provenance.research_run_id.length === 0 ||
    typeof provenance.route_update_id !== 'string' || provenance.route_update_id.length === 0 ||
    !(typeof provenance.target_sample_id === 'string' || provenance.target_sample_id === null) ||
    typeof provenance.target_ref_lat !== 'number' || !Number.isFinite(provenance.target_ref_lat) ||
    typeof provenance.target_ref_lng !== 'number' || !Number.isFinite(provenance.target_ref_lng)
  ) return null;

  return {
    researchRunId: provenance.research_run_id,
    routeUpdateId: provenance.route_update_id,
    targetSampleId: provenance.target_sample_id,
    targetRefLat: provenance.target_ref_lat,
    targetRefLng: provenance.target_ref_lng,
    requestKind,
    requestPhase:
      provenance.research_request_phase === 'init' ||
      provenance.research_request_phase === 'restore' ||
      provenance.research_request_phase === 'incremental'
        ? provenance.research_request_phase
        : null,
  };
}

export function withBackendResearchContext<T>(
  seed: Omit<BackendResearchContext, 'events' | 'physicalAttemptCount' | 'm1Candidate'> | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (!seed) return operation();
  return storage.run({
    ...seed,
    events: [],
    physicalAttemptCount: 0,
    m1Candidate: null,
  }, operation);
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

export function recordMapboxHttpAttempt(component: string): void {
  const context = storage.getStore();
  if (!context) return;
  try {
    context.physicalAttemptCount += 1;
    context.events.push({
      ...baseEvent(context, 'mapbox_http_attempt'),
      physical_request_id: randomUUID(),
      request_kind: context.requestKind,
      component,
    });
  } catch {
    // Research instrumentation must not affect the physical request.
  }
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
