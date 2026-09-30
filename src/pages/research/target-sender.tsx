import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { haversineDistanceMeters } from '@/lib/research/targetSender/distance';
import {
  fetchTargetSafezone,
  sendTargetLocation,
  TargetSenderApiError,
} from '@/lib/research/targetSender/targetApi';
import type {
  TargetGpsSample,
  TargetSafezone,
  TargetSenderIdentity,
} from '@/lib/research/targetSender/types';
import { probeResearchClockSync } from '@/lib/research/clockSync';
import { startClockSyncSchedule, type ClockSyncSchedule, type ClockSyncRound } from '@/lib/research/clockSyncSchedule';
import { CALIBRATION_DISTANCE_RULE, DISTANCE_RULE_VERSION, evaluateDistanceSegment, type DistanceSegmentDiagnostic } from '@/lib/research/targetSender/distanceQuality';

type GpsStatus = 'Waiting' | 'Ready' | 'Error';

type SenderStartTraceRecord = {
  event: 'sender_start' | 'sender_stop';
  sender_session_id: string;
  research_run_id: string | null;
  wall_clock_utc: string;
};

type TargetSampleTraceRecord = {
  event: 'target_sample';
  sender_session_id: string;
  research_run_id: string | null;
  target_sample_id: string;
  sequence: number;
  callback_index: number;
  target_lat: number;
  target_lng: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  source_timestamp_ms: number;
  wall_clock_utc: string;
  mono_ms: number;
  cumulative_distance_m: number;
  raw_cumulative_distance_m: number;
  validated_cumulative_distance_m: number | null;
  distance_rule_version: typeof DISTANCE_RULE_VERSION;
  distance_quality_status: 'CALIBRATION_UNCONFIGURED';
};

type ClockSyncTraceRecord = {
  event: 'clock_sync';
  sender_session_id: string;
  research_run_id: string | null;
  wall_clock_utc: string;
  sync_index: number;
  sync_phase: 'initial' | 'periodic';
  failure_reason: string | null;
  [key: string]: unknown;
};

type ClockSyncIncompleteTraceRecord = {
  event: 'clock_sync_incomplete';
  sender_session_id: string;
  research_run_id: string | null;
  wall_clock_utc: string;
  reason: 'STOPPED_WITH_ROUND_IN_FLIGHT';
} & ClockSyncRound;

type GpsSegmentTraceRecord = {
  event: 'gps_segment_diagnostic';
  sender_session_id: string;
  research_run_id: string | null;
  wall_clock_utc: string;
  mono_ms: number;
} & DistanceSegmentDiagnostic;

type RejectedObservationTraceRecord = {
  event: 'gps_observation_rejected';
  sender_session_id: string;
  research_run_id: string | null;
  callback_index: number;
  wall_clock_utc: string;
  mono_ms: number;
  target_lat: number | null;
  target_lng: number | null;
  accuracy_m: number | null;
  speed_mps: number | null;
  source_timestamp_ms: number | null;
  rejection_reason: 'INVALID_COORDINATE' | 'GEOLOCATION_ERROR';
  geolocation_error_code?: number;
};

type CalibrationPhaseTraceRecord = {
  event: 'calibration_phase';
  sender_session_id: string;
  research_run_id: string | null;
  phase: 'STATIONARY_START' | 'WALK_START' | 'WALK_END' | 'STATIONARY_END';
  wall_clock_utc: string;
  mono_ms: number;
};


type TargetTraceRecord = SenderStartTraceRecord | TargetSampleTraceRecord |
  ClockSyncTraceRecord | ClockSyncIncompleteTraceRecord | GpsSegmentTraceRecord |
  RejectedObservationTraceRecord | CalibrationPhaseTraceRecord;

const LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15_000,
  maximumAge: 0,
};

