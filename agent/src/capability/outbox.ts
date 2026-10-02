/**
 * Exactly-once external effects (§18, L3).
 *
 * The hard problem, stated plainly: **a side effect that has left the
 * building cannot be undone, and the process can die between "I decided to
 * send it" and "I know it was sent."**
 *
 * After a crash there are exactly three states:
 *
 * | the log says              | what actually happened | what we may do          |
 * |---------------------------|------------------------|-------------------------|
 * | nothing                   | nothing                | run it                  |
 * | `intended`, no `committed`| **unknown**            | query, or ask. never guess. |
 * | `intended` + `committed`  | it happened            | return the recorded result  |
 *
 * Row two is the entire reason this file exists. The temptation is to retry —
 * it is one line, it usually works, and when it does not work someone gets
 * charged twice. **Never blindly retry a non-idempotent external effect.** A
 * duplicate payment is worse than a late one.
 *
 * Reconciliation therefore has a strict preference order:
 *   1. ask the remote (`queryEffect`) — the only way to actually *know*
 *   2. if the tool is idempotent, running again is safe by definition
 *   3. otherwise mark `needs_attention` and ask the person
 *
 * Step 3 is not a failure of the design. It is the design: when a machine
 * cannot know, it must not pretend.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Hashing, Storage } from '../substrate/ports.js';
import { canonicalJson } from '../substrate/hash.js';
import type { EffectStatus, Tool, ToolContext } from './tool.js';

export type EffectState = 'intended' | 'committed' | 'compensated' | 'needs_attention';

export interface EffectRecord {
  idempotencyKey: string;
  tool: string;
  toolVersion: string;
  runId: string;
  stepId: string;
  state: EffectState;
  summary: string;
  input: unknown;
  remoteRef: string | null;
  intendedAt: number;
  settledAt: number | null;
  attempts: number;
  note: string | null;
}

interface EffectRow {
  idempotency_key: string;
  tool: string;
  tool_version: string;
  run_id: string;
  step_id: string;
  state: EffectState;
  summary: string;
  input_json: string;
  remote_ref: string | null;
  intended_at: number;
  settled_at: number | null;
  attempts: number;
  note: string | null;
}

function toRecord(row: EffectRow): EffectRecord {
  return {
    idempotencyKey: row.idempotency_key,
    tool: row.tool,
    toolVersion: row.tool_version,
    runId: row.run_id,
    stepId: row.step_id,
    state: row.state,
    summary: row.summary,
    input: JSON.parse(row.input_json),
    remoteRef: row.remote_ref,
    intendedAt: row.intended_at,
    settledAt: row.settled_at,
    attempts: row.attempts,
    note: row.note,
  };
}

/**
 * The idempotency key (§18): `hash(tool, version, canonicalInput, stepId)`.
 *
 * Each component earns its place:
 *  - **tool + version** — a new version may behave differently, so it is a
 *    different effect even with identical input.
 *  - **canonicalInput** — `{a:1,b:2}` and `{b:2,a:1}` are the same call, and
 *    must not produce two payments. This is what `canonicalJson` is for, and
 *    why it has existed since M0.
 *  - **stepId** — "send the same email twice, deliberately, in two steps" has
 *    to remain possible. Keying on input alone would silently make the second
 *    send a no-op, which is a *different* wrong answer.
 */
export function idempotencyKey(
  hashing: Hashing,
  tool: string,
  version: string,
  input: unknown,
  stepId: string,
): string {
  return hashing.sha256Hex(
    canonicalJson({ tool, version, input: canonicalJson(input), stepId }),
  );
}

export interface IntendOptions {
  tool: string;
  toolVersion: string;
  runId: string;
  stepId: string;
  principal: string;
  input: unknown;
  /** One line a human reads when asked to adjudicate this effect. */
  summary: string;
}

export class Outbox {
  constructor(
    private readonly storage: Storage,
    private readonly events: EventLog,
    private readonly clock: Clock,
    private readonly hashing: Hashing,
  ) {}

  keyFor(options: Omit<IntendOptions, 'principal' | 'summary'>): string {
    return idempotencyKey(
      this.hashing,
      options.tool,
      options.toolVersion,
      options.input,
      options.stepId,
    );
  }

