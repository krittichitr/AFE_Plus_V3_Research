import type { RouteProvenance } from '@/lib/navigation/types';
import {
  appendResearchProvenanceEventAt,
  getRecordingResearchRunId,
} from './provenanceEvents';

type PendingM1 = {
  researchRunId: string;
  sessionId: string;
  routeUpdateId: string;
  targetSampleId: string | null;
  startMonoMs: number;
  awaitingActivation: boolean;
  held: boolean;
};

const pending = new Map<string, PendingM1>();

function details(item: PendingM1, updateType: string) {
  return {
    source: 'frontend',
    session_id: item.sessionId,
    route_update_id: item.routeUpdateId,
    update_type: updateType,
    target_sample_id: item.targetSampleId,
    clock_domain: 'browser_performance',
  };
}

export function startM1FrontendUpdate(sessionId: string, provenance: RouteProvenance): void {
  const researchRunId = getRecordingResearchRunId();
  if (!researchRunId) return;
  for (const item of Array.from(pending.values())) {
    if (item.sessionId === sessionId) closeM1FrontendUpdate(item.routeUpdateId, item.held ? 'presentation_held' : 'superseded');
  }
  const item: PendingM1 = {
    researchRunId, sessionId, routeUpdateId: provenance.route_update_id,
    targetSampleId: provenance.target_sample_id, startMonoMs: performance.now(),
    awaitingActivation: false, held: false,
  };
  if (appendResearchProvenanceEventAt({ event: 'm1_frontend_start', ...details(item, 'incremental') }, item.startMonoMs)) {
    pending.set(item.routeUpdateId, item);
  }
}

export function closeM1FrontendUpdate(routeUpdateId: string, failureReason: string, updateType = 'incremental'): void {
  const item = pending.get(routeUpdateId);
  if (!item) return;
  pending.delete(routeUpdateId);
  const endMonoMs = performance.now();
  appendResearchProvenanceEventAt({
    event: 'm1_frontend_outcome', ...details(item, updateType),
    m1_eligible: false, success: false, failure_reason: failureReason,
  }, endMonoMs);
}

export function acceptM1FrontendCandidate(routeUpdateId: string): void {
  const item = pending.get(routeUpdateId);
  if (item) item.awaitingActivation = true;
}

export function holdM1FrontendCandidate(routeUpdateId: string): void {
  const item = pending.get(routeUpdateId);
  if (item) item.held = true;
}

export function finishM1FrontendAtActivation(provenance: RouteProvenance, sessionId: string | null, routeVersion: number): void {
  const item = pending.get(provenance.route_update_id);
  if (!item || !item.awaitingActivation || item.researchRunId !== provenance.research_run_id
    || item.sessionId !== sessionId || provenance.research_request_phase !== 'incremental') return;
  pending.delete(item.routeUpdateId);
  const endMonoMs = performance.now();
  appendResearchProvenanceEventAt({
    event: 'm1_frontend_end', ...details(item, 'incremental'),
    m1_eligible: true, success: true, route_version: routeVersion,
    duration_ms: Math.max(0, endMonoMs - item.startMonoMs),
  }, endMonoMs);
}

export function closePendingM1Frontend(reason: string): void {
  for (const item of Array.from(pending.values())) {
    closeM1FrontendUpdate(item.routeUpdateId, item.held ? 'presentation_held' : reason);
  }
}
