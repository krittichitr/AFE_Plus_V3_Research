export type ClockProbeObservation = {
  probe_index: number;
  server_wall_clock_ms: number | null;
  client_send_wall_ms: number;
  client_receive_wall_ms: number;
  client_send_mono_ms: number;
  client_receive_mono_ms: number;
  rtt_ms: number;
  monotonic_rtt_ms: number;
  estimated_clock_offset_ms: number | null;
  success: boolean;
  failure_reason: 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR' | null;
};

export type ClockSyncResult = {
  server_wall_clock_ms: number | null;
  client_send_wall_ms: number;
  client_receive_wall_ms: number;
  rtt_ms: number;
  estimated_clock_offset_ms: number | null;
  success: boolean;
  selected_probe_index: number;
  selected_rtt_ms: number;
  estimated_offset_ms: number | null;
  actual_start_mono_ms: number;
  actual_end_mono_ms: number;
  subprobes: ClockProbeObservation[];
};

async function oneProbe(probeIndex: number): Promise<ClockProbeObservation> {
  const clientSendWallMs = Date.now();
  const clientSendMonoMs = performance.now();
  let serverWallClockMs: number | null = null;
  let failureReason: ClockProbeObservation['failure_reason'] = null;
  try {
    const response = await fetch('/api/research/time', {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      failureReason = 'HTTP_ERROR';
    } else {
      const body: unknown = await response.json();
      if (
        typeof body === 'object' && body !== null &&
        typeof (body as { server_wall_clock_ms?: unknown }).server_wall_clock_ms === 'number' &&
        Number.isFinite((body as { server_wall_clock_ms: number }).server_wall_clock_ms)
      ) {
        serverWallClockMs = (body as { server_wall_clock_ms: number }).server_wall_clock_ms;
      } else {
        failureReason = 'INVALID_RESPONSE';
      }
    }
  } catch (error) {
    failureReason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'TIMEOUT' : 'NETWORK_ERROR';
  }
  const clientReceiveWallMs = Date.now();
  const clientReceiveMonoMs = performance.now();
  const rttMs = clientReceiveWallMs - clientSendWallMs;
  return {
    probe_index: probeIndex,
    server_wall_clock_ms: serverWallClockMs,
    client_send_wall_ms: clientSendWallMs,
    client_receive_wall_ms: clientReceiveWallMs,
    client_send_mono_ms: clientSendMonoMs,
    client_receive_mono_ms: clientReceiveMonoMs,
    rtt_ms: rttMs,
    monotonic_rtt_ms: clientReceiveMonoMs - clientSendMonoMs,
    estimated_clock_offset_ms: serverWallClockMs === null
      ? null : serverWallClockMs - ((clientSendWallMs + clientReceiveWallMs) / 2),
    success: serverWallClockMs !== null,
    failure_reason: failureReason,
  };
}

export async function probeResearchClockSync(probeCount = 3): Promise<ClockSyncResult> {
  const actualStartMonoMs = performance.now();
  const probes = await Promise.all(Array.from({ length: probeCount }, (_, index) => oneProbe(index)));
  const actualEndMonoMs = performance.now();
  const successful = probes.filter((probe) => probe.success);
  const selected = (successful.length > 0 ? successful : probes)
    .reduce((best, probe) => probe.rtt_ms < best.rtt_ms ? probe : best);
  return {
    server_wall_clock_ms: selected.server_wall_clock_ms,
    client_send_wall_ms: selected.client_send_wall_ms,
    client_receive_wall_ms: selected.client_receive_wall_ms,
    rtt_ms: selected.rtt_ms,
    estimated_clock_offset_ms: selected.estimated_clock_offset_ms,
    success: selected.success,
    selected_probe_index: selected.probe_index,
    selected_rtt_ms: selected.rtt_ms,
    estimated_offset_ms: selected.estimated_clock_offset_ms,
    actual_start_mono_ms: actualStartMonoMs,
    actual_end_mono_ms: actualEndMonoMs,
    subprobes: probes,
  };
}
