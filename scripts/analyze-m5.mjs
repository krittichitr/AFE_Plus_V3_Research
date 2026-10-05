#!/usr/bin/env node
// M5-PROTOCOL-V1: video annotations create episodes; JSONL only validates and explains them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const requiredCriteria = [
  'min_stall_duration_ms', 'stall_visual_tolerance_rule', 'max_catchup_delay_ms',
  'catchup_rule', 'episode_merge_gap_ms', 'max_sync_uncertainty_ms',
  'max_sync_drift_ppm', 'min_verified_walking_duration_ms', 'min_video_coverage_ratio',
  'camera_confound_rule', 'unverifiable_segment_rule',
  'required_second_review_zero_fraction', 'annotation_confidence_rule',
  'dropped_event_rule', 'lifecycle_interruption_rule',
];
const numericCriteria = new Set([
  'min_stall_duration_ms', 'max_catchup_delay_ms', 'episode_merge_gap_ms',
  'max_sync_uncertainty_ms', 'max_sync_drift_ppm', 'min_verified_walking_duration_ms',
  'min_video_coverage_ratio', 'required_second_review_zero_fraction',
]);
const statusError = (status, reason) => Object.assign(new Error(reason), { status });
const fail = (status, reason) => { throw statusError(status, reason); };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const interval = (start, end, status = 'ANNOTATION_PROTOCOL_ERROR') => {
  if (!finite(start) || !finite(end) || start < 0 || end <= start) fail(status, `invalid interval ${start}..${end}`);
  return [start, end];
};
const intersect = ([a, b], [c, d]) => b > c && d > a ? [Math.max(a, c), Math.min(b, d)] : null;
const union = (items) => {
  const sorted = items.filter(Boolean).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
};
const duration = (items) => union(items).reduce((sum, [a, b]) => sum + b - a, 0);
const subtract = (base, cuts) => {
  let result = union(base);
  for (const [cutA, cutB] of union(cuts)) {
    result = result.flatMap(([a, b]) => {
      if (cutB <= a || cutA >= b) return [[a, b]];
      return [[a, Math.min(b, cutA)], [Math.max(a, cutB), b]].filter(([x, y]) => y > x);
    });
  }
  return result;
};
const contained = (span, segments) => duration(segments.map((s) => intersect(span, s))) >= span[1] - span[0] - 0.001;

function checkCriteria(c) {
  if (c?.schema_version !== 'm5-criteria-v1' || c.protocol_version !== 'M5-PROTOCOL-V1') fail('M5_CRITERIA_MISSING', 'criteria version missing or wrong');
  const missing = requiredCriteria.filter((key) => numericCriteria.has(key)
    ? !finite(c[key]) : !nonempty(c[key]));
  if (missing.length) fail('M5_CRITERIA_MISSING', `unset criteria: ${missing.join(', ')}`);
  for (const key of numericCriteria) if (c[key] < 0) fail('PROTOCOL_ERROR', `negative ${key}`);
  for (const key of ['min_video_coverage_ratio', 'required_second_review_zero_fraction']) {
    if (c[key] <= 0 || c[key] > 1) fail('PROTOCOL_ERROR', `${key} must be greater than 0 and at most 1`);
  }
  if (!['subtract_union'].includes(c.unverifiable_segment_rule)
    || !['reject_or_unverifiable'].includes(c.camera_confound_rule)
    || !['invalidate_any_drop', 'invalidate_if_required_evidence_affected'].includes(c.dropped_event_rule)
    || !['subtract', 'invalidate'].includes(c.lifecycle_interruption_rule)
    || c.annotation_confidence_rule !== 'reviewer_confirmed') {
    fail('PROTOCOL_ERROR', 'unsupported operational rule');
  }
}

