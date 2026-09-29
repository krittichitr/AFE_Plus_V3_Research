/** Explicit opt-in; ordinary navigation never depends on the M2 journal. */
import { getResearchLoggerSnapshot } from './provenanceEvents';

export function isExplicitM2ResearchMode(): boolean {
  return getResearchLoggerSnapshot().m2Status !== 'OFF'
    || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('m2_research') === '1');
}
