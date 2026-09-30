import { haversineMeters, isValidLatLng } from './m3-haversine.mjs';

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, median: null, p95: null, p99: null, max: null };
  const quantile = (fraction) => {
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (position - low);
  };
  return {
    n: sorted.length, min: sorted[0], median: quantile(0.5),
    p95: quantile(0.95), p99: quantile(0.99), max: sorted[sorted.length - 1],
  };
}

function clockSeries(events) {
  const rounds = events.filter((event) => event?.event === 'clock_sync');
  const incomplete = events.filter((event) => event?.event === 'clock_sync_incomplete');
  const valid = rounds.filter((event) =>
    event.success === true && Number.isFinite(event.estimated_clock_offset_ms) &&
    Number.isFinite(event.rtt_ms));
  const offsets = valid.map((event) => event.estimated_clock_offset_ms);
  const offsetChanges = valid.slice(1).map((event, index) => ({
    from_sync_index: valid[index].sync_index ?? index,
    to_sync_index: event.sync_index ?? index + 1,
    change_ms: event.estimated_clock_offset_ms - valid[index].estimated_clock_offset_ms,
  }));
  const anchorGaps = valid.slice(1).map((event, index) => {
    const previous = valid[index];
    const bothMonotonic = Number.isFinite(event.actual_start_mono_ms) &&
      Number.isFinite(previous.actual_start_mono_ms);
    const currentTime = bothMonotonic ? event.actual_start_mono_ms : event.client_send_wall_ms;
    const previousTime = bothMonotonic ? previous.actual_start_mono_ms : previous.client_send_wall_ms;
    return currentTime - previousTime;
  }).filter(Number.isFinite);
  return {
    round_count: rounds.length,
    successful_rounds: valid.length,
    failed_rounds: rounds.length - valid.length,
    incomplete_rounds: incomplete,
    rounds,
    subprobe_count: rounds.reduce((count, event) => count + (Array.isArray(event.subprobes) ? event.subprobes.length : 0), 0),
    rtt_ms: distribution(rounds.map((event) => event.rtt_ms)),
    offset_ms: distribution(offsets),
    offset_changes: offsetChanges,
    anchor_spacing_ms: distribution(anchorGaps),
    max_observed_successful_anchor_gap_ms: anchorGaps.length ? Math.max(...anchorGaps) : null,
    wall_monotonic_rtt_deltas_ms: rounds.flatMap((event) =>
      Array.isArray(event.subprobes)
        ? event.subprobes.filter((probe) => Number.isFinite(probe.rtt_ms) && Number.isFinite(probe.monotonic_rtt_ms))
          .map((probe) => ({ sync_index: event.sync_index, probe_index: probe.probe_index,
            wall_minus_monotonic_ms: probe.rtt_ms - probe.monotonic_rtt_ms }))
        : []),
    format: rounds.some((event) => Number.isInteger(event.sync_index) && Array.isArray(event.subprobes))
      ? 'indexed_detailed' : 'legacy_selected_only',
  };
}