function checkLog(rows) {
  if (!Array.isArray(rows) || !rows.length) fail('INCOMPLETE_LOG', 'empty JSONL');
  const first = rows[0];
  if (!nonempty(first.research_run_id) || !['web', 'mobile'].includes(first.platform)) fail('INCOMPLETE_LOG', 'run identity missing');
  let lastSeq = 0;
  let lastTime = -1;
  let sequenceGaps = 0;
  for (const row of rows) {
    if (row.research_run_id !== first.research_run_id || row.platform !== first.platform
      || !Number.isInteger(row.event_seq) || row.event_seq <= lastSeq
      || !finite(row.monotonic_us) || row.monotonic_us < lastTime) {
      fail('INCOMPLETE_LOG', 'mixed identity, invalid sequence, or nonmonotonic log time');
    }
    sequenceGaps += row.event_seq - lastSeq - 1;
    lastSeq = row.event_seq;
    lastTime = row.monotonic_us;
  }
  if (rows.filter((x) => x.event === 'run_start').length !== 1
    || rows.filter((x) => x.event === 'run_stop').length !== 1
    || rows.filter((x) => x.event === 'logger_health').length !== 1) fail('INCOMPLETE_LOG', 'run boundary or logger health missing');
  const health = rows.find((x) => x.event === 'logger_health');
  if (!Number.isInteger(health.dropped_events) || health.dropped_events < 0
    || sequenceGaps !== health.dropped_events) fail('INCOMPLETE_LOG', 'event sequence gaps do not match logger health');
  return first;
}

function lifecycleCuts(rows, window) {
  let start = null;
  const cuts = [];
  for (const row of rows) {
    const state = String(row.lifecycle_state ?? row.visibility_state ?? '').toLowerCase();
    const hidden = row.event === 'lifecycle_page_hidden'
      || (row.event === 'lifecycle_visibility_changed' && state === 'hidden')
      || (row.event === 'lifecycle_state_changed' && ['paused', 'inactive', 'hidden', 'detached'].includes(state));
    const shown = row.event === 'lifecycle_page_shown'
      || (row.event === 'lifecycle_visibility_changed' && state === 'visible')
      || (row.event === 'lifecycle_state_changed' && state === 'resumed');
    if (hidden && start === null) start = row.monotonic_us;
    if (shown && start !== null) { cuts.push([start, row.monotonic_us]); start = null; }
  }
  if (start !== null) cuts.push([start, window[1]]);
  return union(cuts.map((x) => intersect(x, window)));
}

function syncMapping(rows, annotation, window, c, result) {
  const logs = rows.filter((x) => x.event === 'video_sync_marker');
  if (new Set(logs.map((x) => x.sync_id)).size !== logs.length
    || logs.some((x) => !nonempty(x.sync_id) || !Number.isInteger(x.sync_sequence))) fail('VIDEO_SYNC_INVALID', 'duplicate/invalid log sync ID');
  const byId = new Map(logs.map((x) => [x.sync_id, x]));
  const orderedLogs = [...logs].sort((a, b) => a.monotonic_us - b.monotonic_us);
  for (let i = 1; i < orderedLogs.length; i++) {
    if (orderedLogs[i].sync_sequence <= orderedLogs[i - 1].sync_sequence) fail('VIDEO_SYNC_INVALID', 'sync sequence is not increasing');
  }
  const points = annotation.sync_points;
  if (!Array.isArray(points) || points.length < 2 || new Set(points.map((x) => x.sync_id)).size !== points.length) fail('VIDEO_SYNC_INVALID', 'at least two unique annotated sync points required');
  const anchors = points.map((p) => {
    const log = byId.get(p.sync_id);
    if (!log || !finite(p.video_ms) || p.video_ms < 0
      || !finite(p.annotation_uncertainty_ms) || p.annotation_uncertainty_ms < 0) fail('VIDEO_SYNC_INVALID', 'sync point missing or invalid');
    return { video: p.video_ms, log: log.monotonic_us, uncertainty: p.annotation_uncertainty_ms };
  }).sort((a, b) => a.video - b.video);
  const drift = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (b.video <= a.video || b.log <= a.log) fail('VIDEO_SYNC_INVALID', 'sync order is not increasing');
    const ppm = Math.abs(((b.log - a.log) / ((b.video - a.video) * 1000) - 1) * 1e6);
    drift.push(ppm);
  }
  const uncertainty = Math.max(...anchors.map((x) => x.uncertainty));
  result.sync_point_count = anchors.length;
  result.estimated_sync_uncertainty_ms = uncertainty;
  result.estimated_sync_drift_ppm = Math.max(...drift);
  if (uncertainty > c.max_sync_uncertainty_ms || result.estimated_sync_drift_ppm > c.max_sync_drift_ppm
    || anchors[0].log > window[0] || anchors.at(-1).log < window[1]) fail('VIDEO_SYNC_INVALID', 'uncertainty/drift exceeded or anchors do not bracket walking window');
  result.video_sync_status = 'OK';
  return (videoMs) => {
    if (!finite(videoMs) || videoMs < anchors[0].video || videoMs > anchors.at(-1).video) fail('VIDEO_SYNC_INVALID', 'annotation outside sync anchors');
    let i = 1;
    while (i < anchors.length - 1 && videoMs > anchors[i].video) i++;
    const a = anchors[i - 1], b = anchors[i];
    return a.log + (videoMs - a.video) * (b.log - a.log) / (b.video - a.video);
  };
}

