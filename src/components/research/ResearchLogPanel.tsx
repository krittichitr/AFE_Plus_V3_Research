import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

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

export default function ResearchLogPanel({
  bannerRef, collapsedZIndex, expandedZIndex,
}: {
  bannerRef: RefObject<HTMLDivElement | null>;
  collapsedZIndex: number;
  expandedZIndex: number;
}) {
  const logger = useSyncExternalStore(
    subscribeResearchLogger,
    getResearchLoggerSnapshot,
    getResearchLoggerSnapshot,
  );
  const [runIdInput, setRunIdInput] = useState('');
  const [m2ResearchMode, setM2ResearchMode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [bannerBottom, setBannerBottom] = useState<number | null>(null);

  useEffect(() => {
    // The fixed banner changes height when its instruction or action wraps.
    const banner = bannerRef.current?.firstElementChild ?? bannerRef.current;
    if (!banner) return;
    const measure = () => {
      const pageTop = bannerRef.current?.parentElement?.getBoundingClientRect().top ?? 0;
      setBannerBottom(Math.max(0, banner.getBoundingClientRect().bottom - pageTop));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(banner);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [bannerRef]);

  useEffect(() => { setM2ResearchMode(isExplicitM2ResearchMode()); }, []);

  useEffect(() => {
    if (logger.researchRunId) setRunIdInput(logger.researchRunId);
  }, [logger.researchRunId]);

  const statusLabel = logger.status === 'RECORDING'
    ? 'RECORDING'
    : logger.status === 'STOPPED' ? 'STOPPED' : 'NOT RECORDING';

  return (
    <section
      className={`absolute left-3 rounded-xl border border-slate-300 bg-white/95 text-xs text-slate-800 shadow-xl backdrop-blur-sm ${expanded ? 'w-[min(360px,calc(100vw-24px))] overflow-y-auto p-3' : 'w-auto p-0'}`}
      style={{
        top: expanded ? 'calc(env(safe-area-inset-top) + 12px)' : (bannerBottom ?? 0) + 8,
        zIndex: expanded ? expandedZIndex : collapsedZIndex,
        maxHeight: expanded ? 'calc(100dvh - env(safe-area-inset-top) - 24px)' : undefined,
        visibility: !expanded && bannerBottom === null ? 'hidden' : undefined,
      }}
    >
      {expanded ? (
        <>
          <div className="sticky top-0 z-10 mb-2 flex items-center justify-between gap-2 bg-white/95">
            <h2 className="text-sm font-bold">Research Log</h2>
            <button type="button" aria-label="Collapse Research Log" onClick={() => setExpanded(false)} className="min-h-11 min-w-11 rounded border border-slate-300 bg-white text-lg font-bold">−</button>
          </div>
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
        </>
      ) : (
        <button type="button" aria-label="Expand Research Log" aria-expanded={false} onClick={() => setExpanded(true)} className="min-h-11 rounded-xl px-4 font-bold">LOG</button>
      )}
    </section>
  );
}
