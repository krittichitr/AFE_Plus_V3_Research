import { haversineDistanceMeters } from './distance';

export const DISTANCE_RULE_VERSION = 'm3-distance-quality-v1';

export type DistanceRuleConfig = {
  schema: 'm3-distance-quality-config-v1';
  distance_rule_version: typeof DISTANCE_RULE_VERSION;
  max_accuracy_m: number | null;
  max_speed_mps: number | null;
  min_source_delta_ms: number | null;
  max_source_gap_ms: number | null;
  stationary_deadband_m: number | null;
  startup_ready_rule: { min_consecutive_acceptable_samples: number } | null;
};

export const CALIBRATION_DISTANCE_RULE: DistanceRuleConfig = {
  schema: 'm3-distance-quality-config-v1',
  distance_rule_version: DISTANCE_RULE_VERSION,
  max_accuracy_m: null,
  max_speed_mps: null,
  min_source_delta_ms: null,
  max_source_gap_ms: null,
  stationary_deadband_m: null,
  startup_ready_rule: null,
};

export type DistanceObservation = {
  targetSampleId: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  sourceTimestamp: number;
};

export type DistanceValidationStatus =
  | 'CALIBRATION_UNCONFIGURED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'UNRESOLVED';

export type DistanceSegmentDiagnostic = {
  distance_rule_version: typeof DISTANCE_RULE_VERSION;
  from_target_sample_id: string;
  to_target_sample_id: string;
  from_sequence: number;
  to_sequence: number;
  segment_distance_m: number | null;
  segment_dt_s: number | null;
  segment_speed_mps: number | null;
  accuracy_from_m: number | null;
  accuracy_to_m: number | null;
  source_timestamp_from_ms: number;
  source_timestamp_to_ms: number;
  raw_cumulative_distance_m: number;
  validated_cumulative_distance_m: number | null;
  segment_validation_status: DistanceValidationStatus;
  segment_valid_for_distance: boolean | null;
  intervening_rejected_observation: boolean;
  rejection_reasons: string[];
};

function validCoordinate(sample: DistanceObservation): boolean {
  return Number.isFinite(sample.latitude) && sample.latitude >= -90 && sample.latitude <= 90 &&
    Number.isFinite(sample.longitude) && sample.longitude >= -180 && sample.longitude <= 180;
}

