/**
 * `JobQueue` — §28's DB-backed queue.
 *
 * `pending | leased | done | failed | dead`, lease expiry, attempts,
 * jittered exponential backoff, dead-letter table with inspection. Four
 * things about the implementation are deliberate and are the reason this
 * file is longer than a queue "should" be:
 *
 * **1. A lease is not an event** (decision 033). Enqueue, start, succeed,
 * fail and dead-letter are events, and the `jobs` table is their
 * projection. `lease_until` / `lease_token` are written directly and are
 * cleared on rebuild, because a lease is a sixty-second claim by a process
 * that may already be dead.
 *
 * **2. A null lease is an expired lease.** If the process dies between
 * appending `job.started` and writing the lease columns, the row would
 * otherwise be `leased` forever with nothing to expire. Treating
 * `lease_until IS NULL` as claimable closes that window without a
 * reconciler.
 *
 * **3. Completion is fenced.** `complete`/`fail` require the lease token
 * they were handed. A worker whose lease expired mid-job, and whose job was
 * then re-leased by someone else, must not be able to mark the new attempt
 * done.
 *
 * **4. Jitter is derived, not random.** The backoff delay is a hash of
 * `jobId:attempt`, so it is spread out across jobs (which is the point of
 * jitter) *and* identical on every replay of the same history (which is
 * what §5 and the test suite require). `Math.random()` is banned in `src/`
 * anyway (§8).
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, SqlParams, Storage } from '../substrate/ports.js';

export type JobStatus = 'pending' | 'leased' | 'done' | 'failed' | 'dead';

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  principal: string;
  status: JobStatus;
  priority: number;
  runAfter: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  scheduleId: string | null;
  idempotencyKey: string | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** A job plus the token that proves this worker still owns it. */
export interface LeasedJob extends Job {
  leaseToken: string;
  leaseUntil: number;
}

export interface DeadLetter {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  principal: string;
  attempts: number;
  error: string;
  scheduleId: string | null;
  diedAt: number;
  replayedAt: number | null;
}

export interface EnqueueInput {
  kind: string;
  payload: Record<string, unknown>;
  principal: string;
  /** Not before this instant. Defaults to now. */
  runAfter?: number;
  /** Higher runs first. Interactive work does not use the queue at all. */
  priority?: number;
  idempotencyKey?: string | null;
  scheduleId?: string | null;
  maxAttempts?: number;
}

