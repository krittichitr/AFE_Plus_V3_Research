import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  clearResearchRun,
  exportResearchLog,
  getResearchLoggerSnapshot,
  markVideoSync,
  startResearchRun,
  startM2ResearchRun,
  startWalkingWindow,
  stopResearchRun,
  stopWalkingWindow,
  subscribeResearchLogger,
} from '@/lib/research/provenanceEvents';
import { closePendingM1Frontend } from '@/lib/research/m1Frontend';
import { isExplicitM2ResearchMode } from '@/lib/research/m2Mode';

export default function ResearchLogPanel({ className = '' }: { className?: string }) {
  const logger = useSyncExternalStore(
    subscribeResearchLogger,
    getResearchLoggerSnapshot,
    getResearchLoggerSnapshot,
  );
  const [runIdInput, setRunIdInput] = useState('');
  const [m2ResearchMode, setM2ResearchMode] = useState(false);

  useEffect(() => { setM2ResearchMode(isExplicitM2ResearchMode()); }, []);

  useEffect(() => {
    if (logger.researchRunId) setRunIdInput(logger.researchRunId);
  }, [logger.researchRunId]);

  const statusLabel = logger.status === 'RECORDING'
    ? 'RECORDING'
    : logger.status === 'STOPPED' ? 'STOPPED' : 'NOT RECORDING';

  return (
    <section className={`${className} w-[min(270px,calc(100vw-24px))] rounded-xl border border-slate-300 bg-white/95 p-3 text-xs text-slate-800 shadow-xl backdrop-blur-sm`}>
      <h2 className="mb-2 text-sm font-bold">Research Log</h2>
      <label className="block">
        <span className="font-semibold">Run ID</span>
        <input
          value={runIdInput}
          onChange={(event) => setRunIdInput(event.target.value)}
          disabled={logger.status === 'RECORDING'}
          maxLength={200}
          placeholder="Auto-generate if blank"
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
        />
      </label>
      <dl className="my-2 grid grid-cols-2 gap-x-2 gap-y-1">
        <dt>Status</dt><dd className="font-semibold">{statusLabel}</dd>
        <dt>Events</dt><dd>{logger.eventCount} / {logger.attemptedEvents}</dd>
        <dt>Dropped</dt><dd>{logger.droppedEvents}</dd>
        <dt>Clock Sync</dt><dd className="font-semibold">{logger.clockStatus.replace('_', ' ')}</dd>
        {m2ResearchMode && <><dt>M2 journal</dt><dd className="font-semibold">{logger.m2Status}</dd></>}
      </dl>
      {m2ResearchMode && logger.m2Error && <p role="alert" className="mb-2 text-red-700">{logger.m2Error}</p>}
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={logger.status === 'RECORDING' || logger.m2Status === 'STARTING'} onClick={() => { if (m2ResearchMode) void startM2ResearchRun(runIdInput); else startResearchRun(runIdInput); }} className="rounded bg-emerald-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">START LOG</button>
        <button type="button" disabled={logger.status !== 'RECORDING'} onClick={() => { closePendingM1Frontend('aborted'); stopResearchRun(); }} className="rounded bg-amber-600 px-2 py-1.5 font-semibold text-white disabled:opacity-40">STOP LOG</button>
        <button type="button" disabled={!logger.hasData || logger.status === 'RECORDING'} onClick={exportResearchLog} className="rounded bg-blue-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">EXPORT LOG</button>
        <button type="button" disabled={logger.status === 'RECORDING'} onClick={() => { clearResearchRun(); setRunIdInput(''); }} className="rounded bg-slate-600 px-2 py-1.5 font-semibold text-white disabled:opacity-40">NEW/CLEAR RUN</button>
      </div>
      <p className="mt-2">Walking: {logger.walkingState.replace('_', ' ')}{logger.walkingWindowId ? ` · ${logger.walkingWindowId}` : ''}</p>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        <button type="button" disabled={logger.status !== 'RECORDING' || logger.walkingState !== 'NOT_STARTED'} onClick={startWalkingWindow} className="rounded bg-emerald-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">START WALKING</button>
        <button type="button" disabled={logger.status !== 'RECORDING' || logger.walkingState !== 'ACTIVE'} onClick={stopWalkingWindow} className="rounded bg-amber-600 px-2 py-1.5 font-semibold text-white disabled:opacity-40">STOP WALKING</button>
      </div>
      <button type="button" disabled={logger.status !== 'RECORDING'} onClick={markVideoSync} className="mt-2 rounded bg-violet-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">VIDEO SYNC</button>
      {logger.videoSyncId && <div aria-live="polite" className="mt-1 break-all rounded border-2 border-violet-700 bg-white p-1 font-mono text-sm font-bold text-violet-950">SYNC {logger.videoSyncId}</div>}
    </section>
  );
}