function validLimit(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isDistanceRuleConfigured(rule: DistanceRuleConfig): boolean {
  return rule.schema === 'm3-distance-quality-config-v1' &&
    rule.distance_rule_version === DISTANCE_RULE_VERSION &&
    validLimit(rule.max_accuracy_m) &&
    validLimit(rule.max_speed_mps) &&
    validLimit(rule.min_source_delta_ms) &&
    validLimit(rule.max_source_gap_ms) &&
    validLimit(rule.stationary_deadband_m) &&
    rule.max_source_gap_ms >= rule.min_source_delta_ms &&
    rule.startup_ready_rule !== null &&
    Number.isSafeInteger(rule.startup_ready_rule.min_consecutive_acceptable_samples) &&
    rule.startup_ready_rule.min_consecutive_acceptable_samples > 0;
}

export function evaluateDistanceSegment(input: {
  from: DistanceObservation;
  to: DistanceObservation;
  rawCumulativeDistanceM: number;
  previousValidatedDistanceM: number | null;
  startupReady: boolean;
  interveningRejectedObservation?: boolean;
  rule: DistanceRuleConfig;
}): DistanceSegmentDiagnostic {
  const { from, to, rule } = input;
  const reasons: string[] = [];
  const coordinatesValid = validCoordinate(from) && validCoordinate(to);
  const distanceM = coordinatesValid ? haversineDistanceMeters(from, to) : null;
  if (!coordinatesValid) reasons.push('INVALID_COORDINATE');

  const timesFinite = Number.isFinite(from.sourceTimestamp) && Number.isFinite(to.sourceTimestamp);
  const deltaMs = timesFinite ? to.sourceTimestamp - from.sourceTimestamp : null;
  if (!timesFinite || deltaMs === null || deltaMs <= 0) reasons.push('INVALID_OR_NONMONOTONIC_SOURCE_TIME');
  const speedMps = distanceM !== null && deltaMs !== null && deltaMs > 0
    ? distanceM / (deltaMs / 1000) : null;
  const accuracyKnown = from.accuracy !== null && to.accuracy !== null &&
    Number.isFinite(from.accuracy) && Number.isFinite(to.accuracy) &&
    from.accuracy >= 0 && to.accuracy >= 0;
  if (!accuracyKnown) reasons.push('UNKNOWN_OR_POOR_ACCURACY');
  if (input.interveningRejectedObservation) reasons.push('UNRESOLVED_DISTANCE_GAP');

  const configured = isDistanceRuleConfigured(rule);
  if (!configured) {
    reasons.push('CALIBRATION_UNCONFIGURED');
    return {
      distance_rule_version: DISTANCE_RULE_VERSION,
      from_target_sample_id: from.targetSampleId,
      to_target_sample_id: to.targetSampleId,
      from_sequence: from.sequence,
      to_sequence: to.sequence,
      segment_distance_m: distanceM,
      segment_dt_s: deltaMs === null ? null : deltaMs / 1000,
      segment_speed_mps: speedMps,
      accuracy_from_m: from.accuracy,
      accuracy_to_m: to.accuracy,
      source_timestamp_from_ms: from.sourceTimestamp,
      source_timestamp_to_ms: to.sourceTimestamp,
      raw_cumulative_distance_m: input.rawCumulativeDistanceM,
      validated_cumulative_distance_m: null,
      segment_validation_status: 'CALIBRATION_UNCONFIGURED',
      segment_valid_for_distance: null,
      intervening_rejected_observation: input.interveningRejectedObservation === true,
      rejection_reasons: reasons,
    };
  }

  if (accuracyKnown && (from.accuracy! > rule.max_accuracy_m! || to.accuracy! > rule.max_accuracy_m!)) {
    reasons.push('UNKNOWN_OR_POOR_ACCURACY');
  }
  if (deltaMs !== null && deltaMs > 0 && deltaMs < rule.min_source_delta_ms!) {
    reasons.push('SOURCE_DELTA_TOO_SHORT');
  }
  if (deltaMs !== null && deltaMs > rule.max_source_gap_ms!) {
    reasons.push('LONG_GAP_REACQUISITION');
  }
  if (speedMps !== null && speedMps > rule.max_speed_mps!) {
    reasons.push('IMPLAUSIBLE_SPEED');
  }
  if (!input.startupReady) reasons.push('STARTUP_NOT_STABLE');
  if (distanceM !== null && distanceM <= rule.stationary_deadband_m!) {
    reasons.push('STATIONARY_RULE');
  }
  if (reasons.length > 0 && distanceM !== null && distanceM > 0 &&
      reasons.some((reason) => reason !== 'STATIONARY_RULE')) {
    reasons.push('UNRESOLVED_DISTANCE_GAP');
  }

  const accepted = reasons.length === 0;
  const unresolved = reasons.includes('UNRESOLVED_DISTANCE_GAP');
  return {
    distance_rule_version: DISTANCE_RULE_VERSION,
    from_target_sample_id: from.targetSampleId,
    to_target_sample_id: to.targetSampleId,
    from_sequence: from.sequence,
    to_sequence: to.sequence,
    segment_distance_m: distanceM,
    segment_dt_s: deltaMs === null ? null : deltaMs / 1000,
    segment_speed_mps: speedMps,
    accuracy_from_m: from.accuracy,
    accuracy_to_m: to.accuracy,
    source_timestamp_from_ms: from.sourceTimestamp,
    source_timestamp_to_ms: to.sourceTimestamp,
    raw_cumulative_distance_m: input.rawCumulativeDistanceM,
    validated_cumulative_distance_m: input.previousValidatedDistanceM === null
      ? null : input.previousValidatedDistanceM + (accepted && distanceM !== null ? distanceM : 0),
    segment_validation_status: accepted ? 'ACCEPTED' : unresolved ? 'UNRESOLVED' : 'REJECTED',
    segment_valid_for_distance: accepted,
    intervening_rejected_observation: input.interveningRejectedObservation === true,
    rejection_reasons: Array.from(new Set(reasons)),
  };
}