  get(key: string): EffectRecord | undefined {
    const row = this.storage.get<EffectRow>('SELECT * FROM effects WHERE idempotency_key = ?', [
      key,
    ]);
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Phase 1 — record the intent **before** the effect runs.
   *
   * The row insert and the `effect.intended` event go in one transaction, so
   * the outbox and the log can never disagree about whether an effect was
   * contemplated. If this commit does not survive, the effect must not run;
   * if it does survive, the effect might have.
   *
   * Returns `{ alreadySettled }` when this exact key has been seen before,
   * which is how a replayed step becomes a no-op rather than a second send.
   */
  intend(options: IntendOptions): { key: string; record: EffectRecord; alreadySettled: boolean } {
    const key = this.keyFor(options);

    return this.storage.transaction(() => {
      const existing = this.get(key);
      if (existing !== undefined) {
        return {
          key,
          record: existing,
          alreadySettled: existing.state === 'committed' || existing.state === 'compensated',
        };
      }

      const now = this.clock.now();
      this.storage.run(
        `INSERT INTO effects
           (idempotency_key, tool, tool_version, run_id, step_id, state, summary,
            input_json, remote_ref, intended_at, settled_at, attempts, note)
         VALUES (?,?,?,?,?, 'intended', ?, ?, NULL, ?, NULL, 0, NULL)`,
        [
          key,
          options.tool,
          options.toolVersion,
          options.runId,
          options.stepId,
          options.summary,
          canonicalJson(options.input),
          now,
        ],
      );

      this.events.append({
        type: 'effect.intended',
        payload: { tool: options.tool, idempotencyKey: key, summary: options.summary },
        principal: options.principal,
        trust: 'SYSTEM',
        runId: options.runId,
        stepId: options.stepId,
      });

      return { key, record: this.get(key)!, alreadySettled: false };
    });
  }

  /** Phase 2 — the effect definitely happened. */
  commit(key: string, remoteRef: string | null, principal: string): void {
    this.storage.transaction(() => {
      const record = this.get(key);
      if (record === undefined) {
        // Committing something never intended means the two-phase discipline
        // was bypassed. Loud, not silent.
        throw new Error(`outbox: cannot commit unknown effect ${key}`);
      }
      if (record.state === 'committed') return;

      this.storage.run(
        `UPDATE effects SET state = 'committed', remote_ref = ?, settled_at = ? WHERE idempotency_key = ?`,
        [remoteRef, this.clock.now(), key],
      );
      this.events.append({
        type: 'effect.committed',
        payload: { idempotencyKey: key, remoteRef },
        principal,
        trust: 'SYSTEM',
        runId: record.runId,
        stepId: record.stepId,
      });
    });
  }

  /** The effect ran and has been deliberately undone. */
  compensated(key: string, reason: string, principal: string): void {
    const record = this.get(key);
    if (record === undefined) return;
    this.storage.transaction(() => {
      this.storage.run(
        `UPDATE effects SET state = 'compensated', settled_at = ?, note = ? WHERE idempotency_key = ?`,
        [this.clock.now(), reason, key],
      );
      this.events.append({
        type: 'effect.compensated',
        payload: { idempotencyKey: key, reason },
        principal,
        trust: 'SYSTEM',
        runId: record.runId,
        stepId: record.stepId,
      });
    });
  }

  /**
   * No machine may decide this one.
   *
   * Reaching this state is not a bug — it is the honest outcome when a
   * non-queryable, non-idempotent effect was interrupted. The alternative is
   * guessing, and the cost of guessing wrong is paid by the user.
   */
  needsAttention(key: string, note: string, principal: string): void {
    const record = this.get(key);
    if (record === undefined) return;
    this.storage.transaction(() => {
      this.storage.run(
        `UPDATE effects SET state = 'needs_attention', note = ? WHERE idempotency_key = ?`,
        [note, key],
      );
      this.events.append({
        type: 'error.raised',
        payload: {
          kind: 'effect_unresolved',
          message:
            `An external effect of '${record.tool}' was interrupted and cannot be resolved ` +
            `automatically: ${note}. It has NOT been retried. Please check whether it happened.`,
          fatal: false,
        },
        principal,
        trust: 'SYSTEM',
        runId: record.runId,
        stepId: record.stepId,
      });
    });
  }

  markAttempt(key: string): void {
    this.storage.run('UPDATE effects SET attempts = attempts + 1 WHERE idempotency_key = ?', [key]);
  }

  /** Every effect whose outcome is unknown. The reconciler's work queue. */
  unsettled(runId?: string): EffectRecord[] {
    const rows =
      runId === undefined
        ? this.storage.all<EffectRow>(`SELECT * FROM effects WHERE state = 'intended' ORDER BY intended_at`)
        : this.storage.all<EffectRow>(
            `SELECT * FROM effects WHERE state = 'intended' AND run_id = ? ORDER BY intended_at`,
            [runId],
          );
    return rows.map(toRecord);
  }

  needingAttention(): EffectRecord[] {
    return this.storage
      .all<EffectRow>(`SELECT * FROM effects WHERE state = 'needs_attention' ORDER BY intended_at`)
      .map(toRecord);
  }
}

export interface ReconcileOutcome {
  key: string;
  tool: string;
  /**
   * `confirmed`     — the remote says it happened; recorded, not re-run.
   * `did-not-happen`— the remote says it did not; safe to run again.
   * `re-runnable`   — idempotent, so running again is safe by definition.
   * `needs-attention` — unknowable. A human is asked. **Nothing was retried.**
   */
  resolution: 'confirmed' | 'did-not-happen' | 're-runnable' | 'needs-attention';
  detail: string;
}

/**
 * Reconcile every unsettled effect after a restart (§18).
 *
 * Note what this function does **not** do: it never performs the effect. It
 * decides what is *known*, records that, and leaves re-running to the normal
 * invoke path — which will find a settled row and skip, or an unsettled one
 * and proceed. Keeping the decision and the action separate is what makes
 * this auditable.
 */
export async function reconcile(
  outbox: Outbox,
  tools: { get(name: string, version?: string): Tool<any, any> | undefined },
  contextFor: (record: EffectRecord) => ToolContext,
  principal = 'system',
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];

