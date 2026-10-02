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
/**
 * Every run says *why* it stopped (invariant 15: no unexplained output).
 * "The run ended" with no reason is the kind of gap that turns a five-minute
 * diagnosis into an afternoon. Added at M2 with a default so payloads written
 * before the field existed still parse — see decision 015.
 */
export const STOP_REASONS = [
  'stop',
  'step-cap',
  'token-cap',
  'time-cap',
  'cost-cap',
  'tools-unavailable',
  'loop-detected',
  // M4 budgets (§19). One reason per dimension rather than a single
  // 'budget-cap': "it stopped" is not an explanation (invariant 15), and
  // "you have spent today's token budget" leads somewhere different from
  // "this run made too many tool calls".
  'egress-cap',
  'tool-cap',
  'daily-cap',
  'denied',
  'approval-expired',
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);

const RunFinished = z.object({
  steps: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
  reason: StopReasonSchema.default('stop'),
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

/**
 * One outbound request that was allowed, with its size.
 *
 * Added at M4 (decision 021). §9 says the type list is closed and extended
 * deliberately — this is the deliberate extension. Two reasons it has to be
 * an event rather than a counter: §19 requires a *daily* egress budget, and
 * a number that is not in the log cannot be rebuilt (invariant 1); and §14's
 * audit question — "what did my agent talk to, and how much did it send?" —
 * is unanswerable without a positive record. Denials are already logged as
 * `policy.denied`; this is their counterpart.
 */
const EgressAllowed = z.object({
  tool: z.string(),
  host: z.string(),
  method: z.string(),
  bytes: z.number().int().nonnegative(),
  requestBytes: z.number().int().nonnegative().default(0),
  status: z.number().int().optional(),
});

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

/**
 * §9's event set does not name the procedural store's lifecycle, and §22.3
 * requires one: a rule is "retired with an event". Four additions, argued in
 * decision 027 rather than slipped in.
 *
 * `memory.rejected` is the one I would defend hardest. §22.5 gates writes
 * aggressively — no source span, hypothetical framing, protected attributes,
 * "don't remember this". A refusal that leaves no trace is indistinguishable
 * from an extraction that never happened, so "why don't you know that?" has
 * no answer and the gate cannot be audited for over-rejection.
 */
const MemoryRejected = z.object({
  reason: z.string(),
  predicate: z.string(),
  /** Never the rejected value itself: refusing to store it and then logging
      it verbatim would be theatre. */
  subjectHint: z.string(),
  episodeId: z.string().optional(),
});
const MemoryConsolidated = z.object({
  episodes: z.number().int().nonnegative(),
  factsWritten: z.number().int().nonnegative(),
  factsDecayed: z.number().int().nonnegative(),
  rulesRetired: z.number().int().nonnegative(),
  identityTokens: z.number().int().nonnegative(),
  digest: z.string(),
});
const EpisodeRecorded = z.object({
  episodeId: z.string(),
  outcome: z.enum(['satisfied', 'corrected', 'abandoned', 'unknown']),
  actions: z.array(z.string()),
});
const RuleLearned = z.object({
  ruleId: z.string(),
  instruction: z.string(),
  trigger: z.string(),
  confidence: z.number().min(0).max(1),
});
const RuleApplied = z.object({ ruleId: z.string(), applied: z.number().int().nonnegative() });
const RuleOverridden = z.object({
  ruleId: z.string(),
  overridden: z.number().int().nonnegative(),
  status: z.enum(['active', 'probation', 'retired']),
});
const RuleRetired = z.object({ ruleId: z.string(), reason: z.string() });
const MemoryDisputed = z.object({ factId: z.string(), against: z.string(), reason: z.string() });

/**
 * §23 compaction. A deliberate addition to §9's event list, with the reason
 * written down (decision 024): a summary that lives anywhere but the log
 * would have to be recomputed on every restart — which costs money, is
 * nondeterministic, and would make the context a function of when you asked
 * rather than of what happened.
 */
const HistoryCompacted = z.object({
  chunkId: z.string(),
  fromEventId: z.string(),
  toEventId: z.string(),
  turnCount: z.number().int().positive(),
  tokensBefore: z.number().int().nonnegative(),
  tokensAfter: z.number().int().nonnegative(),
  summarizer: z.string(),
  summary: z.object({
    decisions: z.array(z.string()),
    openThreads: z.array(z.string()),
    entities: z.array(z.string()),
    unresolvedQuestions: z.array(z.string()),
    span: z.object({
      fromEventId: z.string(),
      toEventId: z.string(),
      turnCount: z.number().int().positive(),
      fromTime: z.number().int().nonnegative(),
      toTime: z.number().int().nonnegative(),
    }),
  }),
});

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
  /**
   * The window this was assembled against (M9). Added so context
   * utilization is a fact rather than something inferred from a version
   * string; defaults to 0 for events written before it existed, which
   * read as "unknown" rather than as "0% used".
   */
  window: z.number().int().nonnegative().default(0),
});