// The existing V3 endpoint requires a battery value. The browser Battery Status
// API is not consistently available, so this sender uses the endpoint's accepted
// zero value rather than fabricating a battery reading.
const UNKNOWN_BATTERY_PERCENT = 0;

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function gpsValue(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sampleFromPosition(
  position: GeolocationPosition,
  senderSessionId: string,
  sequence: number,
): TargetGpsSample | null {
  const { latitude, longitude } = position.coords;
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    return null;
  }

  return {
    senderSessionId,
    targetSampleId: `${senderSessionId}:T${String(sequence).padStart(6, '0')}`,
    sequence,
    latitude,
    longitude,
    accuracy: gpsValue(position.coords.accuracy),
    speed: gpsValue(position.coords.speed),
    heading: gpsValue(position.coords.heading),
    altitude: gpsValue(position.coords.altitude),
    sourceTimestamp: position.timestamp,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof TargetSenderApiError || error instanceof Error) return error.message;
  return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export default function TargetSenderPage() {
  const router = useRouter();
  const identity = useMemo<TargetSenderIdentity | null>(() => {
    if (!router.isReady) return null;
    const usersId = positiveInteger(firstQueryValue(router.query.users_id));
    const takecareId = positiveInteger(firstQueryValue(router.query.takecare_id));
    return usersId && takecareId ? { usersId, takecareId } : null;
  }, [router.isReady, router.query.takecare_id, router.query.users_id]);

  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('Waiting');
  const [isSending, setIsSending] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [latestSample, setLatestSample] = useState<TargetGpsSample | null>(null);
  const [cumulativeDistanceM, setCumulativeDistanceM] = useState(0);
  const [validatedDistanceM, setValidatedDistanceM] = useState<number | null>(null);
  const [gpsSamples, setGpsSamples] = useState(0);
  const [successfulSends, setSuccessfulSends] = useState(0);
  const [failedSends, setFailedSends] = useState(0);
  const [traceRecordCount, setTraceRecordCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [researchRunIdInput, setResearchRunIdInput] = useState('');
  const [activeResearchRunId, setActiveResearchRunId] = useState<string | null>(null);
  const [activeSenderSessionId, setActiveSenderSessionId] = useState<string | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const sequenceRef = useRef(0);
  const senderSessionIdRef = useRef<string | null>(null);
  const researchRunIdRef = useRef<string | null>(null);
  const targetTraceRef = useRef<TargetTraceRecord[]>([]);
  const cumulativeDistanceRef = useRef(0);
  const validatedDistanceRef = useRef<number | null>(null);
  const callbackIndexRef = useRef(0);
  const interveningRejectedObservationRef = useRef(false);
  const clockSyncScheduleRef = useRef<ClockSyncSchedule | null>(null);
  const startSampleRef = useRef<TargetGpsSample | null>(null);
  const previousSampleRef = useRef<TargetGpsSample | null>(null);
  const safezoneRef = useRef<TargetSafezone | null>(null);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeSendControllerRef = useRef<AbortController | null>(null);
  const startControllerRef = useRef<AbortController | null>(null);

  const stopRuntime = useCallback(() => {
    clockSyncScheduleRef.current?.stop();
    clockSyncScheduleRef.current = null;
    activeRef.current = false;
    sessionGenerationRef.current += 1;
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    activeSendControllerRef.current?.abort();
    activeSendControllerRef.current = null;
    startControllerRef.current?.abort();
    startControllerRef.current = null;
  }, []);

  const stopSending = useCallback(() => {
    clockSyncScheduleRef.current?.stop();
    clockSyncScheduleRef.current = null;
    if (activeRef.current && senderSessionIdRef.current) {
      targetTraceRef.current.push(Object.freeze({
        event: 'sender_stop',
        sender_session_id: senderSessionIdRef.current,
        research_run_id: researchRunIdRef.current,
        wall_clock_utc: new Date().toISOString(),
      }));
      setTraceRecordCount(targetTraceRef.current.length);
    }
    stopRuntime();
    setIsStarting(false);
    setIsSending(false);
  }, [stopRuntime]);

  useEffect(() => () => stopRuntime(), [stopRuntime]);

  const beginSenderClockSync = useCallback((
    senderSessionId: string,
    capturedRunId: string | null,
    sessionGeneration: number,
  ) => {
    clockSyncScheduleRef.current?.stop();
    clockSyncScheduleRef.current = startClockSyncSchedule({
      probe: probeResearchClockSync,
      record: (round, result, failureReason) => {
        if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration ||
            senderSessionIdRef.current !== senderSessionId) return;
        targetTraceRef.current.push(Object.freeze({
          event: 'clock_sync',
          sender_session_id: senderSessionId,
          research_run_id: capturedRunId,
          ...round,
          ...(result ?? {
            success: false,
            server_wall_clock_ms: null,
            client_send_wall_ms: null,
            client_receive_wall_ms: null,
            rtt_ms: null,
            estimated_clock_offset_ms: null,
            selected_probe_index: null,
            selected_rtt_ms: null,
            estimated_offset_ms: null,
            subprobes: [],
          }),
          failure_reason: failureReason ?? (result && !result.success ? 'ALL_PROBES_FAILED' : null),
          wall_clock_utc: new Date().toISOString(),
        }));
        setTraceRecordCount(targetTraceRef.current.length);
      },
      recordIncomplete: (round) => {
        if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration ||
            senderSessionIdRef.current !== senderSessionId) return;
        targetTraceRef.current.push(Object.freeze({
          event: 'clock_sync_incomplete',
          sender_session_id: senderSessionId,
          research_run_id: capturedRunId,
          ...round,
          reason: 'STOPPED_WITH_ROUND_IN_FLIGHT',
          wall_clock_utc: new Date().toISOString(),
        }));
        setTraceRecordCount(targetTraceRef.current.length);
      },
    });
  }, []);


  const queueSend = useCallback((
    sample: TargetGpsSample,
    activeIdentity: TargetSenderIdentity,
    sessionGeneration: number,
  ) => {
    const safezone = safezoneRef.current;
    if (!safezone) return;

    // Serialize without dropping or throttling samples. This preserves callback
    // order and avoids an older database update completing after a newer one.
    const task = sendQueueRef.current.then(async () => {
      if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration) return;

      const controller = new AbortController();
      activeSendControllerRef.current = controller;
      try {
        await sendTargetLocation({
          identity: activeIdentity,
          sample,
          distanceFromSafezoneM: haversineDistanceMeters(sample, safezone),
          batteryPercent: UNKNOWN_BATTERY_PERCENT,
          signal: controller.signal,
        });
        if (activeRef.current && sessionGenerationRef.current === sessionGeneration) {
          setSuccessfulSends((count) => count + 1);
        }
      } catch (error) {
        if (!isAbortError(error) && activeRef.current && sessionGenerationRef.current === sessionGeneration) {
          setFailedSends((count) => count + 1);
          setLastError(errorMessage(error));
        }
      } finally {
        if (activeSendControllerRef.current === controller) {
          activeSendControllerRef.current = null;
        }
      }
    });

    sendQueueRef.current = task.catch(() => undefined);
  }, []);

  const startSending = useCallback(async () => {
    if (activeRef.current || isStarting) return;
    const senderSessionId = crypto.randomUUID();
    senderSessionIdRef.current = senderSessionId;
    const researchRunId = researchRunIdInput.trim().slice(0, 200) || null;
    researchRunIdRef.current = researchRunId;
    setActiveResearchRunId(researchRunId);
    setActiveSenderSessionId(senderSessionId);
    setLastError(null);

    if (!identity) {
      setGpsStatus('Error');
      setLastError('URL ต้องมี users_id และ takecare_id ที่เป็นเลขจำนวนเต็มบวก');
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('Error');
      setLastError('เบราว์เซอร์นี้ไม่รองรับ Geolocation');
      return;
    }

    setIsStarting(true);
    const startController = new AbortController();
    startControllerRef.current = startController;

    try {
      const safezone = await fetchTargetSafezone(identity, startController.signal);
      if (startController.signal.aborted) return;

      safezoneRef.current = safezone;
      sequenceRef.current = 0;
      callbackIndexRef.current = 0;
      interveningRejectedObservationRef.current = false;
      validatedDistanceRef.current = null;
      setValidatedDistanceM(null);
      startSampleRef.current = null;
      previousSampleRef.current = null;
      sendQueueRef.current = Promise.resolve();
      cumulativeDistanceRef.current = 0;
      setCumulativeDistanceM(0);
      setGpsSamples(0);
      setSuccessfulSends(0);
      setFailedSends(0);
      setGpsStatus('Waiting');
      setLastError(null);

      const sessionGeneration = sessionGenerationRef.current + 1;
      sessionGenerationRef.current = sessionGeneration;
      activeRef.current = true;
      targetTraceRef.current.push(Object.freeze({
        event: 'sender_start',
        sender_session_id: senderSessionId,
        research_run_id: researchRunId,
        wall_clock_utc: new Date().toISOString(),
      }));
      setTraceRecordCount(targetTraceRef.current.length);
      beginSenderClockSync(senderSessionId, researchRunId, sessionGeneration);

      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration) return;

          callbackIndexRef.current += 1;
          const nextSequence = sequenceRef.current + 1;
          const sample = sampleFromPosition(position, senderSessionId, nextSequence);
          if (!sample) {
            interveningRejectedObservationRef.current = true;
            targetTraceRef.current.push(Object.freeze({
              event: 'gps_observation_rejected',
              sender_session_id: senderSessionId,
              research_run_id: researchRunId,
              callback_index: callbackIndexRef.current,
              wall_clock_utc: new Date().toISOString(),
              mono_ms: performance.now(),
              target_lat: Number.isFinite(position.coords.latitude) ? position.coords.latitude : null,
              target_lng: Number.isFinite(position.coords.longitude) ? position.coords.longitude : null,
              accuracy_m: gpsValue(position.coords.accuracy),
              speed_mps: gpsValue(position.coords.speed),
              source_timestamp_ms: Number.isFinite(position.timestamp) ? position.timestamp : null,
              rejection_reason: 'INVALID_COORDINATE',
            }));
            setTraceRecordCount(targetTraceRef.current.length);
            setGpsStatus('Error');
            setLastError('ได้รับพิกัด GPS ที่ไม่ถูกต้อง');
            return;
          }

          sequenceRef.current = nextSequence;
          const isFirstSample = startSampleRef.current === null;
          if (isFirstSample) startSampleRef.current = sample;
          const previous = previousSampleRef.current;
          let nextCumulativeDistanceM = cumulativeDistanceRef.current;
          if (previous) {
            const segmentM = haversineDistanceMeters(previous, sample);
            nextCumulativeDistanceM += segmentM;
            cumulativeDistanceRef.current = nextCumulativeDistanceM;
            setCumulativeDistanceM(nextCumulativeDistanceM);
            const diagnostic = evaluateDistanceSegment({
              from: previous,
              to: sample,
              rawCumulativeDistanceM: nextCumulativeDistanceM,
              previousValidatedDistanceM: validatedDistanceRef.current,
              startupReady: false,
              interveningRejectedObservation: interveningRejectedObservationRef.current,
              rule: CALIBRATION_DISTANCE_RULE,
            });
            validatedDistanceRef.current = diagnostic.validated_cumulative_distance_m;
            setValidatedDistanceM(diagnostic.validated_cumulative_distance_m);
            targetTraceRef.current.push(Object.freeze({
              event: 'gps_segment_diagnostic',
              sender_session_id: senderSessionId,
              research_run_id: researchRunId,
              ...diagnostic,
              wall_clock_utc: new Date().toISOString(),
              mono_ms: performance.now(),
            }));
          }
          previousSampleRef.current = sample;
          interveningRejectedObservationRef.current = false;

          targetTraceRef.current.push(Object.freeze({
            event: 'target_sample',
            sender_session_id: sample.senderSessionId,
            research_run_id: researchRunIdRef.current,
            target_sample_id: sample.targetSampleId,
            sequence: sample.sequence,
            callback_index: callbackIndexRef.current,
            target_lat: sample.latitude,
            target_lng: sample.longitude,
            accuracy_m: sample.accuracy,
            speed_mps: sample.speed,
            source_timestamp_ms: sample.sourceTimestamp,
            wall_clock_utc: new Date().toISOString(),
            mono_ms: performance.now(),
            cumulative_distance_m: nextCumulativeDistanceM,
            raw_cumulative_distance_m: nextCumulativeDistanceM,
            validated_cumulative_distance_m: validatedDistanceRef.current,
            distance_rule_version: DISTANCE_RULE_VERSION,
            distance_quality_status: 'CALIBRATION_UNCONFIGURED',
          }));
          setTraceRecordCount(targetTraceRef.current.length);

          setLatestSample(sample);
          setGpsSamples((count) => count + 1);
          setGpsStatus('Ready');
          if (!isFirstSample) {
            queueSend(sample, identity, sessionGeneration);
          }
        },
        (error) => {
          if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration) return;
          callbackIndexRef.current += 1;
          interveningRejectedObservationRef.current = true;
          targetTraceRef.current.push(Object.freeze({
            event: 'gps_observation_rejected',
            sender_session_id: senderSessionId,
            research_run_id: researchRunId,
            callback_index: callbackIndexRef.current,
            wall_clock_utc: new Date().toISOString(),
            mono_ms: performance.now(),
            target_lat: null,
            target_lng: null,
            accuracy_m: null,
            speed_mps: null,
            source_timestamp_ms: null,
            rejection_reason: 'GEOLOCATION_ERROR',
            geolocation_error_code: error.code,
          }));
          setTraceRecordCount(targetTraceRef.current.length);
          setGpsStatus('Error');
          setLastError('GPS error (' + error.code + '): ' + error.message);
        },
        LOCATION_OPTIONS,
      );

      watchIdRef.current = watchId;
      setIsSending(true);
    } catch (error) {
      if (!isAbortError(error)) {
        stopRuntime();
        setGpsStatus('Error');
        setLastError(errorMessage(error));
      }
    } finally {
      if (startControllerRef.current === startController) {
        startControllerRef.current = null;
      }
      setIsStarting(false);
    }
  }, [identity, isStarting, queueSend, beginSenderClockSync, researchRunIdInput, stopRuntime]);

  const coordinateText = (value: number | null | undefined, digits: number): string =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';

  const exportTargetTrace = useCallback(() => {
    const senderSessionId = senderSessionIdRef.current;
    if (activeRef.current || !senderSessionId || targetTraceRef.current.length === 0) return;
    const jsonl = `${targetTraceRef.current.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `target-trace-${senderSessionId}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const clearTargetTrace = useCallback(() => {
    if (activeRef.current) return;
    clockSyncScheduleRef.current?.stop();
    clockSyncScheduleRef.current = null;
    targetTraceRef.current = [];
    setTraceRecordCount(0);
  }, []);

  return (
    <main className="sender-page">
      <section className="sender-card">
        <header>
          <h1>AFE+ V3 Target Sender</h1>
          <p className="subtitle">ส่งตำแหน่งจริงจาก GPS ของโทรศัพท์เป้าหมาย</p>
        </header>

        <div className="status-grid" aria-live="polite">
          <div className="status-box">
            <span>GPS Status</span>
            <strong className={`status ${gpsStatus.toLowerCase()}`}>{gpsStatus}</strong>
          </div>
          <div className="status-box">
            <span>Sending Status</span>
            <strong className={`status ${isSending ? 'sending' : 'stopped'}`}>
              {isSending ? 'Sending' : 'Stopped'}
            </strong>
          </div>
        </div>

        <section className="panel run-panel">
          <label htmlFor="research-run-id" className="field-label">Research Run ID</label>
          <input
            id="research-run-id"
            type="text"
            className="run-id-input"
            value={researchRunIdInput}
            onChange={(event) => setResearchRunIdInput(event.target.value)}
            disabled={isSending || isStarting}
            placeholder="ตรงกับ Run ID ของ navigation logger"
          />
        </section>

        <section className="panel">
          <h2>Latest GPS</h2>
          <dl className="data-list">
            <div><dt>Latitude</dt><dd>{coordinateText(latestSample?.latitude, 7)}</dd></div>
            <div><dt>Longitude</dt><dd>{coordinateText(latestSample?.longitude, 7)}</dd></div>
            <div><dt>Accuracy</dt><dd>{coordinateText(latestSample?.accuracy, 1)}{latestSample?.accuracy !== null && latestSample ? ' m' : ''}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>Sending Summary</h2>
          <dl className="data-list counters">
            <div><dt>GPS Samples</dt><dd>{gpsSamples}</dd></div>
            <div><dt>Successful Sends</dt><dd>{successfulSends}</dd></div>
            <div><dt>Failed Sends</dt><dd>{failedSends}</dd></div>
          </dl>
        </section>

        {lastError && <p className="error-message" role="alert">{lastError}</p>}

        <button
          type="button"
          className={isSending ? 'stop-button' : 'start-button'}
          disabled={isStarting}
          onClick={isSending ? stopSending : startSending}
        >
          {isStarting ? 'STARTING…' : isSending ? 'STOP SENDING' : 'START SENDING'}
        </button>

        <div className="trace-controls">
          <button type="button" className="trace-button" disabled={traceRecordCount === 0 || isSending || isStarting} onClick={exportTargetTrace}>
            EXPORT TARGET TRACE
          </button>
          <button type="button" className="trace-button clear-trace-button" disabled={traceRecordCount === 0 || isSending || isStarting} onClick={clearTargetTrace}>
            CLEAR TRACE
          </button>
        </div>

        <details className="details-drawer">
          <summary>Details</summary>
          <dl className="data-list">
            <div><dt>Active Run ID</dt><dd>{activeResearchRunId ?? '—'}</dd></div>
            <div><dt>Sender Session ID</dt><dd>{activeSenderSessionId ?? '—'}</dd></div>
          </dl>
        </details>

        <p className="secure-note">ต้องเปิดผ่าน HTTPS และอนุญาต Location บนเบราว์เซอร์</p>
      </section>

      <style jsx>{`
        .sender-page {
          min-height: 100vh;
          min-height: 100dvh;
          padding: max(10px, env(safe-area-inset-top)) 10px max(14px, env(safe-area-inset-bottom));
          background: #f3f7f8;
          color: #18343b;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
        }
        .sender-card {
          width: 100%;
          max-width: 440px;
          margin: 0 auto;
          padding: 14px 14px;
          background: #ffffff;
          border: 1px solid #dbe6e9;
          border-radius: 18px;
          box-shadow: 0 8px 24px rgba(31, 72, 82, 0.08);
          box-sizing: border-box;
        }
        header { text-align: center; margin-bottom: 8px; }
        h1 {
          margin: 0;
          color: #18343b;
          font-size: clamp(20px, 5.2vw, 24px);
          line-height: 1.2;
          font-weight: 800;
        }
        .subtitle {
          margin: 3px 0 0;
          color: #5f7479;
          font-size: 13px;
          line-height: 1.3;
        }
        .status-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .status-box, .panel {
          border: 1px solid #dbe6e9;
          border-radius: 14px;
          background: #fbfdfd;
        }
        .status-box {
          padding: 8px 10px;
        }
        .status-box span {
          display: block;
          color: #60777d;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .status {
          display: block;
          margin-top: 2px;
          font-size: 16px;
          font-weight: 700;
          line-height: 1.2;
        }
        .waiting, .stopped { color: #68777b; }
        .ready, .sending { color: #16835b; }
        .error { color: #c43d4f; }
        .panel {
          margin-top: 8px;
          padding: 8px 12px;
        }
        .panel h2 {
          margin: 0 0 4px;
          color: #274f58;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .run-panel {
          padding: 8px 12px;
        }
        .field-label {
          display: block;
          margin-bottom: 4px;
          color: #274f58;
          font-size: 13px;
          font-weight: 700;
        }
        .run-id-input {
          width: 100%;
          height: 36px;
          min-height: 36px;
          margin: 0;
          padding: 6px 10px;
          border: 1px solid #dbe6e9;
          border-radius: 10px;
          font-size: 13px;
          color: #18343b;
          background: #ffffff;
          box-sizing: border-box;
        }
        .run-id-input:disabled { background: #f3f7f8; color: #60777d; }
        .data-list { margin: 0; }
        .data-list div {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          padding: 4px 0;
          border-bottom: 1px solid #edf3f5;
        }
        .data-list div:last-child { border-bottom: 0; }
        dt { color: #60777d; font-size: 13px; }
        dd {
          margin: 0;
          color: #18343b;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 13px;
          font-weight: 700;
          word-break: break-all;
        }
        .counters dd { font-size: 15px; }
        .error-message {
          margin: 8px 0 0;
          padding: 8px 10px;
          border-radius: 10px;
          background: #fff0f2;
          color: #9e2436;
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        button {
          width: 100%;
          min-height: 48px;
          margin-top: 10px;
          border: 0;
          border-radius: 14px;
          color: #ffffff;
          font-size: 16px;
          font-weight: 800;
          letter-spacing: 0.04em;
          touch-action: manipulation;
        }
        button:disabled { cursor: wait; opacity: 0.65; }
        .start-button { background: #137c5b; }
        .stop-button { background: #c43d4f; }
        .trace-controls {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-top: 8px;
        }
        .trace-button {
          min-height: 40px;
          margin-top: 0;
          border: 1px solid #19718a;
          border-radius: 12px;
          background: #ffffff;
          color: #19718a;
          font-size: 12px;
          font-weight: 700;
        }
        .trace-button:disabled { cursor: not-allowed; opacity: 0.5; }
        .clear-trace-button { border-color: #9e2436; color: #9e2436; }
        .details-drawer {
          margin-top: 8px;
          border: 1px dashed #d0dee1;
          border-radius: 12px;
          background: #fbfdfd;
          padding: 6px 10px;
          font-size: 12px;
        }
        .details-drawer summary {
          cursor: pointer;
          font-weight: 600;
          color: #4d7078;
          user-select: none;
          outline: none;
          font-size: 12px;
        }
        .details-drawer[open] summary {
          margin-bottom: 6px;
          border-bottom: 1px solid #edf3f5;
          padding-bottom: 4px;
        }
        .details-drawer .data-list div {
          padding: 3px 0;
        }
        .details-drawer dt {
          font-size: 12px;
        }
        .details-drawer dd {
          font-size: 11px;
        }
        .secure-note {
          margin: 8px 0 0;
          color: #708287;
          font-size: 11px;
          text-align: center;
        }
        @media (max-width: 380px) {
          .sender-page {
            padding: max(8px, env(safe-area-inset-top)) 6px max(10px, env(safe-area-inset-bottom));
          }
          .sender-card {
            padding: 10px 8px;
            border-radius: 16px;
          }
          .panel, .status-box, .run-panel {
            padding: 6px 8px;
          }
          dt, .field-label, .panel h2 {
            font-size: 12px;
          }
          dd {
            font-size: 12px;
          }
          .trace-button {
            font-size: 11px;
          }
        }
      `}</style>
    </main>
  );
}