const routeMilestones = [
  'route_update_received', 'route_frontend_accepted', 'route_render_command_completed',
];

function routeContext(rows, span) {
  // Full-run nearest neighbors, with explicit deltas; no unapproved association window or causal inference.
  const describe = (row) => row ? {
    event_seq: row.event_seq,
    monotonic_us: row.monotonic_us,
    session_id: row.session_id ?? null,
    route_update_id: row.route_update_id ?? null,
    route_version: row.route_version ?? null,
    route_source_key: row.route_source_key ?? null,
    route_signature: row.route_signature ?? null,
    outcome: row.outcome ?? null,
    completion_kind: row.completion_kind ?? null,
    visible_render_confirmed: row.visible_render_confirmed ?? null,
    delta_to_stall_start_ms: (row.monotonic_us - span[0]) / 1000,
    delta_to_episode_end_ms: (row.monotonic_us - span[1]) / 1000,
  } : null;
  return Object.fromEntries(routeMilestones.map((event) => {
    const matching = rows.filter((row) => row.event === event);
    const before = matching.filter((row) => row.monotonic_us < span[0]).at(-1) ?? null;
    const inside = matching.filter((row) => row.monotonic_us >= span[0] && row.monotonic_us <= span[1]);
    const after = matching.find((row) => row.monotonic_us > span[1]) ?? null;
    return [event, {
      nearest_before: describe(before),
      inside_count: inside.length,
      nearest_inside: describe(inside[0] ?? null),
      nearest_after: describe(after),
    }];
  }));
}

function episodeSupport(rows, span) {
  // Diagnostic neighborhood only: one second either side in the run monotonic domain.
  const nearby = rows.filter((x) => x.monotonic_us >= span[0] - 1_000_000 && x.monotonic_us <= span[1] + 1_000_000);
  const raw = nearby.filter((x) => x.event === 'raw_location_received');
  const motion = nearby.filter((x) => x.event === 'agent_motion_computed');
  const commands = nearby.filter((x) => x.event.startsWith('agent_marker_command_'));
  return {
    nearby_raw_location_count: raw.length,
    nearby_raw_location_ids: raw.map((x) => x.location_sample_id).filter((x) => x != null),
    nearby_motion_frame_ids: motion.map((x) => x.motion_frame_id).filter((x) => x != null),
    nearby_marker_command_ids: commands.map((x) => x.marker_command_id ?? x.marker_request_id).filter((x) => x != null),
    marker_command_outcomes: commands.map((x) => x.event),
    camera_context_summary: [...new Set([...motion, ...commands].map((x) => `${x.camera_mode ?? 'unknown'}:${x.camera_following ?? 'unknown'}`))],
    route_context_basis: 'nearest_full_run_milestones_no_causal_claim',
    route_context: routeContext(rows, span),
  };
}