const ArtifactCreated = z.object({
  artifactId: z.string(),
  kind: z.string(),
  bytes: z.number().int().nonnegative(),
  summary: z.string(),
});

const ScheduleFired = z.object({ scheduleId: z.string(), scheduledFor: z.number().int() });
const ScheduleMissed = z.object({ scheduleId: z.string(), scheduledFor: z.number().int(), policy: z.string() });

/**
 * §28's queue and scheduler, as events (M8, decision 033).
 *
 * A job's *life* is in the log — enqueued, started, succeeded, failed,
 * dead-lettered — and the `jobs` table is a projection of it. A **lease is
 * deliberately not here**: it is a sixty-second claim by a process that may
 * already be dead, and an append-only log of claims that are false moments
 * later is not a record of anything. On rebuild every lease is empty, which
 * is correct, because a rebuild implies a restart and a restart voids every
 * claim.
 */
const JobEnqueued = z.object({
  jobId: z.string(),
  kind: z.string(),
  payload: z.record(z.unknown()),
  runAfter: z.number().int(),
  priority: z.number().int(),
  idempotencyKey: z.string().nullable(),
  scheduleId: z.string().nullable(),
});
const JobStarted = z.object({ jobId: z.string(), attempt: z.number().int().positive() });
const JobSucceeded = z.object({ jobId: z.string(), attempt: z.number().int().positive(), ms: z.number().int().nonnegative() });
const JobFailed = z.object({
  jobId: z.string(),
  attempt: z.number().int().positive(),
  error: z.string(),
  retryAt: z.number().int().nullable(),
});
const JobDeadLettered = z.object({ jobId: z.string(), attempts: z.number().int().positive(), error: z.string() });

/**
 * §32's budgets, measured rather than assumed (M9).
 *
 * A timing is state: it is how the system behaved at an instant, and the
 * only honest place for it is the same log as everything else. Sampled,
 * not recorded for every call — see `PERF_SAMPLE_EVERY`.
 */
const PerfSampled = z.object({
  stage: z.enum(['context.assembly', 'memory.recall', 'first.token', 'event.append']),
  ms: z.number().nonnegative(),
  detail: z.string().optional(),
});

/** A recalled fact that actually made it into the answer's context (M9). */
const MemoryUsed = z.object({
  factIds: z.array(z.string()),
  offered: z.number().int().nonnegative(),
});

const PersonaUpdated = z.object({
  persona: z.object({
    agentName: z.string(),
    addressUser: z.string(),
    formality: z.enum(['plain', 'warm', 'formal']),
    length: z.enum(['brief', 'normal', 'thorough']),
    emoji: z.boolean(),
    language: z.string(),
    notes: z.string(),
  }),
  version: z.number().int().positive(),
  changed: z.array(z.string()),
});

