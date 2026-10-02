import { z } from 'zod';

/**
 * The closed set of things that can ever have happened.
 *
 * Adding a member is a deliberate act: it needs a payload schema below, and
 * usually a projector. The alternative — a free-form `type: string` — is how
 * event logs rot into unreadable soup after two years.
 */

/* ───────────────────────────── trust lattice (§12) ────────────────────────── */

export const TRUST_LEVELS = ['SYSTEM', 'USER', 'DERIVED', 'TOOL', 'FOREIGN'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];
export const TrustLevelSchema = z.enum(TRUST_LEVELS);

/**
 * Ordered most-trusted to least. The order is the whole point: effective trust
 * is the *minimum* over a causal closure, and capability is a function of it.
 * Declaring the order here, next to the enum, keeps the two from drifting.
 */
const TRUST_RANK: Record<TrustLevel, number> = {
  SYSTEM: 4,
  USER: 3,
  DERIVED: 2,
  TOOL: 1,
  FOREIGN: 0,
};

export function trustRank(t: TrustLevel): number {
  return TRUST_RANK[t];
}

/** Trust never increases along a causal chain (§35.6). */
export function minTrust(...levels: TrustLevel[]): TrustLevel {
  if (levels.length === 0) return 'SYSTEM';
  return levels.reduce((lo, t) => (TRUST_RANK[t] < TRUST_RANK[lo] ? t : lo));
}

export function atLeastTrust(actual: TrustLevel, required: TrustLevel): boolean {
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}

/* ──────────────────────────────── shared bits ─────────────────────────────── */

const Json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(Json)]),
);

