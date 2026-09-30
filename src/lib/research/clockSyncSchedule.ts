import type { ClockSyncResult } from './clockSync';

// Measurement cadence for the short M3 calibration, not an acceptance criterion.
export const CALIBRATION_CLOCK_SYNC_INTERVAL_MS = 60_000;

export type ClockSyncRound = {
  sync_index: number;
  sync_phase: 'initial' | 'periodic';
  scheduled_mono_ms: number;
  actual_start_mono_ms: number;
  actual_end_mono_ms: number;
};

export type ClockSyncSchedule = { stop: () => void };

type ScheduleOptions = {
  probe: () => Promise<ClockSyncResult>;
  record: (round: ClockSyncRound, result: ClockSyncResult | null, failureReason: string | null) => void;
  recordIncomplete: (round: ClockSyncRound) => void;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export function startClockSyncSchedule(options: ScheduleOptions): ClockSyncSchedule {
  const intervalMs = options.intervalMs ?? CALIBRATION_CLOCK_SYNC_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid clock sync interval');
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let active = true;
  let nextIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: ClockSyncRound | null = null;
  const initialMonoMs = now();
  let nextDueMonoMs = initialMonoMs + intervalMs;

  function scheduleNext(): void {
    if (!active) return;
    const currentMonoMs = now();
    // Keep the cadence anchored to START. If a probe or a hidden browser
    // misses several slots, record the late start without a catch-up burst.
    if (nextDueMonoMs < currentMonoMs) {
      nextDueMonoMs += Math.floor((currentMonoMs - nextDueMonoMs) / intervalMs) * intervalMs;
    }
    const due = nextDueMonoMs;
    nextDueMonoMs += intervalMs;
    timer = setTimer(() => {
      timer = null;
      launch('periodic', due);
    }, Math.max(0, due - currentMonoMs));
  }

  function launch(phase: ClockSyncRound['sync_phase'], scheduledMonoMs: number): void {
    if (!active || inFlight !== null) return;
    const round: ClockSyncRound = {
      sync_index: nextIndex,
      sync_phase: phase,
      scheduled_mono_ms: scheduledMonoMs,
      actual_start_mono_ms: now(),
      actual_end_mono_ms: NaN,
    };
    nextIndex += 1;
    inFlight = round;
    void Promise.resolve()
      .then(options.probe)
      .then(
        (result) => {
          if (active) options.record({ ...round, actual_end_mono_ms: now() }, result, null);
        },
        () => {
          if (active) options.record({ ...round, actual_end_mono_ms: now() }, null, 'PROBE_RUNTIME_ERROR');
        },
      )
      .finally(() => {
        if (inFlight === round) inFlight = null;
        if (active) scheduleNext();
      });
  }

  launch('initial', initialMonoMs);
  return {
    stop: () => {
      if (!active) return;
      active = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (inFlight !== null) options.recordIncomplete({ ...inFlight, actual_end_mono_ms: now() });
    },
  };
}
