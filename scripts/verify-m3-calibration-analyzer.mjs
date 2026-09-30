#!/usr/bin/env node
import assert from 'node:assert/strict';
import { analyzeRun, validateCriteria } from './analyze-m3.mjs';
import { summarizeM3Calibration } from './m3-calibration-core.mjs';
import { haversineMeters } from './m3-haversine.mjs';

const runId = 'CAL-M3-FIXTURE';
const navSession = 'nav-fixture';
const senderSession = 'sender-fixture';
const t0 = 1_700_000_000_000;
const coord1 = { lat: 16.7, lng: 100.1 };
const coord2 = { lat: 16.70001, lng: 100.10001 };
const distance = haversineMeters(coord1, coord2);
const sampleId = (index) => senderSession + ':T' + String(index).padStart(6, '0');
const subprobes = (at) => [0, 1, 2].map((probe_index) => ({
  probe_index, success: true, client_send_wall_ms: at,
  client_receive_wall_ms: at + 100, client_send_mono_ms: probe_index,
  client_receive_mono_ms: probe_index + 100, server_wall_clock_ms: at + 50,
  rtt_ms: 100, monotonic_rtt_ms: 100, estimated_clock_offset_ms: 0,
  failure_reason: null,
}));
const sync = (index, offset, side) => ({
  event: 'clock_sync', sync_index: index, sync_phase: index === 0 ? 'initial' : 'periodic',
  scheduled_mono_ms: index * 60_000, actual_start_mono_ms: index * 60_000,
  actual_end_mono_ms: index * 60_000 + 100,
  research_run_id: runId, ...(side === 'sender' ? { sender_session_id: senderSession } : {}),
  success: true, rtt_ms: 100, selected_rtt_ms: 100,
  estimated_clock_offset_ms: offset, estimated_offset_ms: offset,
  selected_probe_index: 0, subprobes: subprobes(t0 + index * 60_000),
  client_send_wall_ms: t0 + index * 60_000,
  client_receive_wall_ms: t0 + index * 60_000 + 100,
  server_wall_clock_ms: t0 + index * 60_000 + 50,
  wall_clock_utc: new Date(t0 + index * 60_000).toISOString(),
  wall_clock_ms: t0 + index * 60_000,
});
const navEvents = [
  { event: 'run_start', research_run_id: runId, event_seq: 1, wall_clock_ms: t0 },
  sync(0, 10, 'navigation'),
  { event: 'route_active', research_run_id: runId, session_id: navSession,
    event_seq: 3, route_update_id: 'route-1', route_activation_seq: 1,
    wall_clock_ms: t0 + 1000, target_sample_id: sampleId(1),
    target_ref_lat: coord1.lat, target_ref_lng: coord1.lng },
  sync(1, 30, 'navigation'),
  { event: 'run_stop', research_run_id: runId, event_seq: 5 },
];
const senderEvents = [
  { event: 'sender_start', research_run_id: runId, sender_session_id: senderSession },
  sync(0, -5, 'sender'),
  { event: 'target_sample', research_run_id: runId, sender_session_id: senderSession,
    target_sample_id: sampleId(1), sequence: 1, callback_index: 1,
    target_lat: coord1.lat, target_lng: coord1.lng,
    source_timestamp_ms: t0 + 1000, accuracy_m: 5, cumulative_distance_m: 0,
    raw_cumulative_distance_m: 0, validated_cumulative_distance_m: null,
    distance_rule_version: 'm3-distance-quality-v1' },
  { event: 'gps_segment_diagnostic', research_run_id: runId, sender_session_id: senderSession,
    from_target_sample_id: sampleId(1), to_target_sample_id: sampleId(2),
    from_sequence: 1, to_sequence: 2, segment_distance_m: distance, segment_dt_s: 1,
    segment_speed_mps: distance, accuracy_from_m: 5, accuracy_to_m: 5,
    source_timestamp_from_ms: t0 + 1000, source_timestamp_to_ms: t0 + 2000,
    raw_cumulative_distance_m: distance, validated_cumulative_distance_m: null,
    segment_validation_status: 'CALIBRATION_UNCONFIGURED',
    segment_valid_for_distance: null, intervening_rejected_observation: false,
    rejection_reasons: ['CALIBRATION_UNCONFIGURED'],
    distance_rule_version: 'm3-distance-quality-v1' },
  { event: 'target_sample', research_run_id: runId, sender_session_id: senderSession,
    target_sample_id: sampleId(2), sequence: 2, callback_index: 2,
    target_lat: coord2.lat, target_lng: coord2.lng,
    source_timestamp_ms: t0 + 2000, accuracy_m: 5, cumulative_distance_m: distance,
    raw_cumulative_distance_m: distance, validated_cumulative_distance_m: null,
    distance_rule_version: 'm3-distance-quality-v1' },
  sync(1, 15, 'sender'),
  { event: 'sender_stop', research_run_id: runId, sender_session_id: senderSession },
];
const manifest = {
  schema_version: 'm3-manifest-v1', protocol_version: 'M3-PROTOCOL-V1',
  research_run_id: runId, system: 'D-TANS', navigation_session_id: navSession,
  sender_session_id: senderSession, navigation_log_file: 'nav.jsonl',
  sender_trace_file: 'sender.jsonl', distance_rule_version: 'm3-distance-quality-v1',
};
const nullCriteria = {
  schema_version: 'm3-criteria-v1', max_rtt_ms: null, max_clock_uncertainty_ms: null,
  max_clock_drift_ms: null, max_route_reference_match_distance_m: null,
};
const numericFixtureCriteria = {
  schema_version: 'm3-criteria-v1', max_rtt_ms: 200, max_clock_uncertainty_ms: 300,
  max_clock_drift_ms: 50, max_route_reference_match_distance_m: 0,
};
assert.equal(validateCriteria(nullCriteria).missing, true);
const calibration = summarizeM3Calibration({ navigationEvents: navEvents, senderEvents, manifest });
assert.equal(calibration.mode, 'CALIBRATION_ONLY_NO_OFFICIAL_M3');
assert.equal(calibration.distance_rule_match, 'MATCH');
assert.equal(calibration.clock.navigation.round_count, 2);
assert.equal(calibration.clock.sender.round_count, 2);
assert.equal(calibration.clock.navigation.subprobe_count, 6);
assert.equal(calibration.clock.sender.offset_changes[0].change_ms, 20);
assert.equal(calibration.clock.sender.anchor_spacing_ms.max, 60_000);
assert.equal(calibration.gps.diagnostic_count, 1);
assert.deepEqual(calibration.gps.diagnostic_consistency_issues, []);
assert.equal(calibration.gps.validated_cumulative_distance_m, null);
const officialNull = analyzeRun({ navigationEvents: navEvents, senderEvents, manifest, criteria: nullCriteria });
assert.equal(officialNull.results[0].status, 'CLOCK_SYNC_CRITERIA_MISSING');
assert.ok(officialNull.results.every((row) => row.m3_distance_m === null));
assert.equal(officialNull.calibration_diagnostics.clock.navigation.round_count, 2);
const officialNumeric = analyzeRun({ navigationEvents: navEvents, senderEvents, manifest, criteria: numericFixtureCriteria });
assert.equal(officialNumeric.results[0].status, 'DISTANCE_QUALITY_UNCONFIGURED');
assert.ok(officialNumeric.results.every((row) => row.m3_distance_m === null));
const mismatch = analyzeRun({
  navigationEvents: navEvents, senderEvents,
  manifest: { ...manifest, distance_rule_version: 'other-rule' }, criteria: numericFixtureCriteria,
});
assert.equal(mismatch.results[0].status, 'DISTANCE_RULE_MISMATCH');
assert.equal(mismatch.summary.run_validity, 'INVALID');
const badDiagnostic = senderEvents.map((event) =>
  event.event === 'gps_segment_diagnostic' ? { ...event, segment_distance_m: distance + 10 } : event);
