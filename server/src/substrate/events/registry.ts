import { z } from 'zod';
import { type EventType, TrustLevelSchema } from './types.js';

/**
 * Payload schemas, one per event type that can currently be appended.
 *
 * This registry is intentionally much smaller than `EVENT_TYPES`. A milestone
 * that emits a new family registers its schema here as part of that
 * milestone; until then `append()` refuses the type outright, so a payload
 * can never be stored unvalidated (decision 003).
 *
 * `.strict()` on every schema: an extra field is a bug in the producer, and
 * silently storing it means a projector will one day depend on a field no
 * schema guarantees.
 */

const SessionStarted = z.object({ channel: z.string().min(1), title: z.string().optional() }).strict();
const SessionEnded = z.object({ reason: z.enum(['user', 'idle', 'shutdown']) }).strict();
const SessionTitled = z.object({ title: z.string().min(1) }).strict();

const Message = z.object({
  messageId: z.string().min(1),
  role: z.enum(['user', 'agent', 'system']),
  content: z.string(),
}).strict();

const CaptureReceived = z.object({
  captureId: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(['text', 'email', 'web', 'file', 'transcript']),
  content: z.string(),
}).strict();

const RunStarted = z.object({ goal: z.string().optional() }).strict();
const RunFinished = z.object({
  stopReason: z.enum(['done', 'budget', 'denied', 'cancelled', 'error', 'no-progress']),
  steps: z.number().int().min(0),
}).strict();

const FactAsserted = z.object({
  factId: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string(),
  validFrom: z.number().int(),
  validTo: z.number().int().nullable().default(null),
  basis: z.string().min(1),
  confidence: z.number().min(0).max(1),
  stability: z.enum(['volatile', 'slow', 'stable']),
  sensitivity: z.enum(['normal', 'sensitive', 'secret']),
  sourceTrust: TrustLevelSchema,
}).strict();

const FactSuperseded = z.object({
  factId: z.string().min(1),
  supersededBy: z.string().min(1),
  validTo: z.number().int(),
}).strict();

const FactRetracted = z.object({ factId: z.string().min(1), reason: z.string() }).strict();
const FactUsed = z.object({ factId: z.string().min(1), usedFor: z.string() }).strict();

const EntityCreated = z.object({
  entityId: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
}).strict();

const SystemLifecycle = z.object({ version: z.string().min(1) }).strict();
const MigrationApplied = z.object({ version: z.number().int(), name: z.string().min(1) }).strict();
const ProjectionRebuilt = z.object({ projector: z.string().min(1), events: z.number().int().min(0) }).strict();

export type PayloadSchema = z.ZodType<Record<string, unknown>>;

const SCHEMAS = new Map<EventType, PayloadSchema>([
  ['session.started', SessionStarted as PayloadSchema],
  ['session.ended', SessionEnded as PayloadSchema],
  ['session.titled', SessionTitled as PayloadSchema],
  ['message.received', Message as PayloadSchema],
  ['message.sent', Message as PayloadSchema],
  ['capture.received', CaptureReceived as PayloadSchema],
  ['run.started', RunStarted as PayloadSchema],
  ['run.finished', RunFinished as PayloadSchema],
  ['fact.asserted', FactAsserted as PayloadSchema],
  ['fact.superseded', FactSuperseded as PayloadSchema],
  ['fact.retracted', FactRetracted as PayloadSchema],
  ['fact.used', FactUsed as PayloadSchema],
  ['entity.created', EntityCreated as PayloadSchema],
  ['system.started', SystemLifecycle as PayloadSchema],
  ['system.stopped', SystemLifecycle as PayloadSchema],
  ['migration.applied', MigrationApplied as PayloadSchema],
  ['projection.rebuilt', ProjectionRebuilt as PayloadSchema],
]);

export function payloadSchema(type: EventType): PayloadSchema | undefined {
  return SCHEMAS.get(type);
}

/** The types that can currently be appended. Used by `doctor` and by tests. */
export function registeredTypes(): EventType[] {
  return [...SCHEMAS.keys()].sort();
}
