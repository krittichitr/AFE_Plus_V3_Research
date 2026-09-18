export interface TargetSenderIdentity {
  usersId: number;
  takecareId: number;
}

export interface TargetGpsSample {
  senderSessionId: string;
  targetSampleId: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  altitude: number | null;
  sourceTimestamp: number;
}

export interface TargetSafezone {
  latitude: number;
  longitude: number;
}

export interface SendTargetLocationInput {
  identity: TargetSenderIdentity;
  sample: TargetGpsSample;
  distanceFromSafezoneM: number;
  batteryPercent: number;
  signal?: AbortSignal;
}