function gpsSeries(events) {
  const samples = events.filter((event) => event?.event === 'target_sample')
    .sort((a, b) => a.sequence - b.sequence);
  const diagnostics = events.filter((event) => event?.event === 'gps_segment_diagnostic');
  const rejectedCallbacks = events.filter((event) => event?.event === 'gps_observation_rejected');
  const phases = events.filter((event) => event?.event === 'calibration_phase');
  const hasNewFormat = diagnostics.length > 0 || samples.some((sample) => sample.distance_rule_version);
  const issues = [];
  const diagnosticByPair = new Map();
  for (const sample of samples) {
    if (Number.isFinite(sample.raw_cumulative_distance_m) &&
        Math.abs(sample.raw_cumulative_distance_m - sample.cumulative_distance_m) > 1e-9) {
      issues.push('RAW_CUMULATIVE_ALIAS_MISMATCH:' + sample.target_sample_id);
    }
    if (sample.distance_quality_status === 'CALIBRATION_UNCONFIGURED' &&
        sample.validated_cumulative_distance_m !== null) {
      issues.push('UNCONFIGURED_SAMPLE_DISTANCE_FABRICATED:' + sample.target_sample_id);
    }
  }
  for (const diagnostic of diagnostics) {
    const key = String(diagnostic.from_target_sample_id) + '|' + String(diagnostic.to_target_sample_id);
    if (diagnosticByPair.has(key)) issues.push('DUPLICATE_SEGMENT_DIAGNOSTIC:' + key);
    diagnosticByPair.set(key, diagnostic);
  }
  const segmentDistances = [];
  const deltas = [];
  const speeds = [];
  let nonpositiveTimeCount = 0;
  for (let index = 1; index < samples.length; index++) {
    const from = samples[index - 1];
    const to = samples[index];
    const pairKey = String(from.target_sample_id) + '|' + String(to.target_sample_id);
    const coordValid = isValidLatLng({ lat: from.target_lat, lng: from.target_lng }) &&
      isValidLatLng({ lat: to.target_lat, lng: to.target_lng });
    const distance = coordValid
      ? haversineMeters({ lat: from.target_lat, lng: from.target_lng }, { lat: to.target_lat, lng: to.target_lng })
      : null;
    const dt = Number.isFinite(from.source_timestamp_ms) && Number.isFinite(to.source_timestamp_ms)
      ? (to.source_timestamp_ms - from.source_timestamp_ms) / 1000 : null;
    if (distance !== null) segmentDistances.push(distance);
    if (distance !== null && Number.isFinite(from.cumulative_distance_m) &&
        (!Number.isFinite(to.cumulative_distance_m) ||
        Math.abs(to.cumulative_distance_m - from.cumulative_distance_m - distance) > 1e-6))
      issues.push('RAW_CUMULATIVE_INCREMENT_MISMATCH:' + pairKey);
    if (dt !== null) {
      deltas.push(dt);
      if (dt <= 0) nonpositiveTimeCount += 1;
      if (dt > 0 && distance !== null) speeds.push(distance / dt);
    }
    if (!hasNewFormat) continue;
    const diagnostic = diagnosticByPair.get(pairKey);
    if (!diagnostic) {
      issues.push('MISSING_SEGMENT_DIAGNOSTIC:' + pairKey);
      continue;
    }
    if (diagnostic.from_sequence !== from.sequence || diagnostic.to_sequence !== to.sequence)
      issues.push('SEGMENT_SEQUENCE_MISMATCH:' + pairKey);
    if (distance !== null && (!Number.isFinite(diagnostic.segment_distance_m) ||
        Math.abs(diagnostic.segment_distance_m - distance) > 1e-6))
      issues.push('SEGMENT_DISTANCE_MISMATCH:' + pairKey);
    if (dt !== null && (!Number.isFinite(diagnostic.segment_dt_s) ||
        Math.abs(diagnostic.segment_dt_s - dt) > 1e-9))
      issues.push('SEGMENT_TIME_MISMATCH:' + pairKey);
    const speed = dt !== null && dt > 0 && distance !== null ? distance / dt : null;
    if (speed === null ? diagnostic.segment_speed_mps !== null :
        !Number.isFinite(diagnostic.segment_speed_mps) ||
        Math.abs(diagnostic.segment_speed_mps - speed) > 1e-6)
      issues.push('SEGMENT_SPEED_MISMATCH:' + pairKey);
    if (diagnostic.accuracy_from_m !== from.accuracy_m ||
        diagnostic.accuracy_to_m !== to.accuracy_m)
      issues.push('SEGMENT_ACCURACY_MISMATCH:' + pairKey);
    if (diagnostic.source_timestamp_from_ms !== from.source_timestamp_ms ||
        diagnostic.source_timestamp_to_ms !== to.source_timestamp_ms)
      issues.push('SEGMENT_SOURCE_TIME_MISMATCH:' + pairKey);
    if (diagnostic.validated_cumulative_distance_m !== to.validated_cumulative_distance_m)
      issues.push('SEGMENT_VALIDATED_CUMULATIVE_MISMATCH:' + pairKey);
    if (diagnostic.distance_rule_version !== to.distance_rule_version)
      issues.push('SEGMENT_RULE_VERSION_MISMATCH:' + pairKey);
    if (Number.isFinite(diagnostic.raw_cumulative_distance_m) &&
        Math.abs(diagnostic.raw_cumulative_distance_m - to.cumulative_distance_m) > 1e-9)
      issues.push('DIAGNOSTIC_RAW_CUMULATIVE_MISMATCH:' + pairKey);
    if (diagnostic.segment_validation_status === 'CALIBRATION_UNCONFIGURED' &&
        (diagnostic.validated_cumulative_distance_m !== null || diagnostic.segment_valid_for_distance !== null))
      issues.push('UNCONFIGURED_DISTANCE_FABRICATED:' + pairKey);
    if (Number.isSafeInteger(from.callback_index) && Number.isSafeInteger(to.callback_index)) {
      if (to.callback_index <= from.callback_index)
        issues.push('CALLBACK_INDEX_NONMONOTONIC:' + pairKey);
      const hadRejectedCallback = rejectedCallbacks.some((event) =>
        Number.isSafeInteger(event.callback_index) &&
        event.callback_index > from.callback_index && event.callback_index < to.callback_index);
      if (diagnostic.intervening_rejected_observation !== hadRejectedCallback)
        issues.push('REJECTED_CALLBACK_GAP_MISMATCH:' + pairKey);
    }
  }
  if (hasNewFormat && diagnostics.length !== Math.max(0, samples.length - 1))
    issues.push('SEGMENT_DIAGNOSTIC_COUNT_MISMATCH');
  const versions = [...new Set([
    ...samples.map((sample) => sample.distance_rule_version).filter(Boolean),
    ...diagnostics.map((diagnostic) => diagnostic.distance_rule_version).filter(Boolean),
  ])];
  const last = samples.at(-1);
  return {
    format: hasNewFormat ? 'distance_diagnostics_v1' : 'legacy_raw_only',
    sample_count: samples.length,
    segment_count: Math.max(0, samples.length - 1),
    diagnostic_count: diagnostics.length,
    rejected_callback_count: rejectedCallbacks.length,
    rejected_callbacks: rejectedCallbacks,
    calibration_phases: phases,
    distance_rule_versions: versions,
    raw_cumulative_distance_m: last?.raw_cumulative_distance_m ?? last?.cumulative_distance_m ?? null,
    validated_cumulative_distance_m: last?.validated_cumulative_distance_m ?? null,
    validation_status_counts: diagnostics.reduce((counts, item) => {
      const status = item.segment_validation_status ?? 'MISSING';
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    unresolved_segment_count: diagnostics.filter((item) => item.segment_validation_status === 'UNRESOLVED').length,
    nonpositive_source_time_count: nonpositiveTimeCount,
    segment_distance_m: distribution(segmentDistances),
    segment_dt_s: distribution(deltas),
    segment_speed_mps: distribution(speeds),
    accuracy_m: distribution(samples.map((sample) => sample.accuracy_m)),
    diagnostic_consistency_issues: issues,
  };
}

export function summarizeM3Calibration({ navigationEvents, senderEvents, manifest = null }) {
  const gps = gpsSeries(senderEvents);
  const navClock = clockSeries(navigationEvents);
  const senderClock = clockSeries(senderEvents);
  const manifestVersion = manifest?.distance_rule_version ?? null;
  const versions = gps.distance_rule_versions;
  const distanceRuleMatch = manifestVersion === null
    ? (versions.length === 0 ? 'LEGACY_NO_DECLARATION' : 'MANIFEST_VERSION_MISSING')
    : (versions.length === 1 && versions[0] === manifestVersion ? 'MATCH' : 'MISMATCH');
  return {
    mode: 'CALIBRATION_ONLY_NO_OFFICIAL_M3',
    manifest_distance_rule_version: manifestVersion,
    distance_rule_match: distanceRuleMatch,
    gps,
    clock: { navigation: navClock, sender: senderClock },
  };
}
