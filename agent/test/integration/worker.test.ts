/**
 * Tests 32–38: the worker (§28).
 *
 * Everything here goes through `tick()` on a `FakeClock`. A worker whose
 * behaviour can only be observed by sleeping is a worker whose edge cases
 * are never tested, and §34.12 gives the whole suite sixty seconds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Worker, type JobHandler } from '../../src/orchestration/worker.js';
import { PRINCIPAL, harness, type SchedulingHarness } from '../fixtures/scheduling.js';

let h: SchedulingHarness;
let ran: string[];

beforeEach(() => {
  h = harness();
  ran = [];
});
afterEach(() => {
  h.close();
});

function workerWith(handlers: Record<string, JobHandler>, busy?: () => boolean): Worker {
  return new Worker({
    queue: h.queue,
    schedules: h.schedules,
    clock: h.clock,
    logger: h.substrate.logger,
    handlers,
    ...(busy === undefined ? {} : { busy }),
  });
}

const okHandler: JobHandler = async (job) => {
  ran.push(job.id);
  await Promise.resolve();
};

const enqueue = (kind = 'test.job') =>
  h.queue.enqueue({ kind, payload: {}, principal: PRINCIPAL });

describe('doing the work', () => {
  it('32. a tick runs exactly one job', async () => {
    const a = enqueue();
    const b = enqueue();
    const worker = workerWith({ 'test.job': okHandler });

    const first = await worker.tick();
    expect(first.outcome).toBe('ran');
    expect(first.jobId).toBe(a);
    expect(ran).toEqual([a]);
    expect(h.queue.get(a)!.status).toBe('done');
    expect(h.queue.get(b)!.status).toBe('pending');

    await worker.tick();
    expect(ran).toEqual([a, b]);
    expect((await worker.tick()).outcome).toBe('idle');
  });

  it('33. a throwing handler retries, and eventually dead-letters', async () => {
    const id = enqueue();
    const worker = workerWith({
      'test.job': () => Promise.reject(new Error('handler exploded')),
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await worker.tick();
      expect(result.error).toContain('handler exploded');
      const job = h.queue.get(id)!;
      if (job.status === 'pending') h.clock.set(job.runAfter);
    }

    expect(h.queue.get(id)!.status).toBe('dead');
    expect(h.queue.deadLetters()[0]!.error).toContain('handler exploded');
  });

  it('an unregistered job kind fails loudly rather than vanishing', async () => {
    const id = enqueue('nobody.handles.this');
    const worker = workerWith({ 'test.job': okHandler });
    const result = await worker.tick();
    expect(result.error).toContain('no handler registered');
    expect(h.queue.get(id)!.attempts).toBe(1);
  });
});

describe('priority and ownership', () => {
  it('34. no background job starts while an interactive run is in flight', async () => {
    const id = enqueue();
    let interactive = true;
    const worker = workerWith({ 'test.job': okHandler }, () => interactive);

    const yielded = await worker.tick();
    expect(yielded.outcome).toBe('yielded');
    expect(ran).toEqual([]);
    // Not leased either — a yielded tick must not burn an attempt.
    expect(h.queue.get(id)!.attempts).toBe(0);

    interactive = false;
    expect((await worker.tick()).outcome).toBe('ran');
    expect(ran).toEqual([id]);
  });

  it('35. completing with a stale lease token is refused', async () => {
    const id = enqueue();
    const first = h.queue.lease()!;

    // The lease expires and someone else picks the job up.
    h.clock.advance(61_000);
    const second = h.queue.lease()!;
    expect(second.id).toBe(id);

    // The original worker finally finishes and tries to report success.
    // Fencing: it lost the job, so it does not get to mark the *new*
    // attempt done.
    expect(h.queue.complete(id, first.leaseToken)).toBe(false);
    expect(h.queue.get(id)!.status).toBe('leased');
    expect(h.queue.fail(id, first.leaseToken, 'too late').retried).toBe(false);

    expect(h.queue.complete(id, second.leaseToken)).toBe(true);
    expect(h.queue.get(id)!.status).toBe('done');
  });

  it('36. two workers never run the same job', async () => {
    for (let i = 0; i < 4; i += 1) enqueue();
    const slow: JobHandler = async (job) => {
      ran.push(job.id);
      await Promise.resolve();
    };
    const a = workerWith({ 'test.job': slow });
    const b = workerWith({ 'test.job': slow });

    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);

    expect(ran).toHaveLength(4);
    expect(new Set(ran).size).toBe(4);
  });

  it('37. after a restart, leased jobs come back only once the lease expires', () => {
    const id = enqueue();
    h.queue.lease();

    // A restart that does not rebuild projections: the row is still
    // `leased` and its expiry is still in the future, so the job waits.
    // Impatience here is how a non-idempotent job runs twice.
    const restarted = h.reopen();
    try {
      expect(restarted.queue.lease()).toBeNull();
      restarted.clock.advance(61_000);
      expect(restarted.queue.lease()!.id).toBe(id);
    } finally {
      restarted.substrate.close();
    }
  });
});

describe('shutdown', () => {
  it('38. stop finishes the current job, refuses new ones, and leaves nothing held', async () => {
    const a = enqueue();
    const b = enqueue();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = workerWith({
      'test.job': async (job) => {
        ran.push(job.id);
        await gate;
      },
    });

    const inFlight = worker.tick();
    const stopping = worker.stop();
    release();
    await Promise.all([inFlight, stopping]);

    // The job that was in hand finished rather than being abandoned
    // half-done — that is what "graceful" means in §28.
    expect(ran).toEqual([a]);
    expect(h.queue.get(a)!.status).toBe('done');

    // And nothing new was picked up.
    const after = await worker.tick();
    expect(after.outcome).toBe('idle');
    expect(h.queue.get(b)!.status).toBe('pending');
    expect(h.queue.counts().leased).toBe(0);
  });
});
