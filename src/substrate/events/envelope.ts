import { z } from 'zod';
import { canonicalJson } from '../hash.js';
import type { Hashing } from '../ports.js';
import { type EventType, type TrustLevel, TrustLevelSchema, isEventType } from './types.js';

/**
 * The event record (§9).
 *
 * Every field here earns its place by answering a question someone will
 * actually ask of a ten-year-old log: what happened, in what order, who caused
 * it, as part of what, how much do we trust it, and has anyone touched it since.
 */
export interface Event<T extends EventType = EventType> {
  /** ULID — sortable, globally unique, assigned before the write. */
  id: string;
  /** Dense per-log ordering. The ULID sorts right; `seq` proves nothing is missing. */
  seq: number;
  /** Epoch millis from the Clock port, never `Date.now()`. */
  ts: number;

  /** Who this is attributable to: `user:ara`, `system`, `tool:http`, `foreign:webpage`. */
  principal: string;
  sessionId: string | null;
  runId: string | null;
  stepId: string | null;

  type: T;
  /** Validated against the type's schema and redacted before it got here. */
  payload: unknown;

  /** Trust of this event's content, after `minTrust` over its causes. */
  trust: TrustLevel;
  /** The event that directly caused this one. */
  causationId: string | null;
  /** The user-visible thing this all belongs to; survives suspend/resume. */
  correlationId: string;

  /** Version of the payload schema at write time. Readers upcast. */
  schemaVersion: number;
  /** Hash of the previous event; genesis uses GENESIS_HASH. */
  prevHash: string;
  /** sha256 over the canonical form of everything above. */
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export const EventSchema = z.object({
  id: z.string().length(26),
  seq: z.number().int().positive(),
  ts: z.number().int().nonnegative(),
  principal: z.string().min(1),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  stepId: z.string().nullable(),
  type: z.string().refine(isEventType, { message: 'unknown event type' }),
  payload: z.unknown(),
  trust: TrustLevelSchema,
  causationId: z.string().nullable(),
  correlationId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  prevHash: z.string().length(64),
  hash: z.string().length(64),
});

/**
 * The bytes that get hashed.
 *
 * Deliberately *everything except* `hash` itself — including `seq` and
 * `prevHash`. Hashing the payload alone would let someone reorder events or
 * reattribute them to a different run without breaking the chain, which is the
 * exact attack the chain exists to detect.
 */
export function hashableForm(e: Omit<Event, 'hash'>): string {
  return canonicalJson({
    id: e.id,
    seq: e.seq,
    ts: e.ts,
    principal: e.principal,
    sessionId: e.sessionId,
    runId: e.runId,
    stepId: e.stepId,
    type: e.type,
    payload: e.payload,
    trust: e.trust,
    causationId: e.causationId,
    correlationId: e.correlationId,
    schemaVersion: e.schemaVersion,
    prevHash: e.prevHash,
  });
}

export function computeHash(hashing: Hashing, e: Omit<Event, 'hash'>): string {
  return hashing.sha256Hex(hashableForm(e));
}

export function verifyEventHash(hashing: Hashing, e: Event): boolean {
  return computeHash(hashing, e) === e.hash;
}