/**
 * S1's calendar. `cancelled` carries the id only: the event it closes
 * is already in the log with everything else about it, and repeating
 * the payload would let the two copies disagree.
 */
const CalendarAdded = z.object({
  eventId: z.string(),
  title: z.string(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  allDay: z.boolean(),
  timezone: z.string(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
});
const CalendarCancelled = z.object({ eventId: z.string() });

/**
 * S2's tasks. `completed` and `dropped` are separate event types rather
 * than one `task.closed` with a reason field, because they are
 * different facts about the world and the log is the place that
 * distinction has to survive: "I did it" and "this stopped being worth
 * doing" answer different questions about an old list.
 */
const TaskAdded = z.object({
  taskId: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  dueAt: z.number().int().nullable(),
});
const TaskCompleted = z.object({ taskId: z.string() });
const TaskDropped = z.object({ taskId: z.string() });

const ScheduleCreated = z.object({
  scheduleId: z.string(),
  name: z.string(),
  spec: z.string(),
  timezone: z.string(),
  kind: z.enum(['cron', 'once']),
  payload: z.record(z.unknown()),
  catchUp: z.enum(['fire-all', 'fire-once', 'skip']),
  nextFireAt: z.number().int().nullable(),
});
const ScheduleUpdated = z.object({
  scheduleId: z.string(),
  changed: z.array(z.string()),
  spec: z.string(),
  timezone: z.string(),
  catchUp: z.enum(['fire-all', 'fire-once', 'skip']),
  enabled: z.boolean(),
  nextFireAt: z.number().int().nullable(),
});
const ScheduleDeleted = z.object({ scheduleId: z.string() });

/**
 * §27: "Each transition is an event. Silent degradation is forbidden."
 * Transitions only — a flapping embedder must not be able to flood the log.
 */
const DegradationChanged = z.object({
  from: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  to: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']),
  signal: z.string(),
  detail: z.string(),
  active: z.array(z.string()),
});

const CalibrationProbed = z.object({ factId: z.string().nullable(), question: z.string() });
const CalibrationAnswered = z.object({
  factId: z.string().nullable(),
  answer: z.enum(['confirmed', 'corrected', 'declined', 'unknown']),
});

/**
 * §25's constitution, as events (decision 030).
 *
 * §25 is one sentence long on this point and it is the load-bearing one:
 * "Every change to either is an event, so 'the agent started talking
 * differently on this date, because of this' is always answerable." A
 * document stored as a row that gets UPDATEd cannot answer it. So the
 * document is a projection and these five types are the only way it moves.
 *
 * `constitution.enforced` is the odd one out: it is not a change to the
 * document, it is a reading of the document against one model response. It
 * lives here rather than under `model.*` because the question it answers —
 * "which articles were in force, and did the output honour them?" — is about
 * the contract, not about the provider.
 */
const ConstitutionArticleRecord = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  origin: z.enum(['founding', 'user', 'proposed']),
  kind: z.enum(['directive', 'prohibition', 'disclosure', 'style']),
  enforcement: z.enum(['advisory', 'checked', 'structural']),
  check: z.string().nullable().default(null),
  remedy: z.enum(['annotate', 'revise', 'block', 'none']).default('none'),
  /** For `structural` articles: the module that actually enforces this. */
  enforcedBy: z.string().default(''),
  entrenched: z.boolean().default(false),
  subject: z.string().default('general'),
  stance: z.enum(['require', 'forbid', 'prefer']).default('require'),
  cites: z.string().default(''),
});

const ConstitutionRatified = z.object({
  version: z.number().int().positive(),
  hash: z.string(),
  articles: z.array(ConstitutionArticleRecord).min(1),
  reason: z.string().default('founding charter'),
});

