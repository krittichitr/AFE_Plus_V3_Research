#!/usr/bin/env node
// Offline-only M3-PROTOCOL-V3. No runtime imports, writes, grids or criteria.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMeters, isValidLatLng } from './m3-haversine.mjs';

export const PROTOCOL_VERSION = 'M3-PROTOCOL-V3';
const PRIMARY = new Set(['run_start', 'run_stop', 'route_active', 'target_received',
  'm1_frontend_start', 'm1_frontend_end', 'm1_frontend_outcome']);
const M1 = new Set(['m1_frontend_start', 'm1_frontend_end', 'm1_frontend_outcome']);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SAMPLE = new RegExp(`^(${UUID}):T(\\d{6,})$`, 'i');
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const positiveInteger = (v) => Number.isSafeInteger(v) && v > 0;
const point = (e) => ({ lat: e?.target_ref_lat, lng: e?.target_ref_lng });
const key = (e) => JSON.stringify([e.system_version, e.research_run_id, e.session_id, e.route_update_id]);
const unique = (values) => [...new Set(values)];
const countReasons = (rows, field) => {
  const counts = Object.create(null);
  for (const row of rows) for (const reason of unique([].concat(row[field] ?? []))) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
};

export class ConfigurationError extends Error {}

function allowedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError(`${label}: expected object`);
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ConfigurationError(`${label}: unsupported fields ${unknown.join(', ')}`);
}

export function validateManifest(manifest) {
  allowedKeys(manifest, ['schema_version', 'protocol_version', 'system_version', 'navigation', 'sender'], 'manifest');
  if (manifest.schema_version !== 'm3-manifest-v3' || manifest.protocol_version !== PROTOCOL_VERSION) {
    throw new ConfigurationError('Expected m3-manifest-v3 / M3-PROTOCOL-V3; legacy migration is not automatic');
  }
  if (!['V2', 'V3'].includes(manifest.system_version)) throw new ConfigurationError('system_version must be V2 or V3');
  const nav = manifest.navigation;
  allowedKeys(nav, ['file', 'research_run_id', 'session_id', 'sha256'], 'navigation');
  for (const field of ['file', 'research_run_id', 'session_id']) {
    if (!text(nav[field]) || /[<>]/.test(nav[field])) throw new ConfigurationError(`navigation.${field} requires an explicit value`);
  }
  const hash = (v, label) => {
    if (v != null && (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))) throw new ConfigurationError(`${label}: expected lowercase SHA-256 or null`);
  };
  hash(nav.sha256, 'navigation.sha256');
  if (manifest.sender != null) {
    const sender = manifest.sender;
    allowedKeys(sender, ['file', 'sha256', 'intended_current_sender_session_ids'], 'sender');
    if (sender.file != null && (!text(sender.file) || /[<>]/.test(sender.file))) throw new ConfigurationError('sender.file requires an explicit path or null');
    hash(sender.sha256, 'sender.sha256');
    if (sender.sha256 != null && sender.file == null) throw new ConfigurationError('sender.sha256 requires sender.file');
    const ids = sender.intended_current_sender_session_ids;
    if (ids != null && (!Array.isArray(ids) || ids.some((id) => !new RegExp(`^${UUID}$`, 'i').test(id)) || unique(ids).length !== ids.length)) {
      throw new ConfigurationError('sender.intended_current_sender_session_ids requires unique Sender UUIDs');
    }
  }
  return manifest;
}

export function parseSampleId(id) {
  const match = typeof id === 'string' ? SAMPLE.exec(id) : null;
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!positiveInteger(sequence) || String(sequence).padStart(6, '0') !== match[2]) return null;
  return { sender_session_id: match[1], sequence };
}

export function distribution(values) {
  if (!Array.isArray(values) || values.some((v) => !finite(v))) throw new TypeError('Statistics require finite numeric values; no filtering/coercion');
  if (!values.length) return { count: 0, mean: null, median: null, p95: null, max: null, min: null };
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p) => {
    const h = (sorted.length - 1) * p, i = Math.floor(h);
    return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (h - i);
  };
  // Divide first to avoid overflow from summing finite values.
  const mean = sorted.reduce((sum, value) => sum + value / sorted.length, 0);
  if (!finite(mean)) throw new TypeError('Nonfinite statistic');
  return { count: sorted.length, mean, median: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1), min: sorted[0] };
}