  for (const record of outbox.unsettled()) {
    const tool = tools.get(record.tool, record.toolVersion);

    if (tool === undefined) {
      outbox.needsAttention(
        record.idempotencyKey,
        `tool '${record.tool}@${record.toolVersion}' is no longer registered, so its effect cannot be checked`,
        principal,
      );
      outcomes.push({
        key: record.idempotencyKey,
        tool: record.tool,
        resolution: 'needs-attention',
        detail: 'tool not registered',
      });
      continue;
    }

    // 1. Preferred: ask the remote. This is the only path that *knows*.
    if (tool.queryEffect !== undefined) {
      let status: EffectStatus;
      try {
        status = await tool.queryEffect(record.idempotencyKey, contextFor(record));
      } catch (err) {
        status = { happened: 'unknown' };
        record.note = (err as Error).message;
      }

      if (status.happened === true) {
        outbox.commit(record.idempotencyKey, status.remoteRef, principal);
        outcomes.push({
          key: record.idempotencyKey,
          tool: record.tool,
          resolution: 'confirmed',
          detail: 'the remote confirms this effect already happened; it was not run again',
        });
        continue;
      }
      if (status.happened === false) {
        outcomes.push({
          key: record.idempotencyKey,
          tool: record.tool,
          resolution: 'did-not-happen',
          detail: 'the remote confirms this effect never happened; it is safe to run',
        });
        continue;
      }
      // 'unknown' falls through to the rules below.
    }

    // 2. Idempotent tools are safe to run again by definition.
    if (tool.idempotent) {
      outcomes.push({
        key: record.idempotencyKey,
        tool: record.tool,
        resolution: 're-runnable',
        detail: 'the tool is idempotent, so running it again cannot cause a second effect',
      });
      continue;
    }

    // 3. Unknowable. Ask the person. Retry nothing.
    outbox.needsAttention(
      record.idempotencyKey,
      tool.queryEffect === undefined
        ? `'${record.tool}' cannot be queried about past effects and is not idempotent`
        : `'${record.tool}' could not determine whether the effect happened`,
      principal,
    );
    outcomes.push({
      key: record.idempotencyKey,
      tool: record.tool,
      resolution: 'needs-attention',
      detail: 'cannot be determined automatically; the user has been asked. Nothing was retried.',
    });
  }

  return outcomes;
}
