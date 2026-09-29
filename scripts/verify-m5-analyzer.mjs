import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeM5 } from './analyze-m5.mjs';

// All values below are synthetic fixture values, never approved research thresholds.
const criteria = {
  schema_version: 'm5-criteria-v1', protocol_version: 'M5-PROTOCOL-V1',
  min_stall_duration_ms: 500, stall_visual_tolerance_rule: 'fixture reviewer rule',
  max_catchup_delay_ms: 1000, catchup_rule: 'fixture reviewer rule', episode_merge_gap_ms: 100,
  max_sync_uncertainty_ms: 50, max_sync_drift_ppm: 1000,
  min_verified_walking_duration_ms: 1000, min_video_coverage_ratio: 0.5,
  camera_confound_rule: 'reject_or_unverifiable', unverifiable_segment_rule: 'subtract_union',
  required_second_review_zero_fraction: 1, annotation_confidence_rule: 'reviewer_confirmed',
  dropped_event_rule: 'invalidate_if_required_evidence_affected', lifecycle_interruption_rule: 'subtract',
};
function fixture(platform = 'web') {
  const events = [
    ['run_start', 0, {}],
    ['video_sync_marker', 1_000_000, { sync_id: 'A', sync_sequence: 1, walking_window_id: null }],
    ['walking_window_start', 2_000_000, { walking_window_id: 'W' }],
    ['raw_location_received', 3_000_000, { location_sample_id: 4 }],
    ['agent_motion_computed', 4_000_000, { motion_frame_id: 5, camera_following: true }],
    ['agent_marker_command_completed', 5_000_000, { marker_command_id: 6, visible_render_confirmed: false }],
    ['walking_window_stop', 12_000_000, { walking_window_id: 'W' }],
    ['video_sync_marker', 13_000_000, { sync_id: 'B', sync_sequence: 2, walking_window_id: 'W' }],
    ['run_stop', 14_000_000, { dropped_events: 0 }],
    ['logger_health', 14_000_000, { dropped_events: 0, dropped_by_event: {} }],
  ];
  const rows = events.map(([event, monotonic_us, rest], i) => ({ event, monotonic_us, event_seq: i + 1, research_run_id: 'R', platform, ...rest }));
  const annotation = {
    schema_version: 'm5-annotation-v1', protocol_version: 'M5-PROTOCOL-V1',
    research_run_id: 'R', platform, video_file: 'video.mp4', walking_window_id: 'W',
    video_review_complete: true, primary_reviewer_id: 'r1',
    sync_points: [{ sync_id: 'A', video_ms: 1000, annotation_uncertainty_ms: 0 }, { sync_id: 'B', video_ms: 13000, annotation_uncertainty_ms: 0 }],
    segments: [{ segment_id: 'walk', start_video_ms: 2000, end_video_ms: 12000, kind: 'physical_walking', evidence_source: 'external_video', evidence_note: 'synthetic witness' }],
    episodes: [],
    no_event_regions: [{ region_id: 'none', start_video_ms: 2000, end_video_ms: 12000 }],
    reviews: [{ target_type: 'no_event_region', target_id: 'none', reviewer_id: 'r2', original_decision: 'no_event', review_decision: 'no_event', disagreement: false }],
  };
  const manifest = { schema_version: 'm5-video-manifest-v1', protocol_version: 'M5-PROTOCOL-V1', research_run_id: 'R', platform, video_file: 'video.mp4', navigation_log_file: 'R.jsonl', walking_window_id: 'W' };
  return { rows, annotation, manifest, criteria: { ...criteria }, videoExists: true, logFile: 'R.jsonl' };
}
const run = (f) => analyzeM5(f);
const check = (name, f, status, count = null, rate = undefined) => {
  const result = run(f);
  assert.equal(result.status, status, `${name}: ${result.diagnostic_reason}`);
  if (count !== null) assert.equal(result.accepted_episode_count, count, name);
  if (rate !== undefined) assert.equal(result.m5_events_per_min, rate, name);
  else if (status !== 'OK') assert.equal(result.m5_events_per_min, null, name);
  process.stdout.write(`PASS ${name}\n`);
  return result;
};
const episode = (id, a, b, c, d, decision = 'accepted', reason = '') => ({ episode_id: id, stall_start_video_ms: a, stall_end_video_ms: b, catchup_start_video_ms: c, catchup_end_video_ms: d, decision, reason, reviewer_id: 'r1' });
const addEpisode = (f, ep) => {
  f.annotation.episodes.push(ep);
  f.annotation.reviews.push({ target_type: 'episode', target_id: ep.episode_id, reviewer_id: 'r2', original_decision: ep.decision, review_decision: ep.decision, disagreement: false });
  f.annotation.no_event_regions = [];
  f.annotation.reviews = f.annotation.reviews.filter((x) => x.target_type !== 'no_event_region');
  const sorted = f.annotation.episodes.map((x) => [x.stall_start_video_ms, x.catchup_end_video_ms ?? x.stall_end_video_ms]).sort((a, b) => a[0] - b[0]);
  let start = 2000;
  for (let i = 0; i <= sorted.length; i++) {
    const end = i < sorted.length ? sorted[i][0] : 12000;
    if (end > start) {
      const id = `n${i}`;
      f.annotation.no_event_regions.push({ region_id: id, start_video_ms: start, end_video_ms: end });
      f.annotation.reviews.push({ target_type: 'no_event_region', target_id: id, reviewer_id: 'r2', original_decision: 'no_event', review_decision: 'no_event', disagreement: false });
    }
    if (i < sorted.length) start = sorted[i][1];
  }
};
check('A/X valid zero web', fixture(), 'OK', 0, 0);
check('W valid zero mobile', fixture('mobile'), 'OK', 0, 0);
for (const platform of ['web', 'mobile']) {
  const f = fixture(platform); addEpisode(f, episode('one', 3000, 4000, 4200, 4700));
  check(`B/V one episode ${platform}`, f, 'OK', 1, 6);
}
{
  const f = fixture(); addEpisode(f, episode('one', 3000, 4000, 4200, 4700)); addEpisode(f, episode('two', 7000, 8000, 8200, 8700));
  check('C separated episodes', f, 'OK', 2, 12);
}
{
  const f = fixture(); addEpisode(f, episode('long', 3000, 7000, 7100, 9000));
  check('D one continuous episode', f, 'OK', 1, 6);
}
{
  const f = fixture(); f.annotation.segments.push({ segment_id: 'stop', start_video_ms: 4000, end_video_ms: 6000, kind: 'physical_stop', evidence_source: 'timestamped_observer_annotation', evidence_note: 'synthetic stop' });
  addEpisode(f, episode('stopped', 4200, 5000, 5200, 5500, 'rejected', 'physical stop'));
  const result = check('E physical stop excluded', f, 'OK', 0, 0);
  assert.equal(result.excluded_physical_stop_s, 2);
}
{
  const f = fixture(); addEpisode(f, episode('stall', 3000, 4000, null, null, 'rejected', 'STALL_WITHOUT_CATCHUP'));
  const result = check('F stall without catchup', f, 'OK', 0, 0);
  assert.equal(result.stall_without_catchup_count, 1);
}
{
  const f = fixture(); addEpisode(f, episode('late', 10500, 11500, 12200, 12500, 'rejected', 'after walking boundary'));
  check('G catchup after window rejected', f, 'OK', 0, 0);
}
{
  const f = fixture(); addEpisode(f, episode('camera', 3000, 4000, 4200, 4700, 'rejected', 'CAMERA_CONFOUND'));
  check('H camera confound rejected', f, 'OK', 0, 0);
}
{
  const f = fixture(); f.annotation.segments.push({ segment_id: 'hidden', start_video_ms: 4000, end_video_ms: 6000, kind: 'unverifiable', evidence_source: 'screen_video', evidence_note: 'synthetic occlusion' });
  const result = check('I unobservable excluded', f, 'OK', 0, 0);
  assert.equal(result.excluded_unverifiable_s, 2);
  f.criteria.min_video_coverage_ratio = 0.9;
  check('J insufficient coverage', f, 'UNVERIFIABLE_VIDEO');
}
{ const f = fixture(); f.videoExists = false; check('K missing video', f, 'NO_VIDEO'); }
{ const f = fixture(); f.manifest.research_run_id = 'OTHER'; check('L wrong run', f, 'VIDEO_RUN_MISMATCH'); }
{ const f = fixture(); f.annotation.sync_points.pop(); check('M missing sync', f, 'VIDEO_SYNC_INVALID'); }
check('N two valid sync points', fixture(), 'OK', 0, 0);
{ const f = fixture(); f.annotation.sync_points[1].video_ms = 13500; check('O excessive drift', f, 'VIDEO_SYNC_INVALID'); }
{ const f = fixture(); f.criteria.min_stall_duration_ms = null; check('P missing criteria', f, 'M5_CRITERIA_MISSING'); }
{ const f = fixture(); f.annotation.segments[0].evidence_source = 'screen_video'; check('Q no independent walking evidence', f, 'PHYSICAL_WALKING_EVIDENCE_MISSING'); }
{
  const f = fixture(); addEpisode(f, episode('one', 3000, 4000, 4200, 4700));
  const review = f.annotation.reviews.find((x) => x.target_id === 'one');
  review.review_decision = 'rejected';
  review.disagreement = true;
  check('R unresolved disagreement', f, 'REVIEW_INCOMPLETE');
  review.adjudicated_decision = 'accepted'; review.adjudication_reason = 'synthetic video review';
  check('S adjudicated accepted', f, 'OK', 1, 6);
}
{ const f = fixture(); f.rows.at(-1).dropped_events = 1; f.rows.at(-1).dropped_by_event = { video_sync_marker: 1 }; f.rows.at(-1).event_seq += 1; check('T dropped sync', f, 'DROPPED_EVENTS'); }
{
  const f = fixture(); f.rows.splice(6, 0, { event: 'lifecycle_state_changed', monotonic_us: 6_000_000, lifecycle_state: 'paused', research_run_id: 'R', platform: 'web' }, { event: 'lifecycle_state_changed', monotonic_us: 7_000_000, lifecycle_state: 'resumed', research_run_id: 'R', platform: 'web' });
  f.rows.forEach((x, i) => { x.event_seq = i + 1; });
  const result = check('U lifecycle subtracted', f, 'OK', 0, 0);
  assert.equal(result.excluded_lifecycle_s, 1);
}
{ const f = fixture(); f.annotation.video_review_complete = false; check('Y incomplete review null', f, 'REVIEW_INCOMPLETE'); }
{ const f = fixture(); f.rows = f.rows.filter((x) => x.event !== 'walking_window_stop'); f.rows.forEach((x, i) => { x.event_seq = i + 1; }); check('missing M4 walking stop', f, 'NO_WALKING_WINDOW'); }
{ const f = fixture(); f.rows = f.rows.filter((x) => x.event !== 'logger_health'); check('incomplete log health', f, 'INCOMPLETE_LOG'); }
{ const f = fixture(); f.annotation.reviews = []; check('missing negative-region second review', f, 'REVIEW_INCOMPLETE'); }
{ const f = fixture(); f.criteria.min_verified_walking_duration_ms = 11000; check('insufficient verified walking', f, 'INSUFFICIENT_VERIFIED_WALKING_TIME'); }
{ const f = fixture(); f.annotation.sync_points[1].sync_id = 'A'; check('duplicate annotated sync ID', f, 'VIDEO_SYNC_INVALID'); }
{
  const dir = mkdtempSync(join(tmpdir(), 'm5-synthetic-'));
  try {
    const f = fixture();
    const log = join(dir, 'R.jsonl'), annotation = join(dir, 'annotation.json');
    const manifest = join(dir, 'manifest.json'), criteriaFile = join(dir, 'criteria.json');
    const video = join(dir, 'synthetic-placeholder.mp4');
    f.manifest.video_file = video;
    f.annotation.video_file = video;
    writeFileSync(video, 'synthetic placeholder; no real video evidence');
    writeFileSync(log, `${f.rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    writeFileSync(annotation, JSON.stringify(f.annotation));
    writeFileSync(manifest, JSON.stringify(f.manifest));
    writeFileSync(criteriaFile, JSON.stringify(f.criteria));
    const cli = spawnSync(process.execPath, ['scripts/analyze-m5.mjs', '--log', log, '--annotation', annotation, '--manifest', manifest, '--criteria', criteriaFile], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).m5_events_per_min, 0);
    process.stdout.write('PASS synthetic JSONL/annotation CLI round trip\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.stdout.write('M5 synthetic analyzer fixtures passed\n');
