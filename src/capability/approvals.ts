/**
 * Approvals and durable suspension (§19).
 *
 *   > `risk: 'dangerous'` → emit `approval.requested` with the `dryRun`
 *   > preview, **suspend the run durably**, release all resources. On the
 *   > user's answer, the run resumes **at that step**, not from the
 *   > beginning. This must survive a full process restart.
 *
 * Three requirements hide in that paragraph, and each one rules something
 * out:
 *
 * **"with the dryRun preview"** — the user approves what they were shown. A
 * prompt that says "allow payments.charge?" is a yes/no about a tool name;
 * one that says "would charge $42.00 to the card ending 4242" is consent.
 *
 * **"release all resources"** — no timer, no open promise, no in-memory
 * continuation. The entire resumable state is rows. This is why `suspend()`
 * returns and the run function returns with it, rather than awaiting an
 * answer. A process killed while ten runs are suspended loses nothing,
 * because it was holding nothing.
 *
 * **"at that step, not from the beginning"** — a correctness requirement,
 * not an optimisation. Replaying a run from the top re-executes every tool
 * call it already made, which for anything non-idempotent is the exact
 * double-effect M3 exists to prevent. The resumed run keeps its `runId` and
 * its step sequence, so the outbox keys stay stable and an already-committed
 * effect is recognised as committed.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Ids, Storage } from '../substrate/ports.js';
import type { TrustLevel } from '../substrate/events/types.js';
import type { Risk } from './tool.js';
import type { Spend } from './budgets.js';
import { ZERO_SPEND } from './budgets.js';
import { canonicalJson } from '../substrate/hash.js';

export type ApprovalScope = 'once' | 'session' | 'shape' | 'always';
export type ApprovalState = 'pending' | 'granted' | 'denied' | 'expired';

/** Default window before a pending approval expires: 24 hours. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRequest {
  runId: string;
  stepId: string;
  sessionId: string | null;
  principal: string;
  tool: string;
  toolVersion: string;
  input: unknown;
  /** From `dryRun()`. The user approves this text, not the tool name. */
  preview: string;
  risk: Risk;
  requestedTrust: TrustLevel;
  ttlMs?: number;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stepId: string;
  sessionId: string | null;
  principal: string;
  tool: string;
  toolVersion: string;
  input: unknown;
  preview: string;
  risk: Risk;
  requestedTrust: TrustLevel;
  state: ApprovalState;
  scope: ApprovalScope | null;
  shape: unknown | null;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
  requestedAt: number;
  expiresAt: number;
}

export interface Suspension {
  runId: string;
  sessionId: string;
  principal: string;
  stepId: string;
  stepIndex: number;
  reason: 'approval' | 'ask_user' | 'schedule';
  resumeOn: string;
  spend: Spend;
  suspendedAt: number;
  resumedAt: number | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  step_id: string;
  session_id: string | null;
  principal: string;
  tool: string;
  tool_version: string;
  input_json: string;
  preview: string;
  risk: Risk;
  requested_trust: TrustLevel;
  state: ApprovalState;
  scope: ApprovalScope | null;
  shape_json: string | null;
  decided_by: string | null;
  decided_at: number | null;
  reason: string | null;
  requested_at: number;
  expires_at: number;
}

interface SuspensionRow {
  run_id: string;
  session_id: string;
  principal: string;
  step_id: string;
  step_index: number;
  reason: 'approval' | 'ask_user' | 'schedule';
  resume_on: string;
  spend_json: string;
  suspended_at: number;
  resumed_at: number | null;
}

/* ─────────────────────────── shape matching ────────────────────────────── */

/**
 * The pattern a `shape`-scoped approval matches against.
 *
 * "Approve sending email to ara@example.com, with any body" is a different
 * grant from "approve sending email". The shape is the input object with
 * *pinned* fields keeping their values and everything else wildcarded.
 *
 * Deliberately conservative:
 *   - only top-level scalar fields can be pinned
 *   - a wildcarded field matches any value of the SAME JSON type
 *   - an input with keys the shape has never seen does NOT match
 *
 * The last rule is the one that matters. A shape that matches supersets
 * would let "send to ara, body anything" also approve "send to ara, body
 * anything, bcc attacker@evil.com" the day a bcc field is added to the tool.
 * Narrow and occasionally annoying beats wide and occasionally catastrophic.
 */