export function parseJsonl(raw, label = 'navigation') {
  const events = [], errors = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      events.push(value);
    } catch { errors.push({ code: 'INVALID_JSONL_RECORD', input: label, line: index + 1 }); }
  }
  return { events, errors };
}

function buildTrace(events, issue) {
  if (events == null) return null;
  const samples = new Map(), counts = new Map(), ambiguous = new Set();
  for (const e of events) {
    if (e?.event !== 'target_sample') continue;
    const id = e.target_sample_id, parsed = parseSampleId(id);
    if (!text(id) || !parsed || parsed.sender_session_id !== e.sender_session_id || parsed.sequence !== e.sequence) {
      if (text(id)) ambiguous.add(id);
      issue('TRACE_SAMPLE_IDENTITY_CONTRADICTION', e); continue;
    }
    if (!isValidLatLng({ lat: e.target_lat, lng: e.target_lng })) {
      ambiguous.add(id);
      issue('INVALID_TRACE_COORDINATES', e); continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    const previous = samples.get(id);
    if (previous) {
      // A duplicated attestation cannot choose between different GPS evidence.
      const fields = ['sender_session_id', 'sequence', 'target_lat', 'target_lng', 'accuracy_m', 'speed_mps', 'source_timestamp_ms'];
      if (fields.some((f) => previous[f] !== e[f])) { ambiguous.add(id); issue('AMBIGUOUS_TRACE_SAMPLE', e); }
    } else samples.set(id, Object.freeze({ ...e }));
  }
  return { samples, counts, ambiguous };
}

function attest(e, trace) {
  if (!e) return { status: 'MISSING_REFERENCE', sender_session_id: null, gps: null };
  const parsed = parseSampleId(e.target_sample_id);
  const base = { sender_session_id: parsed?.sender_session_id ?? null, gps: null };
  if (e.target_sample_id == null) return { ...base, status: 'NAV_COORDINATES_ONLY' };
  if (!trace) return { ...base, status: 'TRACE_NOT_SUPPLIED' };
  if (trace.ambiguous.has(e.target_sample_id)) return { ...base, status: 'TRACE_AMBIGUOUS' };
  const sample = trace.samples.get(e.target_sample_id);
  if (!sample) return { ...base, status: 'TRACE_REFERENCE_NOT_FOUND' };
  if (sample.target_lat !== e.target_ref_lat || sample.target_lng !== e.target_ref_lng) return { ...base, status: 'TRACE_COORDINATE_CONTRADICTION' };
  return { ...base, status: 'TRACE_VERIFIED', duplicate_trace_records: (trace.counts.get(e.target_sample_id) ?? 0) - 1,
    gps: { accuracy_m: sample.accuracy_m ?? null, speed_mps: sample.speed_mps ?? null, source_timestamp_ms: sample.source_timestamp_ms ?? null } };
}

function contradictsIncremental(e) {
  return e.event === 'mapbox_http_attempt' || e.mapboxApiCalled === true || e.mapbox_api_called === true
    || ['refetch', 'mapbox_call', 'blocked', 'fallback', 'graph_refetch', 'graph_rebuild'].includes(e.replanType)
    || ['refetch', 'mapbox_call', 'blocked', 'fallback', 'graph_refetch', 'graph_rebuild'].includes(e.update_type)
    || (e.refetchReason != null) || (e.refetch_reason != null)
    || (e.event === 'route_update_end' && (e.m1_eligible === false || e.success === false));
}

/** Pure analysis; copies caller events and never mutates input objects. */
export function analyzeRunV3({ manifest, navigationEvents, senderEvents = null, inputBindings = {}, inputErrors = [] }) {
  validateManifest(manifest);
  const events = structuredClone(navigationEvents);
  const errors = [...inputErrors], warnings = [], stateErrors = new Map();
  const issue = (code, e = null, detail = undefined) => {
    const entry = { code, ...(e ? { event_seq: e.event_seq ?? null, route_update_id: e.route_update_id ?? null } : {}),
      ...(detail === undefined ? {} : { detail }) };
    errors.push(entry);
    if (e) stateErrors.set(e, unique([...(stateErrors.get(e) ?? []), code]));
  };
  const trace = buildTrace(senderEvents == null ? null : structuredClone(senderEvents), issue);
  const intended = manifest.sender?.intended_current_sender_session_ids ?? [];
  const local = (e) => e?.source !== 'backend';
  const starts = events.filter((e) => local(e) && e?.event === 'run_start');
  const stops = events.filter((e) => local(e) && e?.event === 'run_stop');
  const healths = events.filter((e) => local(e) && e?.event === 'logger_health');
  if (starts.length !== 1) issue('RUN_START_COUNT');
  if (stops.length !== 1) issue('RUN_STOP_COUNT');
  const runStart = starts[0], runStop = stops[0];
  if (runStart && runStop && (events.indexOf(runStart) >= events.indexOf(runStop) || runStop.mono_ms < runStart.mono_ms)) issue('INVALID_RUN_BOUNDARIES');
  if (runStart && events[0] !== runStart) issue('RUN_START_NOT_FIRST');
  const finalHealth = healths.at(-1);
  if (!finalHealth) issue('MISSING_FINAL_LOGGER_HEALTH');
  else if (events.at(-1) !== finalHealth || !runStop || events.indexOf(finalHealth) <= events.indexOf(runStop)) issue('INVALID_FINAL_LOGGER_HEALTH_POSITION', finalHealth);
  for (const e of [...healths, ...stops]) {
    if (e.event === 'logger_health' && (!Number.isSafeInteger(e.dropped_events) || e.dropped_events < 0)) issue('UNUSABLE_LOGGER_HEALTH', e);
    if (e.dropped_events != null && (!Number.isSafeInteger(e.dropped_events) || e.dropped_events < 0)) issue('UNUSABLE_LOGGER_HEALTH', e);
    if (finite(e.dropped_events) && e.dropped_events > 0) issue('LOGGER_DROPPED_EVENTS', e);
    if (e.dropped_by_event != null && (!e.dropped_by_event || typeof e.dropped_by_event !== 'object' || Array.isArray(e.dropped_by_event)
      || Object.values(e.dropped_by_event).some((n) => !Number.isSafeInteger(n) || n < 0))) issue('UNUSABLE_LOGGER_HEALTH', e);
    if (e.dropped_by_event && Object.values(e.dropped_by_event).some((n) => n > 0)) issue('LOGGER_DROPPED_EVENTS', e);
  }

  const groups = new Map(), activationSequences = new Set(), references = new Map(), firstSeen = new Map();
  let route = null, receipt = null, previousSeq = 0, primaryTime = -Infinity, activationSeq = 0, repeatedReceipts = 0;
  const groupFor = (e) => {
    const k = key(e);
    if (!groups.has(k)) groups.set(k, { identity: e, starts: [], terminals: [], activations: [], diagnostics: [] });
    return groups.get(k);
  };
  for (const e of events) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !text(e.event)) { issue('INVALID_EVENT_RECORD'); continue; }
    if (!positiveInteger(e.event_seq) || e.event_seq <= previousSeq) issue('INVALID_EVENT_SEQUENCE', e);
    else {
      if (e.event_seq !== previousSeq + 1) issue('EVENT_SEQUENCE_GAP', e);
      previousSeq = e.event_seq;
    }
    if (e.research_run_id !== manifest.navigation.research_run_id) issue('NAVIGATION_RUN_MISMATCH', e);
    if (e.system_version !== manifest.system_version) issue('SYSTEM_VERSION_MISMATCH', e);
    if (manifest.system_version === 'V3' && e.monotonic_us != null
      && (!Number.isSafeInteger(e.monotonic_us) || e.monotonic_us < 0)) issue('INVALID_MONOTONIC_US', e);
    // Imported diagnostics retain separate backend clocks; never select primary state.
    if (!local(e)) {
      if (text(e.session_id) && e.session_id !== manifest.navigation.session_id) issue('NAVIGATION_SESSION_MISMATCH', e);
      if (text(e.route_update_id)) groupFor(e).diagnostics.push(e);
      continue;
    }
    if (!PRIMARY.has(e.event)) {
      if (text(e.route_update_id)) groupFor(e).diagnostics.push(e);
      continue;
    }
    if (!finite(e.mono_ms) || e.mono_ms < 0) issue('INVALID_PRIMARY_MONO_MS', e);
    else if (e.mono_ms < primaryTime) issue('PRIMARY_CLOCK_REVERSAL', e);
    else primaryTime = e.mono_ms;
    if (manifest.system_version === 'V3' && e.monotonic_us != null) {
      if (!Number.isSafeInteger(e.monotonic_us) || e.monotonic_us < 0 || !finite(runStart?.mono_ms)
        || e.monotonic_us !== Math.max(0, Math.round((e.mono_ms - runStart.mono_ms) * 1000))) issue('MONOTONIC_US_MISMATCH', e);
    }
    if (!['run_start', 'run_stop'].includes(e.event) && (!runStart || !runStop
      || e.event_seq <= runStart.event_seq || e.event_seq >= runStop.event_seq
      || e.mono_ms < runStart.mono_ms || e.mono_ms > runStop.mono_ms)) issue('PRIMARY_OUTSIDE_RUN', e);
    const hasAttempt = M1.has(e.event) || e.event === 'route_active';
    if (hasAttempt && (!text(e.session_id) || !text(e.route_update_id))) issue('MISSING_ATTEMPT_IDENTITY', e);
    if ((hasAttempt || e.session_id != null) && e.session_id !== manifest.navigation.session_id) issue('NAVIGATION_SESSION_MISMATCH', e);
    if (e.event === 'route_active' || e.event === 'target_received') {
      if (!isValidLatLng(point(e))) issue('INVALID_REFERENCE_COORDINATES', e);
      if (e.target_sample_id != null && !text(e.target_sample_id)) issue('INVALID_TARGET_SAMPLE_ID', e);
      if (text(e.target_sample_id) && isValidLatLng(point(e))) {
        const previous = references.get(e.target_sample_id);
        if (previous && (previous.lat !== e.target_ref_lat || previous.lng !== e.target_ref_lng)) issue('SAMPLE_COORDINATE_CONTRADICTION', e);
        else references.set(e.target_sample_id, point(e));
      }
      const provenance = attest(e, trace);
      if (e.sender_session_id != null && provenance.sender_session_id != null
        && e.sender_session_id !== provenance.sender_session_id) issue('SAMPLE_SENDER_SESSION_CONTRADICTION', e);
      if (provenance.status === 'TRACE_COORDINATE_CONTRADICTION') issue('TRACE_COORDINATE_CONTRADICTION', e);
      if (provenance.status === 'TRACE_AMBIGUOUS') issue('AMBIGUOUS_TRACE_REFERENCE', e);
      if (e.event === 'target_received' && intended.length) {
        if (provenance.sender_session_id && !intended.includes(provenance.sender_session_id)) issue('WRONG_CURRENT_SENDER_SESSION', e);
        else if (!provenance.sender_session_id) warnings.push('CURRENT_SENDER_IDENTITY_UNATTESTED');
      }
      if (e.event === 'route_active') {
        if (!positiveInteger(e.route_activation_seq) || activationSequences.has(e.route_activation_seq) || e.route_activation_seq <= activationSeq) issue('INVALID_ACTIVATION_SEQUENCE', e);
        else { activationSequences.add(e.route_activation_seq); activationSeq = e.route_activation_seq; }
        if (manifest.system_version === 'V3' && (!positiveInteger(e.route_version) || !text(e.route_signature))) issue('INVALID_ROUTE_VERSION_OR_SIGNATURE', e);
        if (manifest.system_version === 'V3' && !['init', 'restore', 'incremental'].includes(e.research_request_phase)) issue('INVALID_ROUTE_REQUEST_PHASE', e);
        groupFor(e).activations.push(e);
        // Keep even invalid current state; never fall back to an older good route.
        route = e;
      } else {
        const prior = text(e.target_sample_id) ? firstSeen.get(e.target_sample_id) : null;
        const parsed = parseSampleId(e.target_sample_id), previousParsed = parseSampleId(receipt?.event.target_sample_id);
        const sequenceRegression = parsed && previousParsed && parsed.sender_session_id === previousParsed.sender_session_id
          && parsed.sequence < previousParsed.sequence;
        if (prior != null) repeatedReceipts++;
        if (text(e.target_sample_id) && prior == null) firstSeen.set(e.target_sample_id, e.mono_ms);
        receipt = { event: e, firstSeen: text(e.target_sample_id) ? firstSeen.get(e.target_sample_id) : null,
          repeated: prior != null, sequenceRegression: Boolean(sequenceRegression) };
      }
    }
    if (M1.has(e.event)) {
      if (e.source !== 'frontend' || e.clock_domain !== 'browser_performance') issue('INVALID_M1_CLOCK_DOMAIN_OR_SOURCE', e);
      if (e.target_sample_id != null && !text(e.target_sample_id)) issue('INVALID_TARGET_SAMPLE_ID', e);
      if (e.event === 'm1_frontend_start' && !(manifest.system_version === 'V2'
        ? ['initial', 'normal', 'style_reload'] : ['incremental']).includes(e.update_type)) issue('INVALID_M1_START_TYPE', e);
      const group = groupFor(e);
      if (e.event === 'm1_frontend_start') {
        group.starts.push({ event: e, route, receipt: receipt?.event ?? null, firstSeen: receipt?.firstSeen ?? null,
          repeated: receipt?.repeated ?? false, sequenceRegression: receipt?.sequenceRegression ?? false,
          routeErrors: [...(stateErrors.get(route) ?? [])], receiptErrors: [...(stateErrors.get(receipt?.event) ?? [])] });
      } else group.terminals.push(e);
    }
  }

  const candidates = [], diagnostics = [];
  for (const group of groups.values()) {
    if (!group.starts.length && !group.terminals.length) {
      if (group.activations.length > 1) issue('DUPLICATE_ACTIVATION_IDENTITY', group.identity);
      continue; // init/refetch diagnostics without a frontend attempt are not M1.
    }
    if (group.starts.length !== 1) issue('M1_START_COUNT', group.identity);
    if (group.terminals.length !== 1) issue('INCOMPLETE_OR_DUPLICATE_M1_TERMINAL', group.identity);
    if (group.activations.length > 1) issue('DUPLICATE_ACTIVATION_IDENTITY', group.identity);
    const snapshot = group.starts[0], start = snapshot?.event;
    for (const terminal of group.terminals) {
      // Every frontend end is a success claim. Broken true/true outcomes also
      // remain visible instead of shrinking the claimed-success denominator.
      const claimed = terminal.event === 'm1_frontend_end' || terminal.m1_eligible === true || terminal.success === true;
      const reasons = [...(stateErrors.get(terminal) ?? [])];
      if (group.starts.length !== 1) reasons.push('M1_START_COUNT');
      if (group.terminals.length !== 1) reasons.push('M1_TERMINAL_COUNT');
      if (start) {
        reasons.push(...(stateErrors.get(start) ?? []));
        if (terminal.event_seq <= start.event_seq || terminal.mono_ms < start.mono_ms) reasons.push('INVALID_M1_TERMINAL_ORDER');
      }
      if (!claimed) {
        if (terminal.event !== 'm1_frontend_outcome' || terminal.m1_eligible !== false || terminal.success !== false || !text(terminal.failure_reason)) reasons.push('INVALID_M1_OUTCOME');
        if (manifest.system_version === 'V2' ? terminal.update_type !== start?.update_type
          : !['incremental', 'initial', 'graph_refetch', 'fallback', 'blocked'].includes(terminal.update_type)) reasons.push('INVALID_M1_OUTCOME_TYPE');
        for (const reason of unique(reasons)) issue(reason, terminal);
        diagnostics.push({ status: 'DIAGNOSTIC_ONLY', system_version: terminal.system_version, research_run_id: terminal.research_run_id,
          session_id: terminal.session_id ?? null, route_update_id: terminal.route_update_id ?? null,
          m1_start_event_seq: start?.event_seq ?? null, m1_terminal_event_seq: terminal.event_seq,
          exclusion_reason: terminal.failure_reason ?? 'INVALID_M1_OUTCOME', validation_reasons: unique(reasons) });
        continue;
      }
      const eligibleType = manifest.system_version === 'V2' ? 'normal' : 'incremental';
      if (terminal.event !== 'm1_frontend_end' || terminal.m1_eligible !== true || terminal.success !== true
        || terminal.update_type !== eligibleType || start?.update_type !== eligibleType || terminal.failure_reason != null) reasons.push('INVALID_SUCCESSFUL_M1_CONTRACT');
      if (!finite(terminal.duration_ms) || terminal.duration_ms < 0 || !start || !finite(start.mono_ms) || !finite(terminal.mono_ms)
        || Math.abs(terminal.duration_ms - (terminal.mono_ms - start.mono_ms)) > 0.001) reasons.push('INVALID_M1_DURATION');
      // The 0.001 ms tolerance matches the existing M1 serialization validator;
      // it is not a freshness, GPS, latency or observation exclusion threshold.
      if (group.activations.length !== 1) reasons.push('MISSING_OR_DUPLICATE_NEW_ACTIVATION');
      const active = group.activations.length === 1 ? group.activations[0] : null;
      if (active) {
        reasons.push(...(stateErrors.get(active) ?? []));
        if (!start || active.event_seq <= start.event_seq || active.event_seq >= terminal.event_seq
          || active.mono_ms < start.mono_ms || active.mono_ms > terminal.mono_ms) reasons.push('NEW_ACTIVATION_OUTSIDE_M1_INTERVAL');
        if (manifest.system_version === 'V2' && active.route_activation_seq !== terminal.route_activation_seq) reasons.push('NEW_ACTIVATION_IDENTITY_MISMATCH');
        if (manifest.system_version === 'V3' && (active.route_version !== terminal.route_version || active.research_request_phase !== 'incremental')) reasons.push('NEW_ACTIVATION_IDENTITY_MISMATCH');
        const requestIds = [start?.target_sample_id, terminal.target_sample_id, active.target_sample_id].filter((id) => id != null);
        if (unique(requestIds).length > 1) reasons.push('M1_REQUEST_SAMPLE_ID_MISMATCH');
      }
      if (manifest.system_version === 'V3' && group.diagnostics.some(contradictsIncremental)) reasons.push('V3_INCREMENTAL_CLASSIFICATION_CONTRADICTION');
      const old = snapshot?.route, latest = snapshot?.receipt;
      if (!old) reasons.push('MISSING_PREVIOUS_ROUTE');
      else {
        reasons.push(...snapshot.routeErrors.map((reason) => `PREVIOUS_ROUTE_${reason}`));
        if (!isValidLatLng(point(old))) reasons.push('INVALID_PREVIOUS_ROUTE_COORDINATES');
        if (!start || old.event_seq >= start.event_seq || old.mono_ms > start.mono_ms) reasons.push('PREVIOUS_ROUTE_NOT_PRE_START');
      }
      if (!latest) reasons.push('MISSING_LATEST_TARGET_RECEIPT');
      else {
        reasons.push(...snapshot.receiptErrors.map((reason) => `LATEST_TARGET_${reason}`));
        if (!isValidLatLng(point(latest))) reasons.push('INVALID_LATEST_TARGET_COORDINATES');
        if (!start || latest.event_seq >= start.event_seq || latest.mono_ms > start.mono_ms) reasons.push('TARGET_RECEIPT_NOT_PRE_START');
      }
      const previousProvenance = attest(old, trace), latestProvenance = attest(latest, trace);
      const rowWarnings = [];
      if (previousProvenance.sender_session_id && latestProvenance.sender_session_id
        && previousProvenance.sender_session_id !== latestProvenance.sender_session_id) rowWarnings.push('OLD_ROUTE_DIFFERENT_SENDER_SESSION');
      for (const [side, provenance] of [['PREVIOUS_ROUTE', previousProvenance], ['LATEST_TARGET', latestProvenance]]) {
        if (provenance.status !== 'TRACE_VERIFIED') rowWarnings.push(`${side}_${provenance.status}`);
      }
      if (old?.target_sample_id != null && !parseSampleId(old.target_sample_id)) rowWarnings.push('PREVIOUS_ROUTE_UNPARSED_SAMPLE_ID');
      if (latest?.target_sample_id != null && !parseSampleId(latest.target_sample_id)) rowWarnings.push('LATEST_TARGET_UNPARSED_SAMPLE_ID');
      if (snapshot?.sequenceRegression) rowWarnings.push('LATEST_RECEIPT_SAMPLE_SEQUENCE_REGRESSION');
      let distance = null;
      if (!reasons.length) {
        distance = haversineMeters(point(old), point(latest));
        if (!finite(distance)) { reasons.push('NONFINITE_M3_DISTANCE'); distance = null; }
      }
      const unavailable = unique(reasons);
      for (const reason of unavailable) issue(reason, terminal);
      candidates.push({ protocol_version: PROTOCOL_VERSION, system_version: terminal.system_version ?? null,
        research_run_id: terminal.research_run_id ?? null, session_id: terminal.session_id ?? null,
        replan_index: null, route_update_id: terminal.route_update_id ?? null,
        m1_start_event_seq: start?.event_seq ?? null, m1_start_mono_ms: start?.mono_ms ?? null,
        m1_start_monotonic_us: start?.monotonic_us ?? null, m1_terminal_event_seq: terminal.event_seq,
        m1_terminal_status: terminal.event, m1_duration_ms: terminal.duration_ms ?? null,
        previous_route_event_seq: old?.event_seq ?? null, previous_route_update_id: old?.route_update_id ?? null,
        previous_route_activation_seq: old?.route_activation_seq ?? null, previous_route_version: old?.route_version ?? null,
        previous_route_signature: old?.route_signature ?? null, previous_route_target_sample_id: old?.target_sample_id ?? null,
        previous_route_target_lat: old?.target_ref_lat ?? null, previous_route_target_lng: old?.target_ref_lng ?? null,
        latest_target_received_event_seq: latest?.event_seq ?? null, latest_receipt_mono_ms: latest?.mono_ms ?? null,
        latest_received_target_sample_id: latest?.target_sample_id ?? null, latest_received_target_lat: latest?.target_ref_lat ?? null,
        latest_received_target_lng: latest?.target_ref_lng ?? null, m3_pre_replan_distance_m: distance,
        status: unavailable.length ? 'M3_UNAVAILABLE' : 'PAIRED', unavailable_reasons: unavailable,
        previous_route_provenance_status: previousProvenance.status, latest_target_provenance_status: latestProvenance.status,
        previous_route_sender_session_id: previousProvenance.sender_session_id, latest_target_sender_session_id: latestProvenance.sender_session_id,
        receipt_age_ms: start && latest && finite(start.mono_ms) && finite(latest.mono_ms) ? start.mono_ms - latest.mono_ms : null,
        first_seen_mono_ms: snapshot?.firstSeen ?? null,
        first_seen_age_ms: start && snapshot?.firstSeen != null ? start.mono_ms - snapshot.firstSeen : null,
        latest_receipt_repeated_sample: snapshot?.repeated ?? false,
        latest_receipt_sample_sequence_regression: snapshot?.sequenceRegression ?? false,
        previous_route_duplicate_trace_records: previousProvenance.duplicate_trace_records ?? 0,
        latest_target_duplicate_trace_records: latestProvenance.duplicate_trace_records ?? 0,
        new_activation_event_seq: active?.event_seq ?? null, new_activation_route_update_id: active?.route_update_id ?? null,
        new_activation_sequence: active?.route_activation_seq ?? null, new_activation_version: active?.route_version ?? null,
        new_activation_signature: active?.route_signature ?? null,
        sender_gps_diagnostics: { previous_route: previousProvenance.gps, latest_target: latestProvenance.gps }, warnings: rowWarnings });
    }
    if (!group.terminals.length) diagnostics.push({ status: 'DIAGNOSTIC_ONLY', route_update_id: group.identity.route_update_id ?? null,
      m1_start_event_seq: start?.event_seq ?? null, exclusion_reason: 'INCOMPLETE_M1_CHAIN' });
  }
  // Only presentation of candidate rows is ordered; raw event streams are never sorted.
  candidates.sort((a, b) => (a.m1_start_event_seq ?? a.m1_terminal_event_seq) - (b.m1_start_event_seq ?? b.m1_terminal_event_seq)
    || a.m1_terminal_event_seq - b.m1_terminal_event_seq);
  candidates.forEach((row, i) => { row.replan_index = i + 1; });
  const paired = candidates.filter((row) => row.status === 'PAIRED'), unavailable = candidates.filter((row) => row.status === 'M3_UNAVAILABLE');
  const complete = candidates.length === paired.length && unavailable.length === 0 && errors.length === 0;
  const status = !complete ? 'INVALID' : candidates.length ? 'VALID' : 'NO_ELIGIBLE_REPLANS';
  const official = complete && candidates.length ? distribution(paired.map((row) => row.m3_pre_replan_distance_m)) : { ...distribution([]), count: 0 };
  return { schema_version: 'm3-analysis-v3', protocol_version: PROTOCOL_VERSION,
    summary: { schema_version: 'm3-summary-v3', protocol_version: PROTOCOL_VERSION,
      system_version: manifest.system_version, research_run_id: manifest.navigation.research_run_id, session_id: manifest.navigation.session_id,
      run_validation_status: status, successful_eligible_M1_count: candidates.length, official_paired_M3_count: paired.length,
      m3_unavailable_count: unavailable.length, unavailable_counts_by_reason: countReasons(unavailable, 'unavailable_reasons'), pairing_complete: complete,
      excluded_attempt_count: diagnostics.length, excluded_attempt_counts_by_reason: countReasons(diagnostics, 'exclusion_reason'),
      official_m3_distance_m: official, repeated_sample_receipt_count: repeatedReceipts,
      logger_health: { final: finalHealth ? { event_seq: finalHealth.event_seq, dropped_events: finalHealth.dropped_events ?? null,
        stored_events: finalHealth.stored_events ?? finalHealth.total_events ?? null, attempted_events: finalHealth.attempted_events ?? null,
        dropped_by_event: finalHealth.dropped_by_event ?? null } : null,
        recorded_drop_counts: [...healths, ...stops].filter((e) => e.dropped_events != null).map((e) => ({ event: e.event, event_seq: e.event_seq, dropped_events: e.dropped_events })) },
      input_file_bindings: inputBindings, warnings: unique(warnings) },
    official_observations: status === 'VALID' ? paired : [], unavailable_successful_candidates: unavailable,
    diagnostic_only: { status: 'DIAGNOSTIC_ONLY', paired_candidates_from_invalid_run: status === 'INVALID' ? paired : [],
      excluded_attempts: diagnostics, validation_errors: errors } };
}