export interface JobQueueOptions {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: { ulid(): string; token(bytes?: number): string };
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
/** Backoff never exceeds this, however many attempts have failed. */
export const MAX_BACKOFF_MS = 15 * 60_000;

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  principal: string;
  status: JobStatus;
  priority: number;
  run_after: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  schedule_id: string | null;
  idempotency_key: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  lease_until: number | null;
  lease_token: string | null;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    principal: row.principal,
    status: row.status,
    priority: row.priority,
    runAfter: row.run_after,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    scheduleId: row.schedule_id,
    idempotencyKey: row.idempotency_key,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Deterministic jitter in [0.5, 1.5) derived from the job id and attempt.
 *
 * FNV-1a over the pair. Different jobs failing at the same instant get
 * different delays — which is the entire purpose of jitter — while the
 * same job replayed from the same log gets the same delay forever.
 */
export function jitterFactor(jobId: string, attempt: number): number {
  const input = `${jobId}:${attempt}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 0.5 + (hash % 1000) / 1000;
}

export function backoffFor(jobId: string, attempt: number, base = DEFAULT_BASE_BACKOFF_MS): number {
  const exponential = Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(exponential * jitterFactor(jobId, attempt));
}

export class JobQueue {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(private readonly deps: JobQueueOptions) {
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseBackoffMs = deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /**
   * Add a job. Returns the job id, or the id of the outstanding job when
   * `idempotencyKey` already has one in flight.
   *
   * "In flight" and not "ever": the key is unique only across `pending` and
   * `leased`, so "the 9am briefing" can be enqueued again tomorrow. A key
   * that excluded completed jobs forever would make every recurring
   * schedule fire exactly once in the lifetime of the install.
   */
  enqueue(input: EnqueueInput): string {
    const now = this.deps.clock.now();
    const key = input.idempotencyKey ?? null;

    if (key !== null) {
      const existing = this.deps.storage.get<{ id: string }>(
        `SELECT id FROM jobs WHERE idempotency_key = ? AND status IN ('pending','leased')`,
        [key],
      );
      if (existing !== undefined) return existing.id;
    }

    const jobId = this.deps.ids.ulid();
    this.deps.events.append({
      type: 'job.enqueued',
      principal: input.principal,
      trust: 'SYSTEM',
      payload: {
        jobId,
        kind: input.kind,
        payload: input.payload,
        runAfter: input.runAfter ?? now,
        priority: input.priority ?? 0,
        idempotencyKey: key,
        scheduleId: input.scheduleId ?? null,
      },
    });

    // Columns the event does not carry, because they are operational
    // rather than historical.
    this.deps.storage.run(`UPDATE jobs SET principal = ?, max_attempts = ? WHERE id = ?`, [
      input.principal,
      input.maxAttempts ?? this.maxAttempts,
      jobId,
    ]);

    return jobId;
  }

  /**
   * Claim the next runnable job, or `null`.
   *
   * Order: priority, then `run_after`, then insertion. A job is runnable if
   * it is pending and due, or leased with an expired (or missing) lease.
   */
  lease(): LeasedJob | null {
    const now = this.deps.clock.now();
    return this.deps.storage.transaction(() => {
      const row = this.deps.storage.get<JobRow>(
        `SELECT * FROM jobs
          WHERE run_after <= ?
            AND (status = 'pending'
                 OR (status = 'leased' AND (lease_until IS NULL OR lease_until <= ?)))
          ORDER BY priority DESC, run_after ASC, seq ASC
          LIMIT 1`,
        [now, now],
      );
      if (row === undefined) return null;

      const attempt = row.attempts + 1;
      this.deps.events.append({
        type: 'job.started',
        principal: row.principal,
        trust: 'SYSTEM',
        payload: { jobId: row.id, attempt },
      });

      const token = this.deps.ids.token(8);
      this.deps.storage.run(`UPDATE jobs SET lease_until = ?, lease_token = ? WHERE id = ?`, [
        now + this.leaseMs,
        token,
        row.id,
      ]);

      const updated = this.deps.storage.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [row.id])!;
      return { ...toJob(updated), leaseToken: token, leaseUntil: now + this.leaseMs };
    });
  }

  /** Mark a job done. Refused if the lease was lost (fencing). */
  complete(jobId: string, leaseToken: string, ms = 0): boolean {
    const row = this.deps.storage.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (row === undefined || row.lease_token !== leaseToken) return false;

    this.deps.events.append({
      type: 'job.succeeded',
      principal: row.principal,
      trust: 'SYSTEM',
      payload: { jobId, attempt: row.attempts, ms: Math.max(0, Math.round(ms)) },
    });
    this.deps.storage.run('UPDATE jobs SET lease_until = NULL, lease_token = NULL WHERE id = ?', [jobId]);
    return true;
  }

  /**
   * Record a failure: schedule a retry, or dead-letter when the attempts
   * are spent. Returns what happened so the worker can log it honestly.
   */
  fail(
    jobId: string,
    leaseToken: string,
    error: string,
  ): { retried: boolean; retryAt: number | null; dead: boolean } {
    const row = this.deps.storage.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (row === undefined || row.lease_token !== leaseToken) {
      return { retried: false, retryAt: null, dead: false };
    }

    const now = this.deps.clock.now();
    const exhausted = row.attempts >= row.max_attempts;
    const retryAt = exhausted ? null : now + backoffFor(jobId, row.attempts, this.baseBackoffMs);

    this.deps.events.append({
      type: 'job.failed',
      principal: row.principal,
      trust: 'SYSTEM',
      payload: { jobId, attempt: row.attempts, error: error.slice(0, 500), retryAt },
    });

    if (exhausted) {
      this.deps.events.append({
        type: 'job.deadlettered',
        principal: row.principal,
        trust: 'SYSTEM',
        payload: { jobId, attempts: row.attempts, error: error.slice(0, 500) },
      });
    }

    this.deps.storage.run('UPDATE jobs SET lease_until = NULL, lease_token = NULL WHERE id = ?', [jobId]);
    return { retried: !exhausted, retryAt, dead: exhausted };
  }

  get(jobId: string): Job | null {
    const row = this.deps.storage.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    return row === undefined ? null : toJob(row);
  }

  list(filter: { status?: JobStatus; scheduleId?: string; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const params: SqlParams = [];
    if (filter.status !== undefined) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.scheduleId !== undefined) {
      where.push('schedule_id = ?');
      params.push(filter.scheduleId);
    }
    params.push(filter.limit ?? 100);
    return this.deps.storage
      .all<JobRow>(
        `SELECT * FROM jobs ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY seq DESC LIMIT ?`,
        params,
      )
      .map(toJob);
  }

  /** §28: "dead-letter table with inspection". */
  deadLetters(limit = 100): DeadLetter[] {
    return this.deps.storage
      .all<{
        id: string;
        kind: string;
        payload: string;
        principal: string;
        attempts: number;
        error: string;
        schedule_id: string | null;
        died_at: number;
        replayed_at: number | null;
      }>('SELECT * FROM job_dead_letters ORDER BY died_at DESC LIMIT ?', [limit])
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        principal: row.principal,
        attempts: row.attempts,
        error: row.error,
        scheduleId: row.schedule_id,
        diedAt: row.died_at,
        replayedAt: row.replayed_at,
      }));
  }

  /**
   * Put a dead letter back on the queue as a **new** job.
   *
   * Not by resetting the old row: the dead job's history is part of the
   * record of what this agent did, and a retry four days later is a
   * different attempt at the same intent, not a continuation of the old
   * one.
   */
  replay(deadId: string): string | null {
    const dead = this.deadLetters(1000).find((d) => d.id === deadId);
    if (dead === undefined) return null;

    const jobId = this.enqueue({
      kind: dead.kind,
      payload: dead.payload,
      principal: dead.principal,
      scheduleId: dead.scheduleId,
    });
    this.deps.storage.run('UPDATE job_dead_letters SET replayed_at = ? WHERE id = ?', [
      this.deps.clock.now(),
      deadId,
    ]);
    return jobId;
  }

  /** Used when a schedule is deleted: its unstarted work goes with it. */
  cancelPendingForSchedule(scheduleId: string): number {
    const pending = this.deps.storage.all<{ id: string }>(
      `SELECT id FROM jobs WHERE schedule_id = ? AND status = 'pending'`,
      [scheduleId],
    );
    for (const row of pending) {
      this.deps.storage.run(
        `UPDATE jobs SET status = 'failed', last_error = 'schedule deleted', finished_at = ? WHERE id = ?`,
        [this.deps.clock.now(), row.id],
      );
    }
    return pending.length;
  }

  counts(): Record<JobStatus, number> {
    const rows = this.deps.storage.all<{ status: JobStatus; n: number }>(
      'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status',
    );
    const out: Record<JobStatus, number> = { pending: 0, leased: 0, done: 0, failed: 0, dead: 0 };
    for (const row of rows) out[row.status] = row.n;
    return out;
  }
}