const ConstitutionAmended = z.object({
  version: z.number().int().positive(),
  hash: z.string(),
  change: z.enum(['added', 'edited', 'repealed', 'reordered']),
  articleId: z.string().min(1),
  /** The article as it was. Null for `added`. */
  before: ConstitutionArticleRecord.nullable().default(null),
  /** The article as it now is. Null for `repealed`. */
  after: ConstitutionArticleRecord.nullable().default(null),
  author: z.string().min(1),
});

const ConstitutionProposed = z.object({
  proposalId: z.string().min(1),
  article: ConstitutionArticleRecord,
  rationale: z.string(),
  /** What made the agent think of it — a rule id, usually. */
  derivedFrom: z.string().default(''),
});

const ConstitutionDismissed = z.object({
  proposalId: z.string().min(1),
  /** Hash of the proposed text, so the same body cannot come back. */
  bodyHash: z.string().min(1),
  reason: z.string().default('dismissed by principal'),
});

const ConstitutionEnforced = z.object({
  runId: z.string(),
  stepId: z.string().default(''),
  version: z.number().int().nonnegative(),
  hash: z.string(),
  verdicts: z.array(
    z.object({
      articleId: z.string(),
      check: z.string(),
      verdict: z.enum(['upheld', 'violated', 'unverifiable']),
      detail: z.string().default(''),
    }),
  ),
  remedy: z.enum(['none', 'annotate', 'revise', 'block']).default('none'),
  /** True when a blocking article forced the stream to be buffered (§2.4). */
  buffered: z.boolean().default(false),
});

/** §24.1: the Brier score of everything that has actually been resolved. */
const CalibrationScored = z.object({
  brier: z.number(),
  resolved: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  withinThreshold: z.boolean(),
  windowFrom: z.number().int().nonnegative(),
  windowTo: z.number().int().nonnegative(),
});

/** §24.3: the five metrics, computed in consolidation. */
const BiasAudited = z.object({
  agreementRate: z.number(),
  positionFlipRate: z.number(),
  sourceDiversity: z.number(),
  protectedAttributeHits: z.array(z.string()).default([]),
  staleness: z.number(),
  turns: z.number().int().nonnegative(),
  regressions: z.array(z.string()).default([]),
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

  'egress.allowed': EgressAllowed,

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
  'memory.rejected': MemoryRejected,
  'memory.consolidated': MemoryConsolidated,
  'episode.recorded': EpisodeRecorded,
  'rule.learned': RuleLearned,
  'rule.applied': RuleApplied,
  'rule.overridden': RuleOverridden,
  'rule.retired': RuleRetired,

  'entity.upserted': EntityUpserted,
  'entity.merged': EntityMerged,

  'context.assembled': ContextAssembled,
  'history.compacted': HistoryCompacted,
  'artifact.created': ArtifactCreated,

  'schedule.fired': ScheduleFired,
  'schedule.missed': ScheduleMissed,
  'calendar.added': CalendarAdded,
  'calendar.cancelled': CalendarCancelled,
  'task.added': TaskAdded,
  'task.completed': TaskCompleted,
  'task.dropped': TaskDropped,

  'schedule.created': ScheduleCreated,
  'schedule.updated': ScheduleUpdated,
  'schedule.deleted': ScheduleDeleted,

  'job.enqueued': JobEnqueued,
  'job.started': JobStarted,
  'job.succeeded': JobSucceeded,
  'job.failed': JobFailed,
  'job.deadlettered': JobDeadLettered,

  'degradation.changed': DegradationChanged,

  'persona.updated': PersonaUpdated,
  'perf.sampled': PerfSampled,
  'memory.used': MemoryUsed,

  'calibration.probed': CalibrationProbed,
  'calibration.answered': CalibrationAnswered,
  'calibration.scored': CalibrationScored,
  'bias.audited': BiasAudited,

  'constitution.ratified': ConstitutionRatified,
  'constitution.amended': ConstitutionAmended,
  'constitution.proposed': ConstitutionProposed,
  'constitution.dismissed': ConstitutionDismissed,
  'constitution.enforced': ConstitutionEnforced,

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
