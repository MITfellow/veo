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
  /** Present when consolidation did it; absent when a human did. */
  reason: z.string().max(200).optional(),
}).strict();

const FactRetracted = z.object({ factId: z.string().min(1), reason: z.string() }).strict();

/**
 * A correction: the belief was wrong, the world did not change.
 *
 * Distinct from `fact.superseded` on purpose. Superseding closes *valid*
 * time — "I moved to Berlin". Correcting closes *transaction* time —
 * "I never lived in Berlin, you misheard". A store with one event for both
 * cannot answer "what did you believe in March" without lying.
 */
const FactCorrected = z.object({
  factId: z.string().min(1),
  correctedBy: z.string().min(1),
  reason: z.string().max(200),
}).strict();

const FactPinning = z.object({ factId: z.string().min(1), reason: z.string().max(200).default('') }).strict();

const EntityRenamed = z.object({
  entityId: z.string().min(1),
  name: z.string().min(1),
  /** The previous name, kept as an alias so old references still resolve. */
  previousName: z.string().min(1),
  normalizedPrevious: z.string().min(1),
}).strict();

const EntityMerged = z.object({
  entityId: z.string().min(1),
  canonicalId: z.string().min(1),
  /** Names the absorbed entity answered to, which the canonical one inherits. */
  aliases: z.array(z.object({ alias: z.string().min(1), normalized: z.string().min(1) }).strict()).default([]),
}).strict();

/**
 * An item of content the user can ask to have forgotten.
 *
 * Metadata only. The content is sealed under the item's own key and lives
 * in `item_blobs`, which is not a projection — no replay reconstructs
 * ciphertext, and `rebuild` must not drop it. `bytes` is the sealed length,
 * which leaks a rough size and nothing else.
 */
const ArtifactCreated = z.object({
  itemId: z.string().min(1),
  kind: z.enum(['note', 'capture', 'document', 'transcript']),
  label: z.string().max(120),
  keyId: z.string().min(1),
  bytes: z.number().int().min(0),
}).strict();

const ArtifactDeleted = z.object({
  itemId: z.string().min(1),
  /** `shredded` means the key is gone. There is no other kind. */
  how: z.literal('shredded'),
}).strict();

/**
 * The sealed plan (§22), as an event.
 *
 * Recorded before anything is read, which is the whole point: the log shows
 * what the agent agreed to do *before* it saw the page that might have
 * wanted it to do something else. The seal makes tampering afterwards
 * detectable without re-deriving anything.
 */
const RunPlanned = z.object({
  goal: z.string().min(1),
  /**
   * What the plan authorises. For browsing these are action kinds; for a
   * general run they are tool names. One concept, deliberately: a plan
   * fixes what may be done before anything is read (§22).
   */
  allowedKinds: z.array(z.string().min(1)),
  maxSteps: z.number().int().min(1),
  allowedOrigins: z.array(z.string()).default([]),
  carriesPrivateData: z.boolean(),
  autonomy: z.number().int().min(0).max(4),
  seal: z.string().min(1),
}).strict();

/**
 * A tool call. Decision 010: browsing is not a special case.
 *
 * `action` is a short human-readable summary and `target` is a *bounded*
 * reference — an origin, a ref, a form index. Never page prose: the log is
 * read by the privileged path on replay, so anything that could not be
 * trusted in a prompt must not be in here either.
 */
const ToolInvoked = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  action: z.string().max(200),
  target: z.string().max(200).nullable().default(null),
  tier: z.enum(['observe', 'interact', 'effect']),
}).strict();

const ToolSucceeded = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  detail: z.string().max(200).default(''),
}).strict();

const ToolFailed = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  kind: z.string().min(1),
  detail: z.string().max(400).default(''),
}).strict();

const ToolDenied = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  code: z.string().min(1),
  reason: z.string().max(400),
}).strict();
const FactUsed = z.object({ factId: z.string().min(1), usedFor: z.string() }).strict();

const EntityCreated = z.object({
  entityId: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
}).strict();

// ---- M1: security (§23, §21, §19). Values never appear in any of these. ----

const VaultLifecycle = z.object({ reason: z.enum(['explicit', 'idle', 'init', 'recovery']) }).strict();

const SecretCreated = z.object({
  reference: z.string().regex(/^secret:\/\/[^/]+\/\d+$/),
  name: z.string().min(1),
  version: z.number().int().min(1),
}).strict();

const SecretRead = z.object({
  reference: z.string().min(1),
  principal: z.string().min(1),
  runId: z.string().nullable().default(null),
  tool: z.string().nullable().default(null),
}).strict();

const SecretDestroyed = z.object({
  /** The shred tombstone. Auditable; the content is gone (invariant 10). */
  keyId: z.string().min(1),
  scope: z.enum(['item', 'vault']),
}).strict();

const QuarantineEntered = z.object({
  refId: z.string().min(1),
  source: z.string().min(1),
  bytes: z.number().int().min(0),
}).strict();

const QuarantineExtracted = z.object({
  refId: z.string().min(1),
  kind: z.string().min(1),
  /** Field NAMES only. A value here would defeat the whole channel (§21). */
  fields: z.array(z.string()),
}).strict();

const QuarantineReleased = z.object({
  refId: z.string().min(1),
  to: z.string().min(1),
}).strict();

const PolicyDenied = z.object({
  rule: z.string().min(1),
  detail: z.string(),
  capabilities: z.array(z.string()).default([]),
}).strict();

const RuleOfTwoBlocked = z.object({
  untrustedInput: z.boolean(),
  sensitiveAccess: z.boolean(),
  externalChange: z.boolean(),
  tool: z.string().nullable().default(null),
}).strict();

const TrustDowngraded = z.object({
  from: TrustLevelSchema,
  to: TrustLevelSchema,
  reason: z.string().min(1),
}).strict();

