/**
 * The ask budget (§24.2, L4).
 *
 * §24.2 is written almost entirely as refusals, and that is the right shape:
 * the failure mode of a self-improving agent is not asking too little, it is
 * turning into a form. So this file is mostly a ledger of things not to do.
 *
 *   - a bounded number of questions per day and per session,
 *   - never the same question twice,
 *   - a declined probe is recorded and respected,
 *   - priority by information value × cost of being wrong,
 *   - batched at natural moments, never mid-task,
 *   - unanswered twice → dropped permanently, the fact marked unresolvable.
 *
 * The last one is the clause people skip, and it is the one that keeps the
 * ledger from growing into a backlog of nagging. A question the user has
 * twice chosen not to answer *is* answered: they do not want to tell you.
 */
import type { Clock, Ids, SqlParams, Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';

export interface ProbeBudget {
  perDay: number;
  perSession: number;
}

/**
 * Three a day, one a session.
 *
 * Deliberately miserly. The agent gets dozens of turns a day; at one
 * question per session it still learns something new most days, and the
 * user never feels interviewed. Config overrides it, but the default is the
 * statement of intent.
 */
export const DEFAULT_BUDGET: ProbeBudget = { perDay: 3, perSession: 1 };

const DAY_MS = 86_400_000;

/**
 * How long an asked-but-unanswered probe waits before it may be asked again.
 *
 * Found by a test: without it, `next()` handed the same question back on the
 * very next turn, because "asked" is still an askable state until the second
 * attempt is spent. §24.2 allows exactly two attempts — it does not allow
 * them back to back, which would read as nagging and would burn the day's
 * budget on one question.
 */
export const RETRY_AFTER_MS = 7 * DAY_MS;

export interface ProbeCandidate {
  factId: string | null;
  question: string;
  /** The agent's current belief, 0..1 — what the answer would resolve. */
  predicted: number;
  /** 0..1: how much knowing this would change behaviour. */
  informationValue: number;
  /** 0..1: how bad it is to act on the wrong answer. */
  costOfBeingWrong: number;
}

export interface StoredProbe {
  id: string;
  factId: string | null;
  question: string;
  predicted: number;
  value: number;
  status: 'pending' | 'asked' | 'confirmed' | 'corrected' | 'declined' | 'unresolvable';
  attempts: number;
  askedAt: number | null;
}

interface ProbeRow {
  id: string;
  principal: string;
  fact_id: string | null;
  question: string;
  question_hash: string;
  predicted: number;
  value: number;
  session_id: string | null;
  asked_at: number | null;
  answered_at: number | null;
  attempts: number;
  status: StoredProbe['status'];
}

export interface AskBudgetDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
  budget?: ProbeBudget;
}

/**
 * Identity of a question, for the "never twice" rule.
 *
 * Normalised to the fact it is about when there is one, because the same
 * question asked in two wordings is the same question; falls back to the
 * flattened text when it is about nothing in particular.
 */
