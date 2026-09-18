/**
 * GET /api/navigate/target-location
 * Read-only adapter — reads the latest location row from AFE's canonical
 * Prisma `location` table (same table + same `location_id desc` ordering as
 * src/pages/api/location/getLocation.ts) and reshapes it into the contract
 * the Navigation frontend consumes. Does not write to the database and does
 * not duplicate the Prisma client — uses AFE's existing `@/lib/prisma`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withRls } from '@/lib/withRls'
export default withRls(
    req => Number(req.query.users_id),
    async function handler(req: NextApiRequest, res: NextApiResponse, prisma): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).json({
      ok: false,
      error: 'Method not allowed',
    });
    return;
  }

  const { users_id, takecare_id } = req.query;

  // Reject string[] (repeated query param) explicitly — never pick the first
  // value silently, per the adapter's validation contract.
  if (typeof users_id !== 'string' || typeof takecare_id !== 'string') {
    res.status(400).json({
      ok: false,
      error: 'Invalid users_id or takecare_id',
    });
    return;
  }

  const usersId = Number(users_id);
  const takecareId = Number(takecare_id);

  if (
    !Number.isInteger(usersId) || usersId <= 0 ||
    !Number.isInteger(takecareId) || takecareId <= 0
  ) {
    res.status(400).json({
      ok: false,
      error: 'Invalid users_id or takecare_id',
    });
    return;
  }

  try {
    // Same table, same filter, same ordering as getLocation.ts — this adapter
    // reads the identical "latest row" AFE already considers authoritative.
    const latestLocation = await prisma.location.findFirst({
      where: {
        users_id: usersId,
        takecare_id: takecareId,
      },
      orderBy: {
        location_id: 'desc',
      },
    });

    if (!latestLocation) {
      res.status(404).json({
        ok: false,
        error: 'Target location not found',
      });
      return;
    }

    const lat = Number(latestLocation.locat_latitude);
    const lng = Number(latestLocation.locat_longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(422).json({
        ok: false,
        error: 'Target location coordinates are invalid',
      });
      return;
    }

    // Timestamp strategy: locat_noti_time (full DateTime) first, then
    // locat_timestamp (DateTime but stored @db.Date — date-only precision)
    // as fallback, else null. No reinterpretation of either field's meaning.
    const sourceDate: Date | null =
      latestLocation.locat_noti_time ?? latestLocation.locat_timestamp ?? null;
    const sourceTimestamp = sourceDate ? sourceDate.toISOString() : null;

    res.status(200).json({
      ok: true,
      data: {
        usersId,
        takecareId,
        lat,
        lng,
        target_sample_id: latestLocation.target_sample_id ?? null,
        sourceTimestamp,
        status: Number(latestLocation.locat_status),
        battery: Number(latestLocation.locat_battery),
      },
    });
    return;
  } catch (err) {
    // Deliberately terse — never log coordinates, the raw Prisma row, full
    // query payload, or any secret alongside this error.
    console.error('[Navigation] Failed to read target location');
    res.status(500).json({
      ok: false,
      error: 'Failed to read target location',
    });
    return;
  }
}
);
