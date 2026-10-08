import type { EventLog } from '../substrate/events/log.js';
import { canonicalJson } from '../substrate/events/hash.js';
import type { CryptoPort, Storage } from '../substrate/ports.js';

/**
 * Exactly-once external effects (§13).
 *
 * The problem this solves is the one every agent gets wrong: the process
 * dies between "send the email" and "write down that we sent the email".
 * On restart, nothing distinguishes *not yet sent* from *sent and
 * unrecorded* — and the obvious fix, retrying, is how an agent emails
 * someone twice.
 *
 * So an effect is two events, not one:
 *
 *   1. **Intend** — `effect.intended` with an idempotency key, committed
 *      in the same transaction as the step that wanted it.
 *   2. **Commit** — perform it, then `effect.committed`.
 *
 * A crash between them leaves an intention with no commitment, which is a
 * *visible, queryable* uncertainty rather than an invisible one. §13's
 * rule is then absolute: **never blindly retry a non-idempotent external
 * effect.** Reconciliation asks the remote where it can, and asks the
 * human where it cannot.
 *
 * What this class does not do is perform anything. It has no `Net`, no
 * tool registry and no way to send an email. It records intentions and
 * adjudicates uncertainty; the caller does the deed between the two
 * calls. That separation is what makes a crash testable — a test simply
 * declines to call `commit`.
 */

export type EffectStatus = 'intended' | 'committed' | 'compensated' | 'needs_attention' | 'absent';

export interface EffectIntent {
  tool: string;
  version: string;
  stepId: string;
  /** Canonicalised and hashed, never stored: arguments carry secrets. */
  input: unknown;
  /** False means `compensate()` cannot undo it — §15 caps autonomy at L2. */
  reversible: boolean;
  /** True means the remote itself deduplicates, so a retry is safe. */
  idempotent: boolean;
  /** One line a human can read in a "needs attention" list. */
  summary?: string;
  runId?: string | undefined;
  principal?: string | undefined;
}

export interface OutboxEntry {
  key: string;
  tool: string;
  version: string;
  runId: string | null;
  stepId: string;
  inputDigest: string;
  reversible: boolean;
  idempotent: boolean;
  status: EffectStatus;
  remoteRef: string | null;
  summary: string;
  detail: string;
  intendedAt: number;
  settledAt: number | null;
}

interface Row {
  key: string; tool: string; version: string; run_id: string | null; step_id: string;
  input_digest: string; reversible: number; idempotent: number; status: string;
  remote_ref: string | null; summary: string; detail: string;
  intended_at: number; settled_at: number | null;
}

/**
 * What a tool can tell us about an effect it may or may not have performed.
 *
 * `absent` must mean *checked, and it is definitely not there* — not
 * "the call failed". A probe that cannot be sure returns `unknown`, and
 * `unknown` reaches a human. This distinction is the entire value of the
 * mechanism, so it is in the type rather than in a convention.
 */
export type ProbeResult =
  | { found: true; remoteRef: string | null }
  | { found: false }
  | { unknown: true; detail: string };

export type Probe = (entry: OutboxEntry) => Promise<ProbeResult>;

export interface OutboxDeps {
  storage: Storage;
  events: EventLog;
  crypto: CryptoPort;
}

export class Outbox {
  constructor(private readonly deps: OutboxDeps) {}

  /**
   * The idempotency key: `hash(tool, version, canonicalInput, stepId)`.
   *
   * `stepId` is in it deliberately. Without it, the same email sent
   * twice on purpose — the follow-up that is genuinely a second message —
   * would collide with the first and be silently swallowed. With it, a
   * *replay of one step* deduplicates and a *second intention* does not.
   */
  key(intent: Pick<EffectIntent, 'tool' | 'version' | 'input' | 'stepId'>): string {
    return this.deps.crypto.sha256(
      `${intent.tool}@${intent.version}|${canonicalJson(intent.input)}|${intent.stepId}`,
    );
  }

  /**
   * Declare the intention to act, before acting.
   *
   * Returns the key and whether this effect has already been settled. A
   * caller that gets `alreadySettled` **must not perform the action**:
   * this is a replay of a step that already ran.
   */
  intend(intent: EffectIntent): { key: string; alreadySettled: OutboxEntry | null } {
    const key = this.key(intent);
    const existing = this.get(key);
    if (existing !== undefined && existing.status !== 'absent') {
      return { key, alreadySettled: existing.status === 'intended' ? null : existing };
    }

    this.deps.events.append({
      type: 'effect.intended',
      actor: intent.principal ?? 'agent',
      // SYSTEM: the intention is authored by the kernel, whatever trust
      // the *content* of the effect carries. The content is a digest here.
      trust: 'SYSTEM',
      ...(intent.runId === undefined ? {} : { runId: intent.runId }),
      payload: {
        key,
        tool: intent.tool,
        version: intent.version,
        stepId: intent.stepId,
        inputDigest: this.deps.crypto.sha256(canonicalJson(intent.input)),
        reversible: intent.reversible,
        idempotent: intent.idempotent,
        summary: intent.summary ?? '',
      },
    });
    return { key, alreadySettled: null };
  }

