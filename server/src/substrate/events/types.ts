import { z } from 'zod';

/**
 * §15 — the event log.
 *
 * The type union below is **complete and closed** even though most of these
 * families cannot be appended yet: their payload schemas arrive with the
 * milestone that emits them, and `append()` refuses a type with no schema.
 * See `docs/decisions/003-closed-event-union-open-payload-registry.md` for
 * why naming and schema have different lifetimes.
 */
export const EVENT_TYPES = [
  // session
  'session.started', 'session.ended', 'session.titled',
  // message
  'message.received', 'message.sent',
  // capture (§21 — untrusted content lands, it does not instruct)
  'capture.received', 'capture.quarantined', 'capture.released',
  // run (§22 — plan then execute)
  'run.started', 'run.planned', 'run.step.started', 'run.step.finished',
  'run.finished', 'run.failed', 'run.cancelled',
  // cognition (§33 — jobs, never "the model")
  'job.requested', 'job.completed', 'job.failed', 'job.fellback',
  // tool
  'tool.invoked', 'tool.succeeded', 'tool.failed', 'tool.denied', 'tool.dryrun',
  // memory (§17, §18)
  'fact.asserted', 'fact.superseded', 'fact.retracted', 'fact.corrected',
  'fact.pinned', 'fact.unpinned', 'fact.used', 'fact.merged',
  // entity
  'entity.created', 'entity.merged', 'entity.renamed',
  // policy and trust (§19, §20)
  'policy.evaluated', 'policy.denied', 'trust.downgraded',
  // approval (§30 autonomy ladder)
  'approval.requested', 'approval.granted', 'approval.denied', 'approval.expired',
  // scheduling
  'schedule.created', 'schedule.fired', 'schedule.cancelled',
  // artifacts
  'artifact.created', 'artifact.deleted',
  // vault (M1)
  'vault.unlocked', 'vault.locked', 'vault.rotated',
  'vault.secret.created', 'vault.secret.read', 'vault.secret.destroyed',
  // quarantine (§21)
  'quarantine.entered', 'quarantine.extracted', 'quarantine.released',
  // policy (§19, §29)
  'policy.ruleoftwo-blocked',
  // egress — declared so that a future network call cannot be unlogged
  'egress.attempted', 'egress.blocked',
  // budgets and degradation (§27)
  'budget.exceeded', 'degradation.changed',
  // completion gates (§36 — default FAIL)
  'gate.passed', 'gate.failed',
  // rules (§33 rule.induce)
  'rule.proposed', 'rule.accepted', 'rule.rejected', 'rule.fired',
  // briefs and drafts
  'brief.composed', 'draft.composed',
  // lifecycle
  'system.started', 'system.stopped', 'migration.applied', 'projection.rebuilt',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);
export function isEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

/**
 * §20 — the trust lattice. Ordered weakest to strongest.
 *
 * Trust is monotonically non-increasing along a run: the effective level is
 * the minimum of everything that contributed. FOREIGN is content the user did
 * not write and the system did not derive; it is never an instruction.
 */
export const TRUST_LEVELS = ['FOREIGN', 'TOOL', 'DERIVED', 'USER', 'SYSTEM'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

const TRUST_RANK: Record<TrustLevel, number> = {
  FOREIGN: 0, TOOL: 1, DERIVED: 2, USER: 3, SYSTEM: 4,
};

/** The weaker of two levels. Combining trust can only ever lose it. */
export function meetTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return TRUST_RANK[a] <= TRUST_RANK[b] ? a : b;
}

/** True when `actual` is at least as trusted as `required`. */
export function permitted(required: TrustLevel, actual: TrustLevel): boolean {
  return TRUST_RANK[actual] >= TRUST_RANK[required];
}

export const TrustLevelSchema = z.enum(TRUST_LEVELS);

/**
 * The event envelope.
 *
 * `seq` is assigned by the database inside the append transaction and is the
 * true total order (§15). `ts` comes from the Clock and, with a fake clock,
 * may repeat or move backwards — so nothing may order by it.
 */
export interface StoredEvent {
  readonly seq: number;
  readonly id: string;
  readonly type: EventType;
  readonly ts: number;
  readonly actor: string;
  readonly trust: TrustLevel;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

/** What a caller supplies. Everything else is derived by the log. */
export interface NewEvent {
  readonly type: EventType;
  readonly actor: string;
  readonly trust: TrustLevel;
  readonly payload: Record<string, unknown>;
  readonly sessionId?: string | undefined;
  readonly runId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly schemaVersion?: number | undefined;
}

/** Filter for `read()`. All fields are conjunctive. */
export interface EventQuery {
  readonly fromSeq?: number;
  readonly toSeq?: number;
  readonly types?: readonly EventType[];
  readonly sessionId?: string;
  readonly runId?: string;
  readonly correlationId?: string;
  readonly trust?: TrustLevel;
  readonly limit?: number;
}

export type EventErrorKind =
  | 'unregistered_event_type'
  | 'invalid_payload'
  | 'chain_broken'
  | 'unknown_schema_version';

export class EventError extends Error {
  constructor(
    readonly kind: EventErrorKind,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EventError';
  }
}