const bad = analyzeRun({ navigationEvents: navEvents, senderEvents: badDiagnostic, manifest, criteria: numericFixtureCriteria });
assert.equal(bad.results[0].status, 'DISTANCE_DIAGNOSTIC_INVALID');
const omittedDiagnostic = senderEvents.filter((event) => event.event !== 'gps_segment_diagnostic');
assert.ok(summarizeM3Calibration({ navigationEvents: navEvents, senderEvents: omittedDiagnostic, manifest })
  .gps.diagnostic_consistency_issues.some((issue) => issue.startsWith('MISSING_SEGMENT_DIAGNOSTIC')));
const withRejectedCallback = senderEvents.map((event) =>
  event.event === 'target_sample' && event.sequence === 2 ? { ...event, callback_index: 3 } : event);
withRejectedCallback.splice(3, 0, {
  event: 'gps_observation_rejected', research_run_id: runId, sender_session_id: senderSession,
  callback_index: 2, rejection_reason: 'GEOLOCATION_ERROR',
});
assert.ok(summarizeM3Calibration({ navigationEvents: navEvents, senderEvents: withRejectedCallback, manifest })
  .gps.diagnostic_consistency_issues.some((issue) => issue.startsWith('REJECTED_CALLBACK_GAP_MISMATCH')));
const markedGap = withRejectedCallback.map((event) => event.event === 'gps_segment_diagnostic'
  ? { ...event, intervening_rejected_observation: true } : event);
assert.deepEqual(summarizeM3Calibration({ navigationEvents: navEvents, senderEvents: markedGap, manifest })
  .gps.diagnostic_consistency_issues, []);
const badRawSum = senderEvents.map((event) => event.event === 'target_sample' && event.sequence === 2
  ? { ...event, cumulative_distance_m: distance + 1, raw_cumulative_distance_m: distance + 1 } : event);
assert.ok(summarizeM3Calibration({ navigationEvents: navEvents, senderEvents: badRawSum, manifest })
  .gps.diagnostic_consistency_issues.some((issue) => issue.startsWith('RAW_CUMULATIVE_INCREMENT_MISMATCH')));
const legacySender = senderEvents.filter((event) => event.event !== 'gps_segment_diagnostic' && event.sync_index !== 1)
  .map((event) => event.event === 'target_sample'
    ? Object.fromEntries(Object.entries(event).filter(([key]) => ![
      'raw_cumulative_distance_m', 'validated_cumulative_distance_m', 'distance_rule_version',
    ].includes(key))) : event);
const legacyNav = navEvents.filter((event) => event.sync_index !== 1);
const legacy = summarizeM3Calibration({
  navigationEvents: legacyNav, senderEvents: legacySender,
  manifest: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'distance_rule_version')),
});
assert.equal(legacy.gps.format, 'legacy_raw_only');
assert.equal(legacy.clock.navigation.round_count, 1);
assert.equal(legacy.distance_rule_match, 'LEGACY_NO_DECLARATION');
assert.equal(legacy.mode, 'CALIBRATION_ONLY_NO_OFFICIAL_M3');

console.log('PASS: M3 calibration analyzer parses all anchors/subprobes, verifies diagnostics, detects mismatches, preserves legacy, and blocks official results');
