import type { NextApiRequest, NextApiResponse } from 'next';
import { journalM2RunStart, journalM2RunStop, readM2Journal } from '@/lib/research/m2Journal';

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method === 'POST') {
    const body = req.body as { research_run_id?: unknown; boundary?: unknown; m2_run_token?: unknown; invalid?: unknown } | null;
    const runId = body?.research_run_id;
    const boundary = body?.boundary;
    if (typeof runId !== 'string' || !runId || runId.length > 200 || (boundary !== 'start' && boundary !== 'stop')) {
      res.status(400).json({ error: 'invalid research boundary' }); return;
    }
    if (boundary === 'start') {
      const runToken = await journalM2RunStart(runId);
      res.status(runToken ? 200 : 503).json({
        saved: Boolean(runToken), m2_run_token: runToken,
        integrity_status: runToken ? 'JOURNALED' : 'M2_DURABILITY_NOT_AVAILABLE_OR_RUN_ID_REUSED',
      });
      return;
    }
    if (typeof body?.m2_run_token !== 'string' || !body.m2_run_token) {
      res.status(400).json({ error: 'm2_run_token required' }); return;
    }
    const saved = await journalM2RunStop(runId, body.m2_run_token, body.invalid === true);
    res.status(saved ? 200 : 503).json({ saved, integrity_status: saved ? 'JOURNALED' : 'M2_STOP_NOT_JOURNALED' });
    return;
  }
  if (req.method !== 'GET') { res.status(405).end(); return; }
  const token = process.env.M2_RESEARCH_EXPORT_TOKEN;
  if (!token || req.headers['x-m2-research-token'] !== token) { res.status(403).json({ error: 'M2 export token required' }); return; }
  const runId = typeof req.query.research_run_id === 'string' ? req.query.research_run_id : '';
  if (!runId || runId.length > 200) { res.status(400).json({ error: 'research_run_id required' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(await readM2Journal(runId));
}
