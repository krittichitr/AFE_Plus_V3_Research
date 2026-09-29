#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function validateM2Journal(journal, manifest = null, senderTrace = null) {
  const errors = [];
  const attempts = Array.isArray(journal?.attempts) ? journal.attempts : [];
  const outcomes = Array.isArray(journal?.outcomes) ? journal.outcomes : [];
  const ids = new Set();
  const runId = journal?.research_run_id;
  if (typeof runId !== 'string' || !runId) errors.push('missing_research_run_id');
  if (journal?.complete_for_m2 !== true || journal?.integrity_status !== 'COMPLETE') errors.push('journal_incomplete');
  if (!Array.isArray(journal?.journal_errors) || journal.journal_errors.length) errors.push('journal_store_errors');
  for (const attempt of attempts) {
    if (attempt?.event !== 'm2_mapbox_attempt') errors.push('invalid_attempt_event');
    if (typeof attempt?.mapbox_attempt_id !== 'string' || !attempt.mapbox_attempt_id) errors.push('missing_attempt_id');
    if (ids.has(attempt?.mapbox_attempt_id)) errors.push(`duplicate_attempt_id:${attempt.mapbox_attempt_id}`);
    ids.add(attempt?.mapbox_attempt_id);
    if (attempt?.research_run_id !== runId) errors.push(`wrong_run:${attempt?.mapbox_attempt_id}`);
    if (!Number.isFinite(attempt?.dispatch_wall_clock_ms) || !Number.isFinite(attempt?.dispatch_mono_ms)) errors.push(`missing_dispatch_time:${attempt?.mapbox_attempt_id}`);
    if (!['initial', 'navigation'].includes(attempt?.request_phase)) errors.push(`invalid_phase:${attempt?.mapbox_attempt_id}`);
    if (!['initial_graph', 'graph_refetch', 'initial_route', 'route_update'].includes(attempt?.operation)) errors.push(`invalid_operation:${attempt?.mapbox_attempt_id}`);
    if (!Number.isInteger(attempt?.attempt_index) || attempt.attempt_index < 1) errors.push(`invalid_attempt_index:${attempt?.mapbox_attempt_id}`);
  }
  const outcomeIds = new Set();
  for (const outcome of outcomes) {
    if (!ids.has(outcome?.mapbox_attempt_id)) errors.push(`orphan_outcome:${outcome?.mapbox_attempt_id}`);
    if (outcomeIds.has(outcome?.mapbox_attempt_id)) errors.push(`duplicate_outcome:${outcome?.mapbox_attempt_id}`);
    outcomeIds.add(outcome?.mapbox_attempt_id);
  }
  for (const id of ids) if (!outcomeIds.has(id)) errors.push(`outcome_missing:${id}`);
  const initial = attempts.filter((item) => item.request_phase === 'initial').length;
  const additional = attempts.filter((item) => item.request_phase === 'navigation').length;
  const total = attempts.length;
  if (total !== initial + additional) errors.push('classification_sum_mismatch');

  let cumulative = null;
  if (manifest && senderTrace) {
    const checkpoints = [0, 50, 100, 150, 200, 300, 500];
    const samples = senderTrace.filter((item) => item?.event === 'target_sample' && item.sender_session_id === manifest.sender_session_id);
    if (manifest.research_run_id !== runId || !manifest.sender_session_id || !Number.isFinite(manifest.initial_route_accepted_wall_clock_ms)) {
      errors.push('invalid_manifest');
    } else if (!Number.isFinite(manifest.sender_to_dispatch_clock_offset_ms)) {
      errors.push('missing_clock_offset');
    } else {
      cumulative = {};
      for (const distance of checkpoints) {
        const checkpointTime = distance === 0
          ? manifest.initial_route_accepted_wall_clock_ms
          : samples.find((item) => item.cumulative_distance_m >= distance)?.source_timestamp_ms;
        if (!Number.isFinite(checkpointTime)) { errors.push(`missing_checkpoint:${distance}`); continue; }
        // Offset converts sender wall-clock time into the journal's dispatch clock.
        const adjustedTime = checkpointTime + (distance === 0 ? 0 : manifest.sender_to_dispatch_clock_offset_ms);
        cumulative[distance] = attempts.filter((item) => item.dispatch_wall_clock_ms <= adjustedTime).length;
      }
    }
  }
  return { valid: errors.length === 0, errors, research_run_id: runId ?? null, initial, additional, total, cumulative };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , journalPath, manifestPath, senderPath] = process.argv;
  if (!journalPath) {
    console.error('Usage: node scripts/validate-m2-journal.mjs JOURNAL.json [MANIFEST.json SENDER.jsonl]');
    process.exit(2);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const sender = senderPath ? readFileSync(senderPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : null;
  const result = validateM2Journal(journal, manifest, sender);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