export function questionHash(factId: string | null, question: string): string {
  if (factId !== null && factId !== '') return `fact:${factId}`;
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Priority: information value × cost of being wrong (§24.2), ties by uncertainty. */
export function priority(c: ProbeCandidate): number {
  return c.informationValue * c.costOfBeingWrong;
}

export function orderCandidates(cands: readonly ProbeCandidate[]): ProbeCandidate[] {
  return [...cands].sort((a, b) => {
    const byValue = priority(b) - priority(a);
    if (Math.abs(byValue) > 1e-9) return byValue;
    // Tie-break on uncertainty: of two equally valuable questions, ask the
    // one you are least sure about. Documented because an undocumented
    // tie-break is a silent behaviour change waiting to happen.
    const aUncertain = 1 - Math.abs(a.predicted - 0.5) * 2;
    const bUncertain = 1 - Math.abs(b.predicted - 0.5) * 2;
    if (Math.abs(bUncertain - aUncertain) > 1e-9) return bUncertain - aUncertain;
    return a.question.localeCompare(b.question);
  });
}

export class AskBudget {
  private readonly budget: ProbeBudget;

  constructor(private readonly deps: AskBudgetDeps) {
    this.budget = deps.budget ?? DEFAULT_BUDGET;
  }

  /** Register candidates without asking anything. Idempotent per question. */
  enqueue(principal: string, candidates: readonly ProbeCandidate[]): number {
    let added = 0;
    for (const c of candidates) {
      const hash = questionHash(c.factId, c.question);
      const existing = this.deps.storage.get<ProbeRow>(
        'SELECT * FROM calibration_probes WHERE principal = ? AND question_hash = ?',
        [principal, hash],
      );
      if (existing) continue;
      this.deps.storage.run(
        `INSERT INTO calibration_probes (
           id, principal, fact_id, question, question_hash, predicted, value, status
         ) VALUES (?,?,?,?,?,?,?, 'pending')`,
        [
          this.deps.ids.ulid(),
          principal,
          c.factId,
          c.question,
          hash,
          c.predicted,
          priority(c),
        ],
      );
      added += 1;
    }
    return added;
  }

  /**
   * What may be asked right now.
   *
   * `atNaturalBreak` is the §24.2 "batched at natural moments, never
   * mid-task" rule, and it is a parameter rather than something inferred
   * here: only the runner knows whether the run finished cleanly or was
   * suspended waiting for an approval, and guessing from the ledger would
   * be guessing.
   */
  next(
    principal: string,
    opts: { sessionId: string; atNaturalBreak: boolean; limit?: number },
  ): StoredProbe[] {
    if (!opts.atNaturalBreak) return [];
    const now = this.deps.clock.now();
    const since = now - DAY_MS;

    const askedToday =
      this.deps.storage.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND asked_at >= ?',
        [principal, since],
      )?.n ?? 0;
    if (askedToday >= this.budget.perDay) return [];

    const askedThisSession =
      this.deps.storage.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND session_id = ? AND asked_at IS NOT NULL',
        [principal, opts.sessionId],
      )?.n ?? 0;
    if (askedThisSession >= this.budget.perSession) return [];

    const room = Math.min(
      this.budget.perDay - askedToday,
      this.budget.perSession - askedThisSession,
      opts.limit ?? this.budget.perSession,
    );
    if (room <= 0) return [];

    const rows = this.deps.storage.all<ProbeRow>(
      `SELECT * FROM calibration_probes
        WHERE principal = ? AND status IN ('pending','asked') AND attempts < 2
          AND (asked_at IS NULL OR asked_at <= ?)
        ORDER BY value DESC, id ASC LIMIT ?`,
      [principal, now - RETRY_AFTER_MS, room],
    );
    return rows.map(toProbe);
  }

  /** Mark a probe as asked and record `calibration.probed`. */
  markAsked(principal: string, probeId: string, sessionId: string): void {
    const row = this.deps.storage.get<ProbeRow>('SELECT * FROM calibration_probes WHERE id = ?', [
      probeId,
    ]);
    if (!row) throw new Error(`no such probe: ${probeId}`);
    const now = this.deps.clock.now();
    this.deps.storage.run(
      `UPDATE calibration_probes
          SET status = 'asked', asked_at = ?, session_id = ?, attempts = attempts + 1
        WHERE id = ?`,
      [now, sessionId, probeId],
    );
    this.deps.events.append({
      type: 'calibration.probed',
      principal,
      sessionId,
      trust: 'SYSTEM',
      payload: { factId: row.fact_id, question: row.question },
    });
  }

  /**
   * Record an answer.
   *
   * `declined` is terminal — §24.2 says a declined probe is "recorded and
   * respected", and respecting it means never queueing the question again,
   * not asking it more politely tomorrow.
   */
  answer(
    principal: string,
    probeId: string,
    answer: 'confirmed' | 'corrected' | 'declined' | 'unknown',
  ): void {
    const row = this.deps.storage.get<ProbeRow>('SELECT * FROM calibration_probes WHERE id = ?', [
      probeId,
    ]);
    if (!row) throw new Error(`no such probe: ${probeId}`);
    const now = this.deps.clock.now();

    const status: StoredProbe['status'] =
      answer === 'confirmed'
        ? 'confirmed'
        : answer === 'corrected'
          ? 'corrected'
          : answer === 'declined'
            ? 'declined'
            : row.attempts >= 2
              ? 'unresolvable'
              : 'pending';

    this.deps.storage.run(
      'UPDATE calibration_probes SET status = ?, answered_at = ? WHERE id = ?',
      [status, answer === 'unknown' ? null : now, probeId],
    );

    this.deps.events.append({
      type: 'calibration.answered',
      principal,
      trust: 'USER',
      payload: { factId: row.fact_id, answer },
    });

    if (answer === 'confirmed' || answer === 'corrected') {
      this.deps.storage.run(
        `INSERT INTO calibration_resolutions (id, principal, fact_id, predicted, outcome, source, resolved_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          this.deps.ids.ulid(),
          principal,
          row.fact_id,
          row.predicted,
          answer === 'confirmed' ? 1 : 0,
          'probe',
          now,
        ],
      );
    }
  }

  /** A fact the user corrected outside a probe still resolves a prediction. */
  recordResolution(
    principal: string,
    factId: string | null,
    predicted: number,
    outcome: 0 | 1,
    source: 'probe' | 'correction' | 'tool',
  ): void {
    this.deps.storage.run(
      `INSERT INTO calibration_resolutions (id, principal, fact_id, predicted, outcome, source, resolved_at)
       VALUES (?,?,?,?,?,?,?)`,
      [this.deps.ids.ulid(), principal, factId, predicted, outcome, source, this.deps.clock.now()],
    );
  }

  /** Probes that went unanswered twice are dropped and their facts flagged. */
  sweep(principal: string): string[] {
    const stale = this.deps.storage.all<ProbeRow>(
      `SELECT * FROM calibration_probes
        WHERE principal = ? AND status = 'asked' AND attempts >= 2`,
      [principal],
    );
    for (const row of stale) {
      this.deps.storage.run(`UPDATE calibration_probes SET status = 'unresolvable' WHERE id = ?`, [
        row.id,
      ]);
    }
    return stale.map((r) => r.fact_id).filter((id): id is string => id !== null);
  }

  state(principal: string): {
    budget: ProbeBudget;
    askedToday: number;
    pending: number;
    declined: number;
    unresolvable: number;
  } {
    const since = this.deps.clock.now() - DAY_MS;
    const count = (sql: string, params: SqlParams): number =>
      this.deps.storage.get<{ n: number }>(sql, params)?.n ?? 0;
    return {
      budget: this.budget,
      askedToday: count(
        'SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND asked_at >= ?',
        [principal, since],
      ),
      pending: count(
        `SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND status = 'pending'`,
        [principal],
      ),
      declined: count(
        `SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND status = 'declined'`,
        [principal],
      ),
      unresolvable: count(
        `SELECT COUNT(*) AS n FROM calibration_probes WHERE principal = ? AND status = 'unresolvable'`,
        [principal],
      ),
    };
  }

  resolutions(principal: string, since = 0): import('./confidence.js').Resolution[] {
    return this.deps.storage
      .all<{
        fact_id: string | null;
        predicted: number;
        outcome: number;
        resolved_at: number;
        source: string;
      }>(
        'SELECT fact_id, predicted, outcome, resolved_at, source FROM calibration_resolutions WHERE principal = ? AND resolved_at >= ? ORDER BY resolved_at',
        [principal, since],
      )
      .map((r) => ({
        factId: r.fact_id,
        predicted: r.predicted,
        outcome: (r.outcome === 1 ? 1 : 0) as 0 | 1,
        resolvedAt: r.resolved_at,
        source: r.source as 'probe' | 'correction' | 'tool',
      }));
  }
}

function toProbe(r: ProbeRow): StoredProbe {
  return {
    id: r.id,
    factId: r.fact_id,
    question: r.question,
    predicted: r.predicted,
    value: r.value,
    status: r.status,
    attempts: r.attempts,
    askedAt: r.asked_at,
  };
}