export const SourceRefSchema = z.object({
  eventId: z.string(),
  /** Character span inside that event's text, so "why do you think that?" can
      quote the exact words rather than the whole message. */
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  quote: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const BasisSchema = z.enum(['observed', 'inferred', 'asserted_by_user', 'imported']);
export type Basis = z.infer<typeof BasisSchema>;

export const StabilitySchema = z.enum(['volatile', 'slow', 'stable']);
export const SensitivitySchema = z.enum(['normal', 'private', 'secret']);
export const FactStatusSchema = z.enum(['active', 'disputed', 'quarantined', 'retired']);

/* ───────────────────────────── payload schemas ────────────────────────────── */

const SessionCreated = z.object({ title: z.string().nullable(), source: z.string().optional() });
const SessionTitled = z.object({ title: z.string() });
const SessionArchived = z.object({ reason: z.string().optional() });
const SessionLocked = z.object({ reason: z.string() });

const MessageUser = z.object({ text: z.string(), attachments: z.array(z.string()).default([]) });
const MessageAgent = z.object({ text: z.string(), finishReason: z.string().optional() });
const MessageSystem = z.object({ text: z.string(), kind: z.string().optional() });

const RunStarted = z.object({
  trigger: z.enum(['user', 'schedule', 'resume', 'system']),
  sessionId: z.string(),
  budget: z
    .object({
      steps: z.number().int().positive(),
      tokens: z.number().int().positive(),
      wallClockMs: z.number().int().positive(),
      costCents: z.number().nonnegative(),
    })
    .partial()
    .optional(),
});
const RunFinished = z.object({
  steps: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
});
const RunFailed = z.object({ kind: z.string(), message: z.string(), stepId: z.string().nullable() });
const RunCancelled = z.object({ by: z.string(), reason: z.string().optional() });
const RunSuspended = z.object({
  reason: z.enum(['approval', 'ask_user', 'schedule']),
  resumeOn: z.string(),
  stepId: z.string(),
});
const RunResumed = z.object({ afterMs: z.number().int().nonnegative(), stepId: z.string() });
const RunDegraded = z.object({ level: z.string(), reason: z.string() });

const StepStarted = z.object({ index: z.number().int().nonnegative(), effectiveTrust: TrustLevelSchema });
const StepFinished = z.object({
  index: z.number().int().nonnegative(),
  outcome: z.enum(['text', 'tools', 'finish', 'error']),
  durationMs: z.number().int().nonnegative(),
});

const ModelRequested = z.object({
  provider: z.string(),
  model: z.string(),
  contextDigest: z.string(),
  inputTokens: z.number().int().nonnegative(),
});
const ModelResponded = z.object({
  provider: z.string(),
  model: z.string(),
  outputTokens: z.number().int().nonnegative(),
  finishReason: z.string(),
  latencyMs: z.number().int().nonnegative(),
  costCents: z.number().nonnegative().optional(),
  cacheHit: z.boolean().optional(),
});
const ModelFailed = z.object({
  provider: z.string(),
  kind: z.enum(['transient', 'invalid_request', 'context_overflow', 'content_filter', 'auth', 'quota']),
  message: z.string(),
});

const ToolRequested = z.object({ tool: z.string(), version: z.string(), input: Json });
const ToolStarted = z.object({ tool: z.string(), idempotencyKey: z.string() });
const ToolSucceeded = z.object({
  tool: z.string(),
  durationMs: z.number().int().nonnegative(),
  resultTrust: TrustLevelSchema,
  artifacts: z.array(z.string()).default([]),
});
const ToolFailed = z.object({ tool: z.string(), kind: z.string(), message: z.string(), retryable: z.boolean() });
const ToolTimedOut = z.object({ tool: z.string(), timeoutMs: z.number().int().positive() });

const EffectIntended = z.object({ tool: z.string(), idempotencyKey: z.string(), summary: z.string() });
const EffectCommitted = z.object({ idempotencyKey: z.string(), remoteRef: z.string().nullable() });
const EffectCompensated = z.object({ idempotencyKey: z.string(), reason: z.string() });

const ApprovalRequested = z.object({
  tool: z.string(),
  preview: z.string(),
  risk: z.enum(['safe', 'caution', 'dangerous']),
  requestedTrust: TrustLevelSchema,
});
const ApprovalGranted = z.object({ scope: z.enum(['once', 'session', 'shape', 'always']) });
const ApprovalDenied = z.object({ scope: z.enum(['once', 'always']), reason: z.string().optional() });
const ApprovalExpired = z.object({ afterMs: z.number().int().nonnegative() });

const PolicyDenied = z.object({
  tool: z.string(),
  missing: z.array(z.string()),
  effectiveTrust: TrustLevelSchema,
  explanation: z.string(),
});
const PolicyEscalated = z.object({
  tool: z.string(),
  from: TrustLevelSchema,
  requested: z.array(z.string()),
  /** The untrusted text that is asking for more power — the user must see it. */
  askingContent: z.string(),
});

const VaultSecretCreated = z.object({ name: z.string(), version: z.number().int().positive() });
const VaultSecretRead = z.object({ ref: z.string(), tool: z.string().nullable() });
const VaultSecretRotated = z.object({ name: z.string(), version: z.number().int().positive() });
const VaultSecretDestroyed = z.object({ name: z.string(), version: z.number().int().positive().nullable() });

const MemoryObserved = z.object({ candidates: z.number().int().nonnegative(), episodeId: z.string() });
const MemoryWritten = z.object({
  factId: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: Json,
  basis: BasisSchema,
  confidence: z.number().min(0).max(1),
  sources: z.array(SourceRefSchema).min(1),
  validFrom: z.number().int(),
  validTo: z.number().int().nullable().default(null),
  stability: StabilitySchema.default('slow'),
  sensitivity: SensitivitySchema.default('normal'),
  status: FactStatusSchema.default('active'),
});
const MemoryUpdated = z.object({
  factId: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  observationCount: z.number().int().nonnegative().optional(),
  status: FactStatusSchema.optional(),
  pinned: z.boolean().optional(),
});
const MemorySuperseded = z.object({
  factId: z.string(),
  supersededBy: z.string(),
  /** When the old value stopped being true in the world, not when we learned. */
  validTo: z.number().int(),
});
const MemoryRecalled = z.object({
  query: z.string(),
  candidates: z.number().int().nonnegative(),
  selected: z.array(z.string()),
  weights: z.record(z.number()),
});
const MemoryForgotten = z.object({
  factId: z.string(),
  keyId: z.string(),
  reason: z.string(),
  /** Crypto-shred: the row may survive, the key does not (§13.3). */
  shredded: z.boolean(),
});
const MemoryCorrected = z.object({ factId: z.string(), was: Json, now: Json, by: z.string() });
const MemoryDisputed = z.object({ factId: z.string(), against: z.string(), reason: z.string() });

const ContextAssembled = z.object({
  digest: z.string(),
  totalTokens: z.number().int().nonnegative(),
  blocks: z.array(
    z.object({
      name: z.string(),
      tokens: z.number().int().nonnegative(),
      items: z.number().int().nonnegative(),
    }),
  ),
  drops: z.array(z.object({ block: z.string(), dropped: z.number().int(), reason: z.string() })),
  policyVersion: z.string(),
});

const ArtifactCreated = z.object({
  artifactId: z.string(),
  kind: z.string(),
  bytes: z.number().int().nonnegative(),
  summary: z.string(),
});

const ScheduleFired = z.object({ scheduleId: z.string(), scheduledFor: z.number().int() });
const ScheduleMissed = z.object({ scheduleId: z.string(), scheduledFor: z.number().int(), policy: z.string() });

const CalibrationProbed = z.object({ factId: z.string().nullable(), question: z.string() });
const CalibrationAnswered = z.object({
  factId: z.string().nullable(),
  answer: z.enum(['confirmed', 'corrected', 'declined', 'unknown']),
});

const ErrorRaised = z.object({ kind: z.string(), message: z.string(), fatal: z.boolean() });

/** Entity graph writes are their own events so the graph is rebuildable. */
const EntityUpserted = z.object({
  entityId: z.string(),
  kind: z.enum(['person', 'project', 'org', 'place', 'device', 'account', 'self', 'other']),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
const EntityMerged = z.object({ from: z.string(), into: z.string(), reason: z.string() });

/* ───────────────────────────── the registry ───────────────────────────────── */

export const EVENT_SCHEMAS = {
  'session.created': SessionCreated,
  'session.titled': SessionTitled,
  'session.archived': SessionArchived,
  'session.locked': SessionLocked,

  'message.user': MessageUser,
  'message.agent': MessageAgent,
  'message.system': MessageSystem,

  'run.started': RunStarted,
  'run.finished': RunFinished,
  'run.failed': RunFailed,
  'run.cancelled': RunCancelled,
  'run.suspended': RunSuspended,
  'run.resumed': RunResumed,
  'run.degraded': RunDegraded,

  'step.started': StepStarted,
  'step.finished': StepFinished,

  'model.requested': ModelRequested,
  'model.responded': ModelResponded,
  'model.failed': ModelFailed,

  'tool.requested': ToolRequested,
  'tool.started': ToolStarted,
  'tool.succeeded': ToolSucceeded,
  'tool.failed': ToolFailed,
  'tool.timedout': ToolTimedOut,

  'effect.intended': EffectIntended,
  'effect.committed': EffectCommitted,
  'effect.compensated': EffectCompensated,

  'approval.requested': ApprovalRequested,
  'approval.granted': ApprovalGranted,
  'approval.denied': ApprovalDenied,
  'approval.expired': ApprovalExpired,

  'policy.denied': PolicyDenied,
  'policy.escalated': PolicyEscalated,

  'vault.secret.created': VaultSecretCreated,
  'vault.secret.read': VaultSecretRead,
  'vault.secret.rotated': VaultSecretRotated,
  'vault.secret.destroyed': VaultSecretDestroyed,

  'memory.observed': MemoryObserved,
  'memory.written': MemoryWritten,
  'memory.updated': MemoryUpdated,
  'memory.superseded': MemorySuperseded,
  'memory.recalled': MemoryRecalled,
  'memory.forgotten': MemoryForgotten,
  'memory.corrected': MemoryCorrected,
  'memory.disputed': MemoryDisputed,

  'entity.upserted': EntityUpserted,
  'entity.merged': EntityMerged,

  'context.assembled': ContextAssembled,
  'artifact.created': ArtifactCreated,

  'schedule.fired': ScheduleFired,
  'schedule.missed': ScheduleMissed,

  'calibration.probed': CalibrationProbed,
  'calibration.answered': CalibrationAnswered,

  'error.raised': ErrorRaised,
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];

/** Payload type for a given event type, derived from the schema — never hand-written. */
export type PayloadOf<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
/** What a caller passes in (before zod applies defaults). */
export type PayloadInput<T extends EventType> = z.input<(typeof EVENT_SCHEMAS)[T]>;

export function isEventType(t: string): t is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, t);
}

/**
 * The current schema version per event type. Bumping one means writing an
 * upcaster in `migrations/` — old rows are never rewritten (§9).
 */
export const CURRENT_SCHEMA_VERSION: Partial<Record<EventType, number>> = {
  // every type defaults to 1; list only the ones that have moved on
};

export function currentVersionOf(type: EventType): number {
  return CURRENT_SCHEMA_VERSION[type] ?? 1;
}