export interface Shape {
  tool: string;
  pinned: Record<string, string | number | boolean | null>;
  /** Keys that may vary, with the JSON type they must keep. */
  wildcards: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'null'>;
}

function jsonTypeOf(value: unknown): 'string' | 'number' | 'boolean' | 'object' | 'null' {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

/** Build a shape from one concrete call plus the fields the user pinned. */
export function shapeOf(tool: string, input: unknown, pin: readonly string[]): Shape {
  const object = (input ?? {}) as Record<string, unknown>;
  const pinned: Shape['pinned'] = {};
  const wildcards: Shape['wildcards'] = {};

  for (const [key, value] of Object.entries(object)) {
    if (pin.includes(key)) {
      const type = jsonTypeOf(value);
      if (type === 'object') {
        // Pinning a nested object means comparing structures, which is where
        // a loose matcher becomes a security hole. Refuse rather than guess.
        throw new Error(`cannot pin '${key}': only top-level scalar fields can be pinned`);
      }
      pinned[key] = value as string | number | boolean | null;
    } else {
      wildcards[key] = jsonTypeOf(value);
    }
  }
  return { tool, pinned, wildcards };
}

export function shapeMatches(shape: Shape, tool: string, input: unknown): boolean {
  if (shape.tool !== tool) return false;
  const object = (input ?? {}) as Record<string, unknown>;
  const keys = Object.keys(object);
  const known = new Set([...Object.keys(shape.pinned), ...Object.keys(shape.wildcards)]);

  // An unexpected key is an unapproved call, including the key that did not
  // exist when the approval was granted.
  for (const key of keys) if (!known.has(key)) return false;
  for (const key of known) if (!(key in object)) return false;

  for (const [key, value] of Object.entries(shape.pinned)) {
    if (object[key] !== value) return false;
  }
  for (const [key, type] of Object.entries(shape.wildcards)) {
    if (jsonTypeOf(object[key]) !== type) return false;
  }
  return true;
}

/* ──────────────────────────── the store ────────────────────────────────── */

export interface ApprovalDecision {
  granted: boolean;
  scope: ApprovalScope;
  by: string;
  reason?: string;
  /** Fields to pin when `scope === 'shape'`. */
  pin?: readonly string[];
}

export class ApprovalError extends Error {}

export class ApprovalStore {
  constructor(
    private readonly storage: Storage,
    private readonly events: EventLog,
    private readonly clock: Clock,
    private readonly ids: Ids,
  ) {}

  /* ── requesting ───────────────────────────────────────────────────────── */

  request(request: ApprovalRequest): ApprovalRecord {
    const now = this.clock.now();
    const id = this.ids.ulid();
    const expiresAt = now + (request.ttlMs ?? APPROVAL_TTL_MS);

    this.storage.run(
      `INSERT INTO approvals (
         id, run_id, step_id, session_id, principal, tool, tool_version,
         input_json, preview, risk, requested_trust, state, requested_at, expires_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      [
        id,
        request.runId,
        request.stepId,
        request.sessionId,
        request.principal,
        request.tool,
        request.toolVersion,
        canonicalJson(request.input),
        request.preview,
        request.risk,
        request.requestedTrust,
        now,
        expiresAt,
      ],
    );

    this.events.append({
      type: 'approval.requested',
      payload: {
        tool: request.tool,
        preview: request.preview,
        risk: request.risk,
        requestedTrust: request.requestedTrust,
      },
      principal: request.principal,
      trust: 'SYSTEM',
      ...(request.sessionId !== null ? { sessionId: request.sessionId } : {}),
      runId: request.runId,
      stepId: request.stepId,
      correlationId: request.runId,
    });

    return this.get(id)!;
  }

  /* ── answering ────────────────────────────────────────────────────────── */

  decide(id: string, decision: ApprovalDecision): ApprovalRecord {
    const record = this.get(id);
    if (record === undefined) throw new ApprovalError(`no approval '${id}'`);
    if (record.state !== 'pending') {
      throw new ApprovalError(
        `approval '${id}' was already ${record.state}; a change of mind is a new request`,
      );
    }
    const now = this.clock.now();
    if (now >= record.expiresAt) {
      this.expire(id);
      throw new ApprovalError(`approval '${id}' expired before it was answered`);
    }

    const shape =
      decision.granted && decision.scope === 'shape'
        ? shapeOf(record.tool, record.input, decision.pin ?? [])
        : null;

    this.storage.run(
      `UPDATE approvals
          SET state = ?, scope = ?, shape_json = ?, decided_by = ?, decided_at = ?, reason = ?
        WHERE id = ?`,
      [
        decision.granted ? 'granted' : 'denied',
        decision.scope,
        shape === null ? null : canonicalJson(shape),
        decision.by,
        now,
        decision.reason ?? null,
        id,
      ],
    );

    this.events.append({
      type: decision.granted ? 'approval.granted' : 'approval.denied',
      payload: decision.granted
        ? { scope: decision.scope }
        : {
            // The denial schema admits only once|always: a scoped "no" that
            // is not permanent is a "no, this time".
            scope: decision.scope === 'always' ? 'always' : 'once',
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          },
      principal: decision.by,
      // A human's decision is the highest-trust input there is. This is the
      // one place trust legitimately enters the system from outside.
      trust: 'USER',
      ...(record.sessionId !== null ? { sessionId: record.sessionId } : {}),
      runId: record.runId,
      stepId: record.stepId,
      correlationId: record.runId,
    });

    return this.get(id)!;
  }

  expire(id: string): void {
    const record = this.get(id);
    if (record === undefined || record.state !== 'pending') return;
    this.storage.run(`UPDATE approvals SET state = 'expired', decided_at = ? WHERE id = ?`, [
      this.clock.now(),
      id,
    ]);
    this.events.append({
      type: 'approval.expired',
      payload: { afterMs: this.clock.now() - record.requestedAt },
      principal: record.principal,
      trust: 'SYSTEM',
      ...(record.sessionId !== null ? { sessionId: record.sessionId } : {}),
      runId: record.runId,
      stepId: record.stepId,
      correlationId: record.runId,
    });
  }

  /** Expire everything past its deadline. Called on boot and before reads. */
  expireStale(): string[] {
    const now = this.clock.now();
    const stale = this.storage.all<{ id: string }>(
      `SELECT id FROM approvals WHERE state = 'pending' AND expires_at <= ?`,
      [now],
    );
    for (const row of stale) this.expire(row.id);
    return stale.map((r) => r.id);
  }

  /* ── standing permission ──────────────────────────────────────────────── */

  /**
   * Is this call already covered by something the user said earlier?
   *
   * Checked before asking again, because an assistant that asks the same
   * question every time trains the person to approve without reading, and a
   * reflexive yes is worth nothing when it matters.
   *
   * Denials are checked first: a standing "never" outranks a standing "yes",
   * because the cost of wrongly proceeding is higher than wrongly asking.
   */
  standingDecision(
    tool: string,
    input: unknown,
    sessionId: string | null,
  ): { granted: boolean; via: ApprovalRecord } | null {
    const rows = this.storage.all<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE tool = ? AND state IN ('granted','denied') AND scope IS NOT NULL
        ORDER BY decided_at DESC`,
      [tool],
    );

    const records = rows.map((row) => this.hydrate(row));
    const denials = records.filter((r) => r.state === 'denied' && r.scope === 'always');
    if (denials.length > 0) return { granted: false, via: denials[0]! };

    for (const record of records) {
      if (record.state !== 'granted') continue;
      if (record.scope === 'always') return { granted: true, via: record };
      if (record.scope === 'session' && sessionId !== null && record.sessionId === sessionId) {
        return { granted: true, via: record };
      }
      if (record.scope === 'shape' && record.shape !== null) {
        if (shapeMatches(record.shape as Shape, tool, input)) return { granted: true, via: record };
      }
    }
    return null;
  }

  /* ── reads ────────────────────────────────────────────────────────────── */

  get(id: string): ApprovalRecord | undefined {
    const row = this.storage.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', [id]);
    return row === undefined ? undefined : this.hydrate(row);
  }

  pending(): ApprovalRecord[] {
    return this.storage
      .all<ApprovalRow>(`SELECT * FROM approvals WHERE state = 'pending' ORDER BY requested_at`)
      .map((row) => this.hydrate(row));
  }

  forRun(runId: string): ApprovalRecord[] {
    return this.storage
      .all<ApprovalRow>('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at', [runId])
      .map((row) => this.hydrate(row));
  }

  private hydrate(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      sessionId: row.session_id,
      principal: row.principal,
      tool: row.tool,
      toolVersion: row.tool_version,
      input: JSON.parse(row.input_json) as unknown,
      preview: row.preview,
      risk: row.risk,
      requestedTrust: row.requested_trust,
      state: row.state,
      scope: row.scope,
      shape: row.shape_json === null ? null : (JSON.parse(row.shape_json) as unknown),
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reason: row.reason,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
    };
  }
}

