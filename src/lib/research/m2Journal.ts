/** Persistent, authoritative Mapbox attempt journal for explicit M2 research runs. */
import { randomUUID } from 'node:crypto';

export type M2Attempt = {
  event: 'm2_mapbox_attempt'; research_run_id: string; m2_run_token: string;
  session_id: string | null; route_update_id: string; target_sample_id: string | null;
  mapbox_attempt_id: string; request_phase: 'initial' | 'navigation';
  operation: 'initial_graph' | 'graph_refetch';
  request_purpose: 'corridor_driving' | 'corridor_walking' | 'target_ray';
  ray_direction: string | null; attempt_index: number;
  dispatch_wall_clock_ms: number; dispatch_mono_ms: number;
  clock_domain: 'server_performance';
};

export type M2Outcome = {
  event: 'm2_mapbox_outcome'; mapbox_attempt_id: string; success: boolean;
  http_status: number | null; failure_reason: string | null;
};

type JournalClient = {
  eval: (script: string, key: string, args: string[]) => Promise<number>;
  write: (key: string, values: Record<string, string>) => Promise<void>;
  read: (key: string) => Promise<Record<string, unknown>>;
};

let client: JournalClient | null | undefined;
const keyFor = (runId: string) => `research:m2:${encodeURIComponent(runId)}`;
const START = "if redis.call('HEXISTS', KEYS[1], '__start') == 1 then return 0 end redis.call('HSET', KEYS[1], '__schema', 'm2-v2', '__start', ARGV[1], '__token', ARGV[2]) return 1";
const STOP = "if redis.call('HGET', KEYS[1], '__token') ~= ARGV[1] then return 0 end if redis.call('HEXISTS', KEYS[1], '__stop') == 1 then return 0 end redis.call('HSET', KEYS[1], '__stop', ARGV[2]) if ARGV[3] == '1' then redis.call('HSET', KEYS[1], '__invalid', 'client_reported_invalid') end return 1";
const ATTEMPT = "if redis.call('HGET', KEYS[1], '__token') ~= ARGV[1] then return 0 end if redis.call('HEXISTS', KEYS[1], '__stop') == 1 then return 0 end if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then return 0 end redis.call('HSET', KEYS[1], ARGV[2], ARGV[3]) return 1";

function getClient(): JournalClient | null {
  if (client !== undefined) return client;
  try {
    const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
    const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (upstashUrl && upstashToken) {
      const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
      const redis = new Redis({ url: upstashUrl, token: upstashToken });
      client = {
        eval: async (script, key, args) => Number(await redis.eval(script, [key], args)),
        write: async (key, values) => { await redis.hset(key, values); },
        read: async (key) => (await redis.hgetall<Record<string, unknown>>(key)) ?? {},
      };
    } else if (process.env.REDIS_URL) {
      const { default: Redis } = require('ioredis') as typeof import('ioredis');
      const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
      client = {
        eval: async (script, key, args) => Number(await redis.eval(script, 1, key, ...args)),
        write: async (key, values) => { await redis.hset(key, ...Object.entries(values).flat()); },
        read: async (key) => redis.hgetall(key),
      };
    } else client = null;
  } catch { client = null; }
  return client;
}

export function m2DurabilityAvailable(): boolean { return getClient() !== null; }

export async function journalM2RunStart(runId: string): Promise<string | null> {
  const store = getClient();
  if (!store) return null;
  const token = randomUUID();
  try { return await store.eval(START, keyFor(runId), [String(Date.now()), token]) === 1 ? token : null; }
  catch { return null; }
}

export async function journalM2RunStop(runId: string, token: string, invalid = false): Promise<boolean> {
  const store = getClient();
  if (!store) return false;
  try {
    return await store.eval(STOP, keyFor(runId), [token, String(Date.now()), invalid ? '1' : '0']) === 1;
  } catch { return false; }
}

export async function markM2RunInvalid(runId: string, reason: string): Promise<void> {
  const store = getClient();
  if (!store) return;
  try { await store.write(keyFor(runId), { __invalid: reason }); } catch { /* best effort; no fetch follows a failed acknowledgement */ }
}

