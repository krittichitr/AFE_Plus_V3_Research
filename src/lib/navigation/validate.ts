import { z } from 'zod';
import { ValidationError } from './logger';

// ─── Shared ───────────────────────────────────────────────────────────────────
export const CoordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}).refine(
  ({ lat, lng }) => !(lat === 0 && lng === 0),
  { message: 'Coordinates (0,0) indicate uninitialized GPS — wait for GPS fix before navigating' },
);

export const CostChangeSchema = z.object({
  u: z.string().min(1),
  v: z.string().min(1),
  oldCost: z.number().nonnegative(),
  newCost: z.number().nonnegative(),
});

export const RouteProvenanceSchema = z.object({
  route_update_id: z.string().min(1).max(200),
  target_sample_id: z.string().min(1).max(200).nullable(),
  target_ref_lat: z.number().min(-90).max(90),
  target_ref_lng: z.number().min(-180).max(180),
  research_run_id: z.string().min(1).max(200).optional(),
  research_request_phase: z.enum(['init', 'restore', 'incremental']).optional(),
});

// ─── POST /api/navigate/init ──────────────────────────────────────────────────
export const InitRequestSchema = z.object({
  agentPos: CoordinateSchema,
  targetPos: CoordinateSchema,
  routeProvenance: RouteProvenanceSchema.nullish().transform((value) => value ?? null),
});

// ─── POST /api/navigate/update ────────────────────────────────────────────────
export const UpdateRequestSchema = z.object({
  sessionId: z.string().min(1),
  agentPos: CoordinateSchema,
  targetPos: CoordinateSchema,
  routeProvenance: RouteProvenanceSchema.nullish().transform((value) => value ?? null),
  costChanges: z.array(CostChangeSchema).optional().default([]),
});

// ─── GET /api/navigate/stream ─────────────────────────────────────────────────
export const StreamQuerySchema = z.object({
  sessionId: z.string().min(1),
});

// ─── Helper ───────────────────────────────────────────────────────────────────
export function validateBody<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid request: ${msg}`);
  }
  return result.data;
}
