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

type GpsStatus = 'Waiting' | 'Ready' | 'Error';

type TargetSampleTraceRecord = {
  event: 'target_sample';
  sender_session_id: string;
  target_sample_id: string;
  sequence: number;
  target_lat: number;
  target_lng: number;
  accuracy_m: number | null;
  source_timestamp_ms: number;
  wall_clock_utc: string;
  mono_ms: number;
  cumulative_distance_m: number;
};

type ClockSyncTraceRecord = {
  event: 'clock_sync';
  sender_session_id: string;
  server_wall_clock_ms: number | null;
  client_send_wall_ms: number;
  client_receive_wall_ms: number;
  rtt_ms: number;
  estimated_clock_offset_ms: number | null;
  wall_clock_utc: string;
  success: boolean;
};

type TargetTraceRecord = TargetSampleTraceRecord | ClockSyncTraceRecord;

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
  const [gpsSamples, setGpsSamples] = useState(0);
  const [successfulSends, setSuccessfulSends] = useState(0);
  const [failedSends, setFailedSends] = useState(0);
  const [traceRecordCount, setTraceRecordCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const sequenceRef = useRef(0);
  const senderSessionIdRef = useRef<string | null>(null);
  const targetTraceRef = useRef<TargetTraceRecord[]>([]);
  const cumulativeDistanceRef = useRef(0);
  const startSampleRef = useRef<TargetGpsSample | null>(null);
  const previousSampleRef = useRef<TargetGpsSample | null>(null);
  const safezoneRef = useRef<TargetSafezone | null>(null);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeSendControllerRef = useRef<AbortController | null>(null);
  const startControllerRef = useRef<AbortController | null>(null);

  const stopRuntime = useCallback(() => {
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
    stopRuntime();
    setIsStarting(false);
    setIsSending(false);
  }, [stopRuntime]);

  useEffect(() => () => stopRuntime(), [stopRuntime]);

  const recordSenderClockSync = useCallback((senderSessionId: string) => {
    void probeResearchClockSync().then((result) => {
      targetTraceRef.current.push(Object.freeze({
        event: 'clock_sync',
        sender_session_id: senderSessionId,
        ...result,
        wall_clock_utc: new Date().toISOString(),
      }));
      setTraceRecordCount(targetTraceRef.current.length);
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
      recordSenderClockSync(senderSessionId);

      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (!activeRef.current || sessionGenerationRef.current !== sessionGeneration) return;

          const nextSequence = sequenceRef.current + 1;
          const sample = sampleFromPosition(position, senderSessionId, nextSequence);
          if (!sample) {
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
          }
          previousSampleRef.current = sample;

          targetTraceRef.current.push(Object.freeze({
            event: 'target_sample',
            sender_session_id: sample.senderSessionId,
            target_sample_id: sample.targetSampleId,
            sequence: sample.sequence,
            target_lat: sample.latitude,
            target_lng: sample.longitude,
            accuracy_m: sample.accuracy,
            source_timestamp_ms: sample.sourceTimestamp,
            wall_clock_utc: new Date().toISOString(),
            mono_ms: performance.now(),
            cumulative_distance_m: nextCumulativeDistanceM,
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
          setGpsStatus('Error');
          setLastError(`GPS error (${error.code}): ${error.message}`);
        },
        LOCATION_OPTIONS,
      );

      watchIdRef.current = watchId;
      setIsSending(true);
    } catch (error) {
      if (!isAbortError(error)) {
        activeRef.current = false;
        setGpsStatus('Error');
        setLastError(errorMessage(error));
      }
    } finally {
      if (startControllerRef.current === startController) {
        startControllerRef.current = null;
      }
      setIsStarting(false);
    }
  }, [identity, isStarting, queueSend, recordSenderClockSync]);

  const coordinateText = (value: number | null | undefined, digits: number): string =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';

  const exportTargetTrace = useCallback(() => {
    const senderSessionId = senderSessionIdRef.current;
    if (!senderSessionId || targetTraceRef.current.length === 0) return;
    const jsonl = `${targetTraceRef.current.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `target-trace-${senderSessionId}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const clearTargetTrace = useCallback(() => {
    targetTraceRef.current = [];
    setTraceRecordCount(0);
  }, []);

  return (
    <main className="sender-page">
      <section className="sender-card">
        <header>
          <p className="eyebrow">Research utility</p>
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

        <section className="panel">
          <h2>Latest GPS</h2>
          <dl className="data-list">
            <div><dt>Latitude</dt><dd>{coordinateText(latestSample?.latitude, 7)}</dd></div>
            <div><dt>Longitude</dt><dd>{coordinateText(latestSample?.longitude, 7)}</dd></div>
            <div><dt>Accuracy</dt><dd>{coordinateText(latestSample?.accuracy, 1)}{latestSample?.accuracy !== null && latestSample ? ' m' : ''}</dd></div>
          </dl>
        </section>

        <section className="panel movement-panel">
          <h2>Movement</h2>
          <span>Distance from Start</span>
          <strong>{cumulativeDistanceM.toFixed(1)} m</strong>
        </section>

        <section className="panel">
          <h2>Counters</h2>
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
          <button type="button" className="trace-button" disabled={traceRecordCount === 0} onClick={exportTargetTrace}>
            EXPORT TARGET TRACE
          </button>
          <button type="button" className="trace-button clear-trace-button" disabled={traceRecordCount === 0} onClick={clearTargetTrace}>
            CLEAR TRACE
          </button>
        </div>

        <p className="secure-note">ต้องเปิดผ่าน HTTPS และอนุญาต Location บนเบราว์เซอร์</p>
      </section>

      <style jsx>{`
        .sender-page {
          min-height: 100vh;
          padding: 20px 14px 36px;
          background: #f3f7f8;
          color: #18343b;
        }
        .sender-card {
          width: min(100%, 520px);
          margin: 0 auto;
          padding: 24px 18px;
          background: #ffffff;
          border: 1px solid #dbe6e9;
          border-radius: 22px;
          box-shadow: 0 12px 34px rgba(31, 72, 82, 0.12);
        }
        header { text-align: center; margin-bottom: 20px; }
        .eyebrow {
          margin: 0 0 4px;
          color: #4d8d9a;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        h1 { margin: 0; color: #18343b; font-size: clamp(25px, 7vw, 34px); }
        .subtitle { margin: 6px 0 0; color: #5f7479; font-size: 15px; }
        .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .status-box, .panel {
          border: 1px solid #dbe6e9;
          border-radius: 16px;
          background: #fbfdfd;
        }
        .status-box { padding: 14px; }
        .status-box span, .movement-panel span { display: block; color: #60777d; font-size: 13px; }
        .status { display: block; margin-top: 3px; font-size: 19px; }
        .waiting, .stopped { color: #68777b; }
        .ready, .sending { color: #16835b; }
        .error { color: #c43d4f; }
        .panel { margin-top: 12px; padding: 16px; }
        .panel h2 { margin: 0 0 10px; color: #274f58; font-size: 16px; }
        .data-list { margin: 0; }
        .data-list div {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 16px;
          padding: 8px 0;
          border-bottom: 1px solid #e8eff1;
        }
        .data-list div:last-child { border-bottom: 0; }
        dt { color: #60777d; font-size: 14px; }
        dd { margin: 0; color: #18343b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; }
        .movement-panel strong {
          display: block;
          margin-top: 2px;
          color: #19718a;
          font-size: 34px;
          line-height: 1.2;
        }
        .counters dd { font-size: 20px; }
        .error-message {
          margin: 12px 0 0;
          padding: 11px 12px;
          border-radius: 12px;
          background: #fff0f2;
          color: #9e2436;
          font-size: 14px;
          overflow-wrap: anywhere;
        }
        button {
          width: 100%;
          min-height: 56px;
          margin-top: 18px;
          border: 0;
          border-radius: 15px;
          color: #ffffff;
          font-size: 17px;
          font-weight: 800;
          letter-spacing: 0.04em;
          touch-action: manipulation;
        }
        button:disabled { cursor: wait; opacity: 0.65; }
        .start-button { background: #137c5b; }
        .stop-button { background: #c43d4f; }
        .trace-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .trace-button {
          min-height: 44px;
          margin-top: 10px;
          border: 1px solid #19718a;
          background: #ffffff;
          color: #19718a;
          font-size: 12px;
        }
        .clear-trace-button { border-color: #9e2436; color: #9e2436; }
        .secure-note { margin: 12px 0 0; color: #708287; font-size: 12px; text-align: center; }
        @media (max-width: 380px) {
          .status-grid { grid-template-columns: 1fr; }
          .sender-card { padding: 20px 14px; }
        }
      `}</style>
    </main>
  );
}