  /** Record that it happened. `remoteRef` is the remote's own id, if any. */
  commit(key: string, result: { remoteRef?: string | null; summary?: string; reconciled?: boolean } = {}): void {
    const entry = this.require(key);
    this.deps.events.append({
      type: 'effect.committed',
      actor: 'agent',
      trust: 'SYSTEM',
      ...(entry.runId === null ? {} : { runId: entry.runId }),
      payload: {
        key,
        tool: entry.tool,
        remoteRef: result.remoteRef ?? null,
        summary: result.summary ?? entry.summary,
        reconciled: result.reconciled ?? false,
      },
    });
  }

  /** Record that it was undone. Only meaningful for a reversible effect. */
  compensate(key: string, detail: string): void {
    const entry = this.require(key);
    this.deps.events.append({
      type: 'effect.compensated',
      actor: 'agent',
      trust: 'SYSTEM',
      ...(entry.runId === null ? {} : { runId: entry.runId }),
      payload: { key, tool: entry.tool, detail },
    });
  }

  get(key: string): OutboxEntry | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM outbox WHERE key = ?').get<Row>(key);
    return row === undefined ? undefined : toEntry(row);
  }

  /** Effects that were intended and never settled. The post-crash question. */
  pending(): OutboxEntry[] {
    return this.deps.storage
      .prepare("SELECT * FROM outbox WHERE status = 'intended' ORDER BY intended_at ASC")
      .all<Row>().map(toEntry);
  }

  /** Effects a human must look at, because nothing else can settle them. */
  needsAttention(): OutboxEntry[] {
    return this.deps.storage
      .prepare("SELECT * FROM outbox WHERE status = 'needs_attention' ORDER BY intended_at ASC")
      .all<Row>().map(toEntry);
  }

  /**
   * Settle everything left hanging by a crash.
   *
   * Per-tool probes are consulted where they exist. **Absence of a probe
   * is never treated as absence of the effect**: an unprobeable intention
   * goes to a human, because the alternative is guessing about something
   * that may already have reached another person's inbox.
   */
  async reconcile(probes: ReadonlyMap<string, Probe>): Promise<{
    committed: number; absent: number; needsAttention: number;
  }> {
    const tally = { committed: 0, absent: 0, needsAttention: 0 };
    for (const entry of this.pending()) {
      const outcome = await this.settle(entry, probes.get(entry.tool));
      if (outcome === 'committed') tally.committed += 1;
      else if (outcome === 'absent') tally.absent += 1;
      else tally.needsAttention += 1;
    }
    return tally;
  }

  private async settle(entry: OutboxEntry, probe: Probe | undefined): Promise<'committed' | 'absent' | 'needs_attention'> {
    if (probe === undefined) {
      return this.record(entry, 'needs_attention', `${entry.tool} cannot be asked whether this happened`);
    }

    let result: ProbeResult;
    try {
      result = await probe(entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'the probe failed';
      return this.record(entry, 'needs_attention', detail);
    }

    if ('unknown' in result) return this.record(entry, 'needs_attention', result.detail);

    if (result.found) {
      this.deps.events.append({
        type: 'effect.reconciled', actor: 'agent', trust: 'SYSTEM',
        ...(entry.runId === null ? {} : { runId: entry.runId }),
        payload: { key: entry.key, tool: entry.tool, outcome: 'committed', detail: 'found at the provider' },
      });
      this.commit(entry.key, { remoteRef: result.remoteRef ?? null, reconciled: true });
      return 'committed';
    }

    // Confirmed absent. Safe to let the caller try again — and notice
    // that *this* is the only path on which a retry is ever permitted.
    return this.record(entry, 'absent', 'the provider has no record of it');
  }

  private record(entry: OutboxEntry, outcome: 'absent' | 'needs_attention', detail: string): 'absent' | 'needs_attention' {
    this.deps.events.append({
      type: 'effect.reconciled', actor: 'agent', trust: 'SYSTEM',
      ...(entry.runId === null ? {} : { runId: entry.runId }),
      payload: { key: entry.key, tool: entry.tool, outcome, detail },
    });
    return outcome;
  }

  private require(key: string): OutboxEntry {
    const entry = this.get(key);
    if (entry === undefined) throw new Error(`No outbox entry ${key}: commit without intend.`);
    return entry;
  }
}

function toEntry(row: Row): OutboxEntry {
  return {
    key: row.key,
    tool: row.tool,
    version: row.version,
    runId: row.run_id,
    stepId: row.step_id,
    inputDigest: row.input_digest,
    reversible: row.reversible === 1,
    idempotent: row.idempotent === 1,
    status: row.status as EffectStatus,
    remoteRef: row.remote_ref,
    summary: row.summary,
    detail: row.detail,
    intendedAt: row.intended_at,
    settledAt: row.settled_at,
  };
}
