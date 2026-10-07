import type { Storage } from '../substrate/ports.js';
import type { EventLog } from '../substrate/events/log.js';
import type { Triple } from '../capability/ruleoftwo.js';
import type { Rung } from './autonomy.js';

/**
 * Approvals (§30).
 *
 * The rule that makes this worth building rather than faking:
 *
 * **An approval names one step of one plan.** It carries `stepSeal`, which
 * is a hash of the plan's seal and the step index, so a yes cannot be
 * replayed against a different action. A generic standing "yes, go ahead"
 * is a different feature, and pretending this one is that one is how a
 * user ends up having approved something they never saw.
 *
 * **Only a human grants.** An agent granting its own approval is refused
 * structurally — `grant` demands a USER-trust actor — because every other
 * control in the platform is downstream of this one.
 */

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  stepSeal: string;
  tool: string;
  action: string;
  needs: Rung;
  triple: Triple;
  expiresAt: number;
}

export interface ApprovalRow {
  id: string;
  run_id: string | null;
  step_seal: string;
  tool: string;
  action: string;
  needs: number;
  status: 'pending' | 'granted' | 'denied' | 'expired';
  requested_at: number;
  expires_at: number;
  settled_at: number | null;
  settled_by: string | null;
}

export class ApprovalError extends Error {
  constructor(readonly kind: 'not_found' | 'not_human' | 'already_settled' | 'expired', message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalDeps {
  storage: Storage;
  events: EventLog;
  now: () => number;
  nextId: () => string;
}

export class Approvals {
  constructor(private readonly deps: ApprovalDeps) {}

  request(input: Omit<ApprovalRequest, 'approvalId' | 'expiresAt'> & { ttlMs?: number }): ApprovalRequest {
    const approvalId = this.deps.nextId();
    const expiresAt = this.deps.now() + (input.ttlMs ?? DEFAULT_TTL_MS);
    this.deps.events.append({
      type: 'approval.requested',
      actor: 'agent',
      trust: 'DERIVED',
      runId: input.runId,
      payload: {
        approvalId,
        stepSeal: input.stepSeal,
        tool: input.tool,
        action: input.action.slice(0, 200),
        needs: input.needs,
        triple: { ...input.triple },
        expiresAt,
      },
    });
    return { ...input, approvalId, expiresAt };
  }

  /**
   * Grant. Only a human, only before expiry, only once.
   *
   * `by` is the actor and `actorTrust` is what the caller can prove about
   * them. An agent cannot pass `actorTrust: 'USER'` without lying in a way
   * the firewall would have to have already failed to catch.
   */
  grant(approvalId: string, by: string, actorTrust: 'USER' | 'SYSTEM', reason = ''): void {
    this.settle(approvalId, 'approval.granted', by, actorTrust, reason);
  }

  deny(approvalId: string, by: string, actorTrust: 'USER' | 'SYSTEM', reason = ''): void {
    this.settle(approvalId, 'approval.denied', by, actorTrust, reason);
  }

  /**
   * Expire everything past its deadline.
   *
   * Lazy rather than on a timer, for the same reason the vault's idle lock
   * is: a `setTimeout` would be a second source of truth about time,
   * invisible to the injected clock and therefore untestable by advancing
   * it.
   */
  expireStale(): number {
    const now = this.deps.now();
    const stale = this.deps.storage
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY id`)
      .all<ApprovalRow>(now);
    for (const row of stale) {
      this.deps.events.append({
        type: 'approval.expired',
        actor: 'system',
        trust: 'SYSTEM',
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        payload: { approvalId: row.id, by: 'system', reason: 'not answered in time' },
      });
    }
    return stale.length;
  }

  get(approvalId: string): ApprovalRow | undefined {
    return this.deps.storage.prepare('SELECT * FROM approvals WHERE id = ?').get<ApprovalRow>(approvalId);
  }

  /** Is this approval usable, right now, for this exact step? */
  authorises(approvalId: string, stepSeal: string): boolean {
    const row = this.get(approvalId);
    if (row === undefined) return false;
    if (row.status !== 'granted') return false;
    if (row.step_seal !== stepSeal) return false;
    // An expired grant is not a grant, even if nobody has swept yet.
    return row.expires_at > this.deps.now();
  }

  pending(): ApprovalRow[] {
    return this.deps.storage
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at, id`)
      .all<ApprovalRow>();
  }

  all(): ApprovalRow[] {
    return this.deps.storage.prepare('SELECT * FROM approvals ORDER BY requested_at DESC, id').all<ApprovalRow>();
  }

  private settle(
    approvalId: string,
    type: 'approval.granted' | 'approval.denied',
    by: string,
    actorTrust: 'USER' | 'SYSTEM',
    reason: string,
  ): void {
    if (actorTrust !== 'USER' && actorTrust !== 'SYSTEM') {
      throw new ApprovalError('not_human', 'Only a human may settle an approval (§30).');
    }
    const row = this.get(approvalId);
    if (row === undefined) throw new ApprovalError('not_found', `No approval ${approvalId}.`);
    if (row.status !== 'pending') {
      throw new ApprovalError('already_settled', `Approval ${approvalId} was already ${row.status}.`);
    }
    if (row.expires_at <= this.deps.now()) {
      throw new ApprovalError('expired', `Approval ${approvalId} expired; ask again rather than answering late.`);
    }
    this.deps.events.append({
      type,
      actor: by,
      trust: actorTrust,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      payload: { approvalId, by, reason: reason.slice(0, 200) },
    });
  }
}
