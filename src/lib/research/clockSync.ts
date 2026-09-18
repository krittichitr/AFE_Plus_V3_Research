export type ClockSyncResult = {
  server_wall_clock_ms: number | null;
  client_send_wall_ms: number;
  client_receive_wall_ms: number;
  rtt_ms: number;
  estimated_clock_offset_ms: number | null;
  success: boolean;
};

async function oneProbe(): Promise<ClockSyncResult> {
  const clientSendWallMs = Date.now();
  try {
    const response = await fetch('/api/research/time', {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    const body: unknown = await response.json();
    const clientReceiveWallMs = Date.now();
    const serverWallClockMs =
      response.ok && typeof body === 'object' && body !== null &&
      typeof (body as { server_wall_clock_ms?: unknown }).server_wall_clock_ms === 'number'
        ? (body as { server_wall_clock_ms: number }).server_wall_clock_ms
        : null;
    const rttMs = clientReceiveWallMs - clientSendWallMs;
    return {
      server_wall_clock_ms: serverWallClockMs,
      client_send_wall_ms: clientSendWallMs,
      client_receive_wall_ms: clientReceiveWallMs,
      rtt_ms: rttMs,
      estimated_clock_offset_ms: serverWallClockMs === null
        ? null
        : serverWallClockMs - ((clientSendWallMs + clientReceiveWallMs) / 2),
      success: serverWallClockMs !== null,
    };
  } catch {
    const clientReceiveWallMs = Date.now();
    return {
      server_wall_clock_ms: null,
      client_send_wall_ms: clientSendWallMs,
      client_receive_wall_ms: clientReceiveWallMs,
      rtt_ms: clientReceiveWallMs - clientSendWallMs,
      estimated_clock_offset_ms: null,
      success: false,
    };
  }
}

export async function probeResearchClockSync(probeCount = 3): Promise<ClockSyncResult> {
  const probes = await Promise.all(Array.from({ length: probeCount }, () => oneProbe()));
  const successful = probes.filter((probe) => probe.success);
  return (successful.length > 0 ? successful : probes)
    .reduce((best, probe) => probe.rtt_ms < best.rtt_ms ? probe : best);
}
