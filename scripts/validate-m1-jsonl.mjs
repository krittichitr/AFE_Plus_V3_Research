#!/usr/bin/env node
// Validate exported V2/V3 research JSONL without changing navigation data.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/validate-m1-jsonl.mjs <V2-or-V3.jsonl> [...]');
  process.exit(2);
}

const allowedTypes = new Set(['initial', 'normal', 'style_reload', 'restore', 'incremental', 'graph_refetch', 'fallback', 'blocked']);
const errors = [];
const groups = new Map();
const active = new Set();
const summaries = new Map();

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let event;
    try { event = JSON.parse(line); } catch { errors.push(`${file}:${index + 1}: invalid JSON`); continue; }
    if (event.event === 'logger_health' && typeof event.dropped_events === 'number' && event.dropped_events > 0) {
      errors.push(`${file}:${index + 1}: logger dropped ${event.dropped_events} events`);
    }
    if (!['m1_frontend_start', 'm1_frontend_end', 'm1_frontend_outcome', 'route_active'].includes(event.event)) continue;
    if (event.event === 'route_active' && !event.session_id) continue; // older logs are outside this contract
    const { research_run_id: runId, session_id: sessionId, route_update_id: updateId } = event;
    if (![runId, sessionId, updateId].every((value) => typeof value === 'string' && value.length > 0)) {
      errors.push(`${file}:${index + 1}: missing run/session/update ID`);
      continue;
    }
    const key = JSON.stringify([runId, sessionId, updateId]);
    if (event.event === 'route_active') { active.add(key); continue; }
    if (!groups.has(key)) groups.set(key, { start: [], terminal: [], file });
    const group = groups.get(key);
    if (event.event === 'm1_frontend_start') group.start.push(event);
    else group.terminal.push(event);
    if (!allowedTypes.has(event.update_type)) errors.push(`${file}:${index + 1}: unknown update_type ${event.update_type}`);
  }
}

for (const [key, group] of groups) {
  if (group.start.length !== 1) errors.push(`${key}: expected one start, found ${group.start.length}`);
  if (group.terminal.length !== 1) errors.push(`${key}: expected one terminal, found ${group.terminal.length}`);
  if (group.start.length !== 1 || group.terminal.length !== 1) continue;
  const start = group.start[0];
  const terminal = group.terminal[0];
  if (start.source !== 'frontend' || terminal.source !== 'frontend'
    || start.clock_domain !== 'browser_performance' || terminal.clock_domain !== 'browser_performance') {
    errors.push(`${key}: invalid source or clock domain`);
  }
  const startMs = start.mono_ms;
  const endMs = terminal.mono_ms;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    errors.push(`${key}: invalid browser monotonic timestamps`);
  }
  if (terminal.event === 'm1_frontend_end') {
    if (!['normal', 'incremental'].includes(terminal.update_type)
      || terminal.update_type !== start.update_type
      || terminal.m1_eligible !== true || terminal.success !== true) {
      errors.push(`${key}: ineligible or mismatched M1 end`);
    }
    if (!active.has(key)) errors.push(`${key}: eligible end has no matching route_active`);
    if (!Number.isFinite(terminal.duration_ms) || terminal.duration_ms < 0
      || Math.abs(terminal.duration_ms - (endMs - startMs)) > 0.001) {
      errors.push(`${key}: duration does not match browser monotonic pair`);
    }
    const summaryKey = JSON.stringify([start.system_version, start.research_run_id]);
    const summary = summaries.get(summaryKey) ?? { count: 0, durationMs: 0 };
    summary.count += 1;
    summary.durationMs += terminal.duration_ms;
    summaries.set(summaryKey, summary);
  } else if (terminal.event === 'm1_frontend_outcome') {
    if (terminal.m1_eligible !== false || terminal.success !== false || !terminal.failure_reason) {
      errors.push(`${key}: outcome is missing exclusion/failure fields`);
    }
  } else {
    errors.push(`${key}: unexpected terminal event ${terminal.event}`);
  }
}

for (const [key, summary] of summaries) {
  const [systemVersion, runId] = JSON.parse(key);
  console.log(`${systemVersion} ${runId}: eligible=${summary.count}, mean_m1_ms=${(summary.durationMs / summary.count).toFixed(3)}`);
}
console.log(`M1 attempts=${groups.size}, errors=${errors.length}`);
for (const error of errors) console.error(error);
process.exit(errors.length === 0 ? 0 : 1);