/* ──────────────────────── suspending and resuming ──────────────────────── */

export class SuspensionStore {
  constructor(
    private readonly storage: Storage,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  suspend(suspension: Omit<Suspension, 'suspendedAt' | 'resumedAt'>): void {
    const now = this.clock.now();
    this.storage.run(
      `INSERT OR REPLACE INTO suspensions
         (run_id, session_id, principal, step_id, step_index, reason, resume_on, spend_json, suspended_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        suspension.runId,
        suspension.sessionId,
        suspension.principal,
        suspension.stepId,
        suspension.stepIndex,
        suspension.reason,
        suspension.resumeOn,
        JSON.stringify(suspension.spend),
        now,
      ],
    );

    this.events.append({
      type: 'run.suspended',
      payload: {
        reason: suspension.reason,
        resumeOn: suspension.resumeOn,
        stepId: suspension.stepId,
      },
      principal: suspension.principal,
      trust: 'SYSTEM',
      sessionId: suspension.sessionId,
      runId: suspension.runId,
      stepId: suspension.stepId,
      correlationId: suspension.runId,
    });
  }

  /** The run parked on this approval id, if any. */
  waitingOn(resumeOn: string): Suspension | undefined {
    const row = this.storage.get<SuspensionRow>(
      'SELECT * FROM suspensions WHERE resume_on = ? AND resumed_at IS NULL',
      [resumeOn],
    );
    return row === undefined ? undefined : this.hydrate(row);
  }

  get(runId: string): Suspension | undefined {
    const row = this.storage.get<SuspensionRow>('SELECT * FROM suspensions WHERE run_id = ?', [
      runId,
    ]);
    return row === undefined ? undefined : this.hydrate(row);
  }

  all(): Suspension[] {
    return this.storage
      .all<SuspensionRow>('SELECT * FROM suspensions WHERE resumed_at IS NULL ORDER BY suspended_at')
      .map((row) => this.hydrate(row));
  }

  markResumed(runId: string): Suspension {
    const suspension = this.get(runId);
    if (suspension === undefined) throw new ApprovalError(`run '${runId}' is not suspended`);
    if (suspension.resumedAt !== null) {
      // Resuming twice would run the same step twice, which is the whole
      // class of bug M3 spent a milestone closing.
      throw new ApprovalError(`run '${runId}' was already resumed`);
    }
    const now = this.clock.now();
    this.storage.run('UPDATE suspensions SET resumed_at = ? WHERE run_id = ?', [now, runId]);

    this.events.append({
      type: 'run.resumed',
      payload: { afterMs: now - suspension.suspendedAt, stepId: suspension.stepId },
      principal: suspension.principal,
      trust: 'SYSTEM',
      sessionId: suspension.sessionId,
      runId,
      stepId: suspension.stepId,
      correlationId: runId,
    });

    return { ...suspension, resumedAt: now };
  }

  private hydrate(row: SuspensionRow): Suspension {
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      principal: row.principal,
      stepId: row.step_id,
      stepIndex: row.step_index,
      reason: row.reason,
      resumeOn: row.resume_on,
      spend: { ...ZERO_SPEND(), ...(JSON.parse(row.spend_json) as Partial<Spend>) },
      suspendedAt: row.suspended_at,
      resumedAt: row.resumed_at,
    };
  }
}
