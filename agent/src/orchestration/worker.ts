/**
 * `Worker` — §28's "workers with graceful shutdown (finish current, refuse
 * new, flush)".
 *
 * Two shapes, deliberately separated:
 *
 * - **`tick()`** does exactly one unit of work and returns what it did. It
 *   takes no timers and does not loop.
 * - **`start()`** is a thin `setInterval` around `tick()`.
 *
 * Everything the tests care about lives in `tick()`, which is why the whole
 * M8 suite runs in milliseconds on a `FakeClock` instead of sleeping
 * through real lease expiries. A worker whose logic can only be exercised
 * by waiting is a worker whose edge cases are never exercised.
 *
 * **Interactive beats background by not starting** (design note 3.4). The
 * worker asks `busy()` before leasing and declines to pick up new work
 * while a user is waiting on a run. It does *not* preempt a background job
 * that is already in flight: cancelling a half-finished run to shave
 * latency off another one trades a visible cost for an invisible one.
 */
import type { Clock, Logger } from '../substrate/ports.js';
import type { Job, JobQueue } from './queue.js';
import type { ScheduleStore } from './schedule.js';

export type JobHandler = (job: Job) => Promise<void>;

export interface WorkerDeps {
  queue: JobQueue;
  schedules: ScheduleStore;
  clock: Clock;
  logger: Logger;
  handlers: Record<string, JobHandler>;
  /** True while an interactive run is in flight. Background work waits. */
  busy?: () => boolean;
  pollIntervalMs?: number;
}

export interface TickResult {
  /** 'ran' | 'idle' | 'yielded' (an interactive run has the floor). */
  outcome: 'ran' | 'idle' | 'yielded';
  jobId: string | null;
  scheduled: { fired: number; missed: number };
  error: string | null;
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly deps: WorkerDeps) {}

  /**
   * Fire due schedules, then run at most one job.
   *
   * Schedules are evaluated even when the worker is yielding to an
   * interactive run: enqueueing is cheap, and a 9am briefing that is
   * *recorded* as due at 9:00 and runs at 9:02 is correct, while one that
   * is not noticed until 9:02 has lost the slot it belonged to.
   */
  async tick(): Promise<TickResult> {
    const scheduled = this.deps.schedules.due();

    if (this.stopping) {
      return { outcome: 'idle', jobId: null, scheduled, error: null };
    }
    if (this.deps.busy?.() === true) {
      return { outcome: 'yielded', jobId: null, scheduled, error: null };
    }

    const job = this.deps.queue.lease();
    if (job === null) {
      return { outcome: 'idle', jobId: null, scheduled, error: null };
    }

    const handler = this.deps.handlers[job.kind];
    const startedAt = this.deps.clock.now();

    if (handler === undefined) {
      // An unknown kind is a bug, not a transient failure, but it still
      // goes through the normal failure path so it lands in the
      // dead-letter table where someone will see it.
      const message = `no handler registered for job kind '${job.kind}'`;
      this.deps.queue.fail(job.id, job.leaseToken, message);
      this.deps.logger.error('job.unhandled', { jobId: job.id, kind: job.kind });
      return { outcome: 'ran', jobId: job.id, scheduled, error: message };
    }

    this.running = handler(job).then(
      () => {
        this.deps.queue.complete(job.id, job.leaseToken, this.deps.clock.now() - startedAt);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const outcome = this.deps.queue.fail(job.id, job.leaseToken, message);
        this.deps.logger.warn('job.failed', {
          jobId: job.id,
          kind: job.kind,
          error: message,
          dead: outcome.dead,
        });
      },
    );

    let error: string | null = null;
    try {
      await this.running;
    } finally {
      this.running = null;
    }

    const after = this.deps.queue.get(job.id);
    if (after !== null && after.lastError !== null && after.status !== 'done') error = after.lastError;

    return { outcome: 'ran', jobId: job.id, scheduled, error };
  }

  /** Start the poll loop. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.stopping = false;
    const interval = this.deps.pollIntervalMs ?? 250;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.deps.logger.error('worker.tick.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, interval);
    // A background poller must never be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  /**
   * Graceful shutdown: refuse new work, finish what is in hand, return.
   *
   * §28's wording is "finish current, refuse new, flush", and the order
   * matters — setting `stopping` before awaiting is what makes the refusal
   * take effect for any tick that is already queued behind this one.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running !== null) await this.running;
  }
}