function boundFile(binding, base, label) {
  let file, bytes;
  try { file = realpathSync(resolve(base, binding.file)); bytes = readFileSync(file); }
  catch { throw new ConfigurationError(`${label}: cannot read explicitly bound file`); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (binding.sha256 != null && binding.sha256 !== sha256) throw new ConfigurationError(`${label}: SHA256_MISMATCH`);
  return { file, sha256, bytes };
}

export function analyzeFilesV3(manifestPath) {
  let manifestFile, manifest, manifestBytes;
  try { manifestFile = realpathSync(resolve(manifestPath)); manifestBytes = readFileSync(manifestFile); manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new ConfigurationError('Cannot read/parse manifest'); }
  validateManifest(manifest);
  const nav = boundFile(manifest.navigation, dirname(manifestFile), 'navigation');
  const sender = manifest.sender?.file != null ? boundFile(manifest.sender, dirname(manifestFile), 'sender') : null;
  if (sender?.file === nav.file || nav.file === manifestFile || sender?.file === manifestFile) throw new ConfigurationError('Input bindings must be distinct files');
  const parsedNav = parseJsonl(nav.bytes.toString('utf8')), parsedSender = sender ? parseJsonl(sender.bytes.toString('utf8'), 'sender') : null;
  return analyzeRunV3({ manifest, navigationEvents: parsedNav.events, senderEvents: parsedSender?.events ?? null,
    inputErrors: [...parsedNav.errors, ...(parsedSender?.errors ?? [])],
    inputBindings: { manifest: { file: manifestFile, sha256: createHash('sha256').update(manifestBytes).digest('hex') },
      navigation: { file: nav.file, sha256: nav.sha256, research_run_id: manifest.navigation.research_run_id, session_id: manifest.navigation.session_id },
      sender: sender ? { file: sender.file, sha256: sender.sha256 } : null,
      intended_current_sender_session_ids: manifest.sender?.intended_current_sender_session_ids ?? [] } });
}

export function main(argv = process.argv.slice(2)) {
  try {
    let manifest, table = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--manifest' && !manifest && text(argv[i + 1]) && !argv[i + 1].startsWith('--')) manifest = argv[++i];
      else if (argv[i] === '--table' && !table) table = true;
      else throw new ConfigurationError('Invalid CLI arguments; use --manifest <file> [--table]');
    }
    if (!manifest) throw new ConfigurationError('Missing --manifest');
    const result = analyzeFilesV3(manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const s = result.summary;
    process.stderr.write(`${PROTOCOL_VERSION}: ${s.run_validation_status}; M1=${s.successful_eligible_M1_count}, M3=${s.official_paired_M3_count}, unavailable=${s.m3_unavailable_count}\n`);
    if (table) for (const row of [...result.official_observations, ...result.unavailable_successful_candidates, ...result.diagnostic_only.paired_candidates_from_invalid_run]) {
      process.stderr.write(`${row.replan_index}\t${row.route_update_id}\t${row.status}\t${row.m3_pre_replan_distance_m ?? 'null'}\n`);
    }
    return s.run_validation_status === 'VALID' ? 0 : 1;
  } catch (error) {
    const configuration = error instanceof ConfigurationError;
    const message = configuration ? error.message : 'Unexpected analyzer error; no official result';
    process.stdout.write(`${JSON.stringify({ schema_version: 'm3-analysis-v3', protocol_version: PROTOCOL_VERSION,
      summary: { run_validation_status: configuration ? 'CONFIGURATION_ERROR' : 'INVALID', pairing_complete: false,
        official_m3_distance_m: distribution([]) }, errors: [message] }, null, 2)}\n`);
    process.stderr.write(`${message}\n`);
    return configuration ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
