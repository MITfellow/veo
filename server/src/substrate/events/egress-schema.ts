import { z } from 'zod';

/**
 * Egress payloads (decision 013). Kept beside the effect schemas rather
 * than in `registry.ts`, which reached its 400-line ceiling — a registry
 * is a list of bindings, and the shapes it binds can live next door.
 */

export const EgressAttempted = z.object({
  /** The origin only. A path or query string is where private data hides (§21). */
  origin: z.string().min(1),
  method: z.string().min(1),
  bytes: z.number().int().min(0),
}).strict();

export const EgressBlocked = z.object({
  origin: z.string().min(1),
  reason: z.string().max(200),
}).strict();