export async function journalM2Attempt(attempt: M2Attempt): Promise<boolean> {
  const store = getClient();
  if (!store) return false;
  try {
    const saved = await store.eval(ATTEMPT, keyFor(attempt.research_run_id), [
      attempt.m2_run_token, `a:${attempt.mapbox_attempt_id}`, JSON.stringify(attempt),
    ]) === 1;
    if (!saved) await markM2RunInvalid(attempt.research_run_id, 'attempt_rejected_or_run_stopped');
    return saved;
  } catch {
    await markM2RunInvalid(attempt.research_run_id, 'attempt_write_failed');
    return false;
  }
}

export async function journalM2Outcome(runId: string, outcome: M2Outcome): Promise<boolean> {
  const store = getClient();
  if (!store) return false;
  try { await store.write(keyFor(runId), { [`o:${outcome.mapbox_attempt_id}`]: JSON.stringify(outcome) }); return true; }
  catch { await markM2RunInvalid(runId, 'outcome_write_failed'); return false; }
}

/** A stopped run's own capability can read only that run's journal. */
export async function authorizeM2JournalExport(runId: string, token: string): Promise<boolean> {
  const store = getClient();
  if (!store || !token) return false;
  try {
    const fields = await store.read(keyFor(runId));
    return fields.__token === token && Boolean(fields.__start && fields.__stop);
  } catch {
    return false;
  }
}

export async function readM2Journal(runId: string) {
  const store = getClient();
  if (!store) return {
    research_run_id: runId, integrity_status: 'INCOMPLETE / DURABILITY NOT AVAILABLE',
    complete_for_m2: false, attempts: [], outcomes: [], journal_errors: ['persistent_store_not_configured'],
  };
  try {
    const fields = await store.read(keyFor(runId));
    const decode = <T,>(value: unknown): T => typeof value === 'string' ? JSON.parse(value) as T : value as T;
    const attempts = Object.entries(fields).filter(([key]) => key.startsWith('a:')).map(([, value]) => decode<M2Attempt>(value));
    const outcomes = Object.entries(fields).filter(([key]) => key.startsWith('o:')).map(([, value]) => decode<M2Outcome>(value));
    const errors: string[] = [];
    if (fields.__schema !== 'm2-v2') errors.push('fail_closed_schema_missing');
    if (!fields.__start || !fields.__token) errors.push('run_start_not_journaled');
    if (!fields.__stop) errors.push('run_stop_not_journaled');
    if (fields.__invalid) errors.push(`run_invalid:${fields.__invalid}`);
    if (!attempts.some((item) => item.operation === 'initial_graph')) errors.push('initial_attempt_missing');
    for (const attempt of attempts) {
      if (attempt.research_run_id !== runId || attempt.m2_run_token !== fields.__token) errors.push(`attempt_run_mismatch:${attempt.mapbox_attempt_id}`);
    }
    if (new Set(attempts.map((item) => item.mapbox_attempt_id)).size !== attempts.length) errors.push('duplicate_attempt_id');
    const outcomeIds = new Set(outcomes.map((item) => item.mapbox_attempt_id));
    const attemptIds = new Set(attempts.map((item) => item.mapbox_attempt_id));
    for (const outcome of outcomes) if (!attemptIds.has(outcome.mapbox_attempt_id)) errors.push(`orphan_outcome:${outcome.mapbox_attempt_id}`);
    for (const attempt of attempts) if (!outcomeIds.has(attempt.mapbox_attempt_id)) errors.push(`outcome_pending:${attempt.mapbox_attempt_id}`);
    return {
      research_run_id: runId, integrity_status: errors.length ? 'INCOMPLETE' : 'COMPLETE',
      complete_for_m2: errors.length === 0, attempts, outcomes, journal_errors: errors,
    };
  } catch (error) {
    return { research_run_id: runId, integrity_status: 'INCOMPLETE / JOURNAL READ FAILED',
      complete_for_m2: false, attempts: [], outcomes: [], journal_errors: [String(error)] };
  }
}
