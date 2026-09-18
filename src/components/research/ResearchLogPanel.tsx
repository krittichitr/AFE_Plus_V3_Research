import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  clearResearchRun,
  exportResearchLog,
  getResearchLoggerSnapshot,
  startResearchRun,
  stopResearchRun,
  subscribeResearchLogger,
} from '@/lib/research/provenanceEvents';

export default function ResearchLogPanel({ className = '' }: { className?: string }) {
  const logger = useSyncExternalStore(
    subscribeResearchLogger,
    getResearchLoggerSnapshot,
    getResearchLoggerSnapshot,
  );
  const [runIdInput, setRunIdInput] = useState('');

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
        <dt>Events</dt><dd>{logger.eventCount}</dd>
        <dt>Dropped</dt><dd>{logger.droppedEvents}</dd>
        <dt>Clock Sync</dt><dd className="font-semibold">{logger.clockStatus.replace('_', ' ')}</dd>
      </dl>
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" disabled={logger.status === 'RECORDING'} onClick={() => startResearchRun(runIdInput)} className="rounded bg-emerald-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">START LOG</button>
        <button type="button" disabled={logger.status !== 'RECORDING'} onClick={stopResearchRun} className="rounded bg-amber-600 px-2 py-1.5 font-semibold text-white disabled:opacity-40">STOP LOG</button>
        <button type="button" disabled={!logger.hasData} onClick={exportResearchLog} className="rounded bg-blue-700 px-2 py-1.5 font-semibold text-white disabled:opacity-40">EXPORT LOG</button>
        <button type="button" disabled={logger.status === 'RECORDING'} onClick={() => { clearResearchRun(); setRunIdInput(''); }} className="rounded bg-slate-600 px-2 py-1.5 font-semibold text-white disabled:opacity-40">NEW/CLEAR RUN</button>
      </div>
    </section>
  );
}