const SystemLifecycle = z.object({ version: z.string().min(1) }).strict();
const MigrationApplied = z.object({ version: z.number().int(), name: z.string().min(1) }).strict();
const ProjectionRebuilt = z.object({ projector: z.string().min(1), events: z.number().int().min(0) }).strict();


// ───────────────────────────────────────────────── M3: runs, steps, approvals

const RunEnded = z.object({
  reason: z.string().max(200),
  steps: z.number().int().min(0).default(0),
}).strict();

const RunStep = z.object({
  stepIndex: z.number().int().min(0),
  tool: z.string().min(1),
  tier: z.enum(['observe', 'interact', 'effect']),
  /** Terminal only. Bounded, and never the tool's own prose (decision 010). */
  outcome: z.enum(['succeeded', 'failed', 'denied', 'skipped']).optional(),
}).strict();

/**
 * A dry run. Deliberately *not* `tool.invoked`.
 *
 * The whole point of a dry run is that nothing happened, and a log where
 * the two are the same event cannot answer "did it actually send it".
 */
const ToolDryRun = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  /** What it would have done, from the tool's own `preview`. */
  preview: z.string().max(200),
  tier: z.enum(['observe', 'interact', 'effect']),
}).strict();

/**
 * An approval names the *specific* step (§30).
 *
 * `stepSeal` binds it to one step of one plan, so a yes cannot be replayed
 * against a different action. A generic standing "yes" is a different
 * feature and is not this one.
 */
const ApprovalRequested = z.object({
  approvalId: z.string().min(1),
  stepSeal: z.string().min(1),
  tool: z.string().min(1),
  action: z.string().max(200),
  needs: z.number().int().min(0).max(4),
  triple: z.object({
    untrustedInput: z.boolean(),
    sensitiveAccess: z.boolean(),
    externalChange: z.boolean(),
  }).strict(),
  expiresAt: z.number().int(),
}).strict();

const ApprovalSettled = z.object({
  approvalId: z.string().min(1),
  /** Who said so. An agent approving itself is refused before this is written. */
  by: z.string().min(1),
  reason: z.string().max(200).default(''),
}).strict();

const EgressAttempted = z.object({
  /** The origin only. A path or query string is where private data hides (§21). */
  origin: z.string().min(1),
  method: z.string().min(1),
  bytes: z.number().int().min(0),
}).strict();

const EgressBlocked = z.object({
  origin: z.string().min(1),
  reason: z.string().max(200),
}).strict();

const BudgetExceeded = z.object({
  budget: z.enum(['steps', 'wallClock', 'toolCalls', 'approvals']),
  limit: z.number(),
  reached: z.number(),
}).strict();

const PolicyEvaluated = z.object({
  tool: z.string().min(1),
  decision: z.enum(['allowed', 'supervised', 'denied']),
  code: z.string().min(1),
  rung: z.number().int().min(0).max(4),
}).strict();

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
  ['run.planned', RunPlanned as PayloadSchema],
  ['run.failed', RunEnded as PayloadSchema],
  ['run.cancelled', RunEnded as PayloadSchema],
  ['run.step.started', RunStep as PayloadSchema],
  ['run.step.finished', RunStep as PayloadSchema],
  ['tool.dryrun', ToolDryRun as PayloadSchema],
  ['approval.requested', ApprovalRequested as PayloadSchema],
  ['approval.granted', ApprovalSettled as PayloadSchema],
  ['approval.denied', ApprovalSettled as PayloadSchema],
  ['approval.expired', ApprovalSettled as PayloadSchema],
  ['egress.attempted', EgressAttempted as PayloadSchema],
  ['egress.blocked', EgressBlocked as PayloadSchema],
  ['budget.exceeded', BudgetExceeded as PayloadSchema],
  ['policy.evaluated', PolicyEvaluated as PayloadSchema],
  ['tool.invoked', ToolInvoked as PayloadSchema],
  ['tool.succeeded', ToolSucceeded as PayloadSchema],
  ['tool.failed', ToolFailed as PayloadSchema],
  ['tool.denied', ToolDenied as PayloadSchema],
  ['fact.asserted', FactAsserted as PayloadSchema],
  ['fact.superseded', FactSuperseded as PayloadSchema],
  ['fact.retracted', FactRetracted as PayloadSchema],
  ['fact.corrected', FactCorrected as PayloadSchema],
  ['fact.pinned', FactPinning as PayloadSchema],
  ['fact.unpinned', FactPinning as PayloadSchema],
  ['entity.renamed', EntityRenamed as PayloadSchema],
  ['entity.merged', EntityMerged as PayloadSchema],
  ['artifact.created', ArtifactCreated as PayloadSchema],
  ['artifact.deleted', ArtifactDeleted as PayloadSchema],
  ['fact.used', FactUsed as PayloadSchema],
  ['entity.created', EntityCreated as PayloadSchema],
  ['vault.unlocked', VaultLifecycle as PayloadSchema],
  ['vault.locked', VaultLifecycle as PayloadSchema],
  ['vault.secret.created', SecretCreated as PayloadSchema],
  ['vault.secret.read', SecretRead as PayloadSchema],
  ['vault.secret.destroyed', SecretDestroyed as PayloadSchema],
  ['quarantine.entered', QuarantineEntered as PayloadSchema],
  ['quarantine.extracted', QuarantineExtracted as PayloadSchema],
  ['quarantine.released', QuarantineReleased as PayloadSchema],
  ['policy.denied', PolicyDenied as PayloadSchema],
  ['policy.ruleoftwo-blocked', RuleOfTwoBlocked as PayloadSchema],
  ['trust.downgraded', TrustDowngraded as PayloadSchema],
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