export function analyzeM5({ rows, annotation, manifest, criteria, videoExists = true, logFile = null, videoHash = null }) {
  const out = {
    research_run_id: null, platform: null, walking_window_id: null,
    walking_window_duration_s: null, physical_walking_annotated_s: null,
    excluded_physical_stop_s: null, excluded_unverifiable_s: null, excluded_lifecycle_s: null,
    verified_walking_duration_s: null, verified_walking_duration_min: null,
    video_coverage_ratio: null, sync_point_count: 0, video_sync_status: 'NOT_CHECKED',
    estimated_sync_uncertainty_ms: null, estimated_sync_drift_ppm: null,
    annotated_episode_count: 0, accepted_episode_count: 0, rejected_episode_count: 0,
    ambiguous_episode_count: 0, stall_without_catchup_count: 0, m5_events_per_min: null,
    logger_health_status: 'NOT_CHECKED', review_status: 'NOT_CHECKED', status: 'PROTOCOL_ERROR',
    diagnostic_reason: null, episodes: [],
  };
  try {
    checkCriteria(criteria);
    const first = checkLog(rows);
    out.research_run_id = first.research_run_id;
    out.platform = first.platform;
    if (!videoExists) fail('NO_VIDEO', 'linked screen recording does not exist');
    const starts = rows.filter((x) => x.event === 'walking_window_start');
    const stops = rows.filter((x) => x.event === 'walking_window_stop');
    if (starts.length !== 1 || stops.length !== 1 || starts[0].walking_window_id !== stops[0].walking_window_id
      || !nonempty(starts[0].walking_window_id) || starts[0].monotonic_us >= stops[0].monotonic_us) fail('NO_WALKING_WINDOW', 'exactly one paired M4 walking window required');
    const window = [starts[0].monotonic_us, stops[0].monotonic_us];
    out.walking_window_id = starts[0].walking_window_id;
    out.walking_window_duration_s = (window[1] - window[0]) / 1e6;
    if (manifest?.schema_version !== 'm5-video-manifest-v1' || manifest.protocol_version !== 'M5-PROTOCOL-V1'
      || annotation?.schema_version !== 'm5-annotation-v1' || annotation.protocol_version !== 'M5-PROTOCOL-V1') fail('PROTOCOL_ERROR', 'manifest/annotation version mismatch');
    if (manifest.research_run_id !== first.research_run_id || annotation.research_run_id !== first.research_run_id
      || manifest.platform !== first.platform || annotation.platform !== first.platform
      || manifest.walking_window_id !== out.walking_window_id || annotation.walking_window_id !== out.walking_window_id
      || !nonempty(manifest.video_file) || manifest.video_file !== annotation.video_file
      || (logFile && basename(manifest.navigation_log_file) !== basename(logFile))
      || (manifest.video_file_hash_sha256 && manifest.video_file_hash_sha256 !== videoHash)) fail('VIDEO_RUN_MISMATCH', 'video/log/run/window linkage mismatch');
    const map = syncMapping(rows, annotation, window, criteria, out);
    const health = rows.find((x) => x.event === 'logger_health');
    if (!health || !Number.isInteger(health.dropped_events)) fail('INCOMPLETE_LOG', 'logger health invalid');
    out.logger_health_status = health.dropped_events ? `DROPPED:${health.dropped_events}` : 'OK';
    if (health.dropped_events) {
      const essential = ['video_sync_marker', 'walking_window_start', 'walking_window_stop', 'lifecycle_state_changed', 'lifecycle_visibility_changed', 'lifecycle_page_hidden', 'lifecycle_page_shown', 'raw_location_received', 'agent_motion_computed', ...routeMilestones];
      const impacts = criteria.dropped_event_rule === 'invalidate_any_drop'
        || !health.dropped_by_event || essential.some((key) => Number(health.dropped_by_event[key] ?? 0) > 0);
      if (impacts) fail('DROPPED_EVENTS', 'dropped required run/sync/walking/lifecycle/supporting evidence');
    }
    if (annotation.video_review_complete !== true || !nonempty(annotation.primary_reviewer_id)) fail('REVIEW_INCOMPLETE', 'full-run primary review not attested');
    if (!Array.isArray(annotation.segments) || !Array.isArray(annotation.episodes)
      || !Array.isArray(annotation.no_event_regions) || !Array.isArray(annotation.reviews)) fail('ANNOTATION_PROTOCOL_ERROR', 'annotation arrays missing');
    const reviewKeys = annotation.reviews.map((r) => `${r.target_type}:${r.target_id}`);
    if (new Set(reviewKeys).size !== reviewKeys.length) fail('ANNOTATION_PROTOCOL_ERROR', 'duplicate review target');
    const segments = annotation.segments.map((s) => {
      interval(s.start_video_ms, s.end_video_ms);
      if (!nonempty(s.segment_id) || !['physical_walking', 'physical_stop', 'unverifiable'].includes(s.kind)
        || !nonempty(s.evidence_source) || !nonempty(s.evidence_note)) fail('ANNOTATION_PROTOCOL_ERROR', 'segment identity/kind/evidence missing');
      if (['physical_walking', 'physical_stop'].includes(s.kind)
        && !['timestamped_observer_annotation', 'external_video'].includes(s.evidence_source)) fail('PHYSICAL_WALKING_EVIDENCE_MISSING', 'independent walking/stop evidence missing');
      return { ...s, log: interval(map(s.start_video_ms), map(s.end_video_ms)) };
    });
    const walking = union(segments.filter((s) => s.kind === 'physical_walking').map((s) => intersect(s.log, window)));
    if (!walking.length) fail('PHYSICAL_WALKING_EVIDENCE_MISSING', 'no independently evidenced physical walking');
    out.physical_walking_annotated_s = duration(walking) / 1e6;
    const stopsCut = union(segments.filter((s) => s.kind === 'physical_stop').map((s) => intersect(s.log, window)));
    const unverifiable = union(segments.filter((s) => s.kind === 'unverifiable').map((s) => intersect(s.log, window)));
    const lifecycle = lifecycleCuts(rows, window);
    out.excluded_physical_stop_s = duration(walking.flatMap((x) => stopsCut.map((y) => intersect(x, y)))) / 1e6;
    const afterStop = subtract(walking, stopsCut);
    out.excluded_unverifiable_s = duration(afterStop.flatMap((x) => unverifiable.map((y) => intersect(x, y)))) / 1e6;
    const afterVideo = subtract(afterStop, unverifiable);
    out.excluded_lifecycle_s = duration(afterVideo.flatMap((x) => lifecycle.map((y) => intersect(x, y)))) / 1e6;
    if (lifecycle.length && criteria.lifecycle_interruption_rule === 'invalidate') fail('LIFECYCLE_INTERRUPTED', 'lifecycle interruption inside walking window');
    const usable = subtract(afterVideo, lifecycle);
    out.verified_walking_duration_s = duration(usable) / 1e6;
    out.verified_walking_duration_min = out.verified_walking_duration_s / 60;
    out.video_coverage_ratio = duration(usable) / duration(walking);
    if (out.verified_walking_duration_s <= 0 || out.verified_walking_duration_s * 1000 < criteria.min_verified_walking_duration_ms) fail('INSUFFICIENT_VERIFIED_WALKING_TIME', 'verified duration below criteria');
    if (out.video_coverage_ratio < criteria.min_video_coverage_ratio) fail('UNVERIFIABLE_VIDEO', 'reviewable coverage below criteria');
    const episodeIds = new Set();
    const reviewFor = (type, id) => annotation.reviews.find((r) => r.target_type === type && r.target_id === id);
    const spans = [];
    for (const ep of annotation.episodes) {
      if (!nonempty(ep.episode_id) || episodeIds.has(ep.episode_id) || ep.reviewer_id !== annotation.primary_reviewer_id
        || !['accepted', 'rejected', 'ambiguous'].includes(ep.decision)) fail('ANNOTATION_PROTOCOL_ERROR', 'episode ID/reviewer/decision invalid');
      episodeIds.add(ep.episode_id);
      const stall = interval(ep.stall_start_video_ms, ep.stall_end_video_ms);
      const hasCatchup = finite(ep.catchup_start_video_ms) && finite(ep.catchup_end_video_ms);
      const catchup = hasCatchup ? interval(ep.catchup_start_video_ms, ep.catchup_end_video_ms) : null;
      if (catchup && catchup[0] < stall[1]) fail('ANNOTATION_PROTOCOL_ERROR', 'catch-up begins before stall ends');
      if (!catchup && ep.decision === 'accepted') fail('ANNOTATION_PROTOCOL_ERROR', 'accepted episode has no catch-up');
      const logStall = [map(stall[0]), map(stall[1])];
      const logCatchup = catchup ? [map(catchup[0]), map(catchup[1])] : null;
      const span = [logStall[0], logCatchup?.[1] ?? logStall[1]];
      spans.push([stall[0], catchup?.[1] ?? stall[1]]);
      let final = ep.decision;
      const review = reviewFor('episode', ep.episode_id);
      if (['accepted', 'ambiguous'].includes(ep.decision)) {
        if (!review || !nonempty(review.reviewer_id) || review.reviewer_id === ep.reviewer_id
          || review.original_decision !== ep.decision || !['accepted', 'rejected', 'ambiguous'].includes(review.review_decision)
          || review.disagreement !== (review.review_decision !== ep.decision)) fail('REVIEW_INCOMPLETE', `second review missing/inconsistent for ${ep.episode_id}`);
        if (review.review_decision !== ep.decision) {
          if (!['accepted', 'rejected'].includes(review.adjudicated_decision) || !nonempty(review.adjudication_reason)) fail('REVIEW_INCOMPLETE', `unresolved disagreement ${ep.episode_id}`);
          final = review.adjudicated_decision;
        } else final = review.review_decision;
      }
      const reason = ep.reason ?? '';
      if (!catchup) { final = 'rejected'; out.stall_without_catchup_count++; }
      if (final === 'accepted' && (reason === 'CAMERA_CONFOUND' || !contained(span, usable)
        || (stall[1] - stall[0]) < criteria.min_stall_duration_ms
        || (catchup[0] - stall[1]) > criteria.max_catchup_delay_ms)) fail('ANNOTATION_PROTOCOL_ERROR', `accepted episode violates criterion/boundary: ${ep.episode_id}`);
      const detail = {
        episode_id: ep.episode_id, decision: ep.decision, final_decision: final,
        stall_start_video_ms: stall[0], stall_end_video_ms: stall[1],
        catchup_start_video_ms: catchup?.[0] ?? null, catchup_end_video_ms: catchup?.[1] ?? null,
        stall_start_log_us: logStall[0], stall_end_log_us: logStall[1],
        catchup_start_log_us: logCatchup?.[0] ?? null, catchup_end_log_us: logCatchup?.[1] ?? null,
        sync_uncertainty_ms: out.estimated_sync_uncertainty_ms,
        stall_duration_ms: stall[1] - stall[0], catchup_duration_ms: catchup ? catchup[1] - catchup[0] : null,
        reviewer_ids: [ep.reviewer_id, review?.reviewer_id].filter(Boolean), reason,
        ...episodeSupport(rows, span),
      };
      out.episodes.push(detail);
      if (final === 'accepted') out.accepted_episode_count++;
      else if (final === 'ambiguous') out.ambiguous_episode_count++;
      else out.rejected_episode_count++;
    }
    out.annotated_episode_count = out.episodes.length;
    const orderedSpans = spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < orderedSpans.length; i++) {
      if (orderedSpans[i][0] - orderedSpans[i - 1][1] < criteria.episode_merge_gap_ms) fail('ANNOTATION_PROTOCOL_ERROR', 'episodes overlap or fall inside merge gap');
    }
    const noEventIds = new Set();
    const noEventSpans = annotation.no_event_regions.map((r) => {
      if (!nonempty(r.region_id) || noEventIds.has(r.region_id)) fail('ANNOTATION_PROTOCOL_ERROR', 'duplicate/missing no-event region ID');
      noEventIds.add(r.region_id);
      interval(r.start_video_ms, r.end_video_ms);
      return { id: r.region_id, log: [map(r.start_video_ms), map(r.end_video_ms)] };
    });
    if (noEventSpans.some((r) => out.episodes.some((e) => intersect(r.log, [e.stall_start_log_us, e.catchup_end_log_us ?? e.stall_end_log_us])))) fail('ANNOTATION_PROTOCOL_ERROR', 'no-event region overlaps an annotated episode');
    const covered = union([...noEventSpans.map((r) => r.log), ...out.episodes.map((e) => [e.stall_start_log_us, e.catchup_end_log_us ?? e.stall_end_log_us])]);
    if (usable.some((part) => !contained(part, covered))) fail('REVIEW_INCOMPLETE', 'primary review has uncovered verified-walking time');
    const needed = Math.ceil(criteria.required_second_review_zero_fraction * noEventSpans.length);
    const checked = noEventSpans.filter((r) => {
      const review = reviewFor('no_event_region', r.id);
      return review && nonempty(review.reviewer_id) && review.reviewer_id !== annotation.primary_reviewer_id
        && review.original_decision === 'no_event' && review.review_decision === 'no_event'
        && review.disagreement === false;
    }).length;
    if (checked < needed || out.ambiguous_episode_count > 0) fail('REVIEW_INCOMPLETE', 'negative-region sample/ambiguous review incomplete');
    out.review_status = 'OK';
    out.status = 'OK';
    out.diagnostic_reason = null;
    out.m5_events_per_min = out.accepted_episode_count / out.verified_walking_duration_min;
  } catch (error) {
    out.status = error.status ?? 'PROTOCOL_ERROR';
    out.diagnostic_reason = error.message;
    out.m5_events_per_min = null;
  }
  return out;
}

function cli() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i]] = args[i + 1];
  for (const key of ['--log', '--annotation', '--manifest', '--criteria']) {
    if (!opt[key]) { process.stderr.write(`missing ${key}\n`); process.exitCode = 2; return; }
  }
  const readJson = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));
  try {
    const rows = readFileSync(resolve(opt['--log']), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const manifest = readJson(opt['--manifest']);
    const annotation = readJson(opt['--annotation']);
    const criteria = readJson(opt['--criteria']);
    const videoPath = resolve(manifest.video_file ?? '');
    const videoExists = nonempty(manifest.video_file) && existsSync(videoPath);
    const videoHash = videoExists && manifest.video_file_hash_sha256
      ? createHash('sha256').update(readFileSync(videoPath)).digest('hex') : null;
    const result = analyzeM5({ rows, annotation, manifest, criteria, videoExists, logFile: opt['--log'], videoHash });
    if (opt['--episodes-output']) writeFileSync(resolve(opt['--episodes-output']), `${JSON.stringify(result.episodes, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'OK') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) cli();
