/**
 * Tests 13–24: the queue (§28).
 *
 * The properties worth protecting are the ones that bite in production and
 * are invisible in a demo: no double delivery, no job lost to a dead
 * worker, no retry storm, and no silent discard once the attempts run out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backoffFor, jitterFactor, MAX_BACKOFF_MS } from '../../src/orchestration/queue.js';
import { PRINCIPAL, harness, type SchedulingHarness } from '../fixtures/scheduling.js';

let h: SchedulingHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const job = (over: Partial<{ kind: string; priority: number; runAfter: number; key: string }> = {}) =>
  h.queue.enqueue({
    kind: over.kind ?? 'test.job',
    payload: { n: 1 },
    principal: PRINCIPAL,
    ...(over.priority === undefined ? {} : { priority: over.priority }),
    ...(over.runAfter === undefined ? {} : { runAfter: over.runAfter }),
    ...(over.key === undefined ? {} : { idempotencyKey: over.key }),
  });

describe('the lifecycle', () => {
  it('13. enqueue makes a pending job, visible and recorded', () => {
    const id = job();
    const stored = h.queue.get(id)!;
    expect(stored.status).toBe('pending');
    expect(stored.attempts).toBe(0);
    expect(stored.payload).toEqual({ n: 1 });
    expect(stored.principal).toBe(PRINCIPAL);
    expect(h.substrate.events.read({ types: ['job.enqueued'] })).toHaveLength(1);
  });

  it('14. leasing marks it leased, sets an expiry and counts the attempt', () => {
    const id = job();
    const leased = h.queue.lease()!;
    expect(leased.id).toBe(id);
    expect(leased.attempts).toBe(1);
    expect(leased.leaseUntil).toBe(h.clock.now() + 60_000);
    expect(leased.leaseToken).not.toBe('');
    expect(h.queue.get(id)!.status).toBe('leased');
  });

  it('15. a leased job is invisible to a second lease', () => {
    job();
    expect(h.queue.lease()).not.toBeNull();
    // The single most important property in the file: two workers, or one
    // worker ticking twice, must never run the same job concurrently.
    expect(h.queue.lease()).toBeNull();
  });

  it('16. an expired lease makes the job available again', () => {
    job();
    const first = h.queue.lease()!;
    h.clock.advance(59_000);
    expect(h.queue.lease()).toBeNull();
    h.clock.advance(2_000);
    const second = h.queue.lease()!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
  });

  it('17. completing ends it, and it is never delivered again', () => {
    const id = job();
    const leased = h.queue.lease()!;
    expect(h.queue.complete(id, leased.leaseToken, 12)).toBe(true);
    expect(h.queue.get(id)!.status).toBe('done');
    h.clock.advance(10 * 60_000);
    expect(h.queue.lease()).toBeNull();
  });
});

describe('failure', () => {
  it('18. a failure backs off exponentially, with jitter, deterministically', () => {
    const id = job();
    const leased = h.queue.lease()!;
    const outcome = h.queue.fail(id, leased.leaseToken, 'boom');

    expect(outcome.retried).toBe(true);
    expect(outcome.dead).toBe(false);
    const delay = outcome.retryAt! - h.clock.now();
    // Attempt 1: base 1000ms × jitter in [0.5, 1.5).
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThan(1500);

    // The job is pending again but not yet runnable.
    expect(h.queue.get(id)!.status).toBe('pending');
    expect(h.queue.lease()).toBeNull();
    h.clock.set(outcome.retryAt!);
    expect(h.queue.lease()).not.toBeNull();

    // Jitter is derived, not random: the same history always produces the
    // same delay, which is what makes a replayed run byte-identical.
    expect(jitterFactor('abc', 1)).toBe(jitterFactor('abc', 1));
    expect(jitterFactor('abc', 1)).not.toBe(jitterFactor('abd', 1));
    expect(backoffFor('abc', 1)).toBeLessThan(backoffFor('abc', 5));
    expect(backoffFor('abc', 40)).toBeLessThanOrEqual(Math.round(MAX_BACKOFF_MS * 1.5));
  });

  it('19. attempts run out → dead letter, with the payload kept', () => {
    const id = job();
    for (let i = 0; i < 5; i += 1) {
      const leased = h.queue.lease()!;
      const outcome = h.queue.fail(id, leased.leaseToken, `boom ${i}`);
      if (outcome.retryAt !== null) h.clock.set(outcome.retryAt);
    }

    expect(h.queue.get(id)!.status).toBe('dead');
    const [dead] = h.queue.deadLetters();
    expect(dead!.id).toBe(id);
    expect(dead!.attempts).toBe(5);
    expect(dead!.error).toContain('boom 4');
    // A dead job keeps its payload: the point of a dead-letter table is
    // that a person can look at what was being attempted.
    expect(dead!.payload).toEqual({ n: 1 });
    expect(h.queue.lease()).toBeNull();
  });

  it('20. a dead letter can be replayed, as a new job', () => {
    const id = job();
    for (let i = 0; i < 5; i += 1) {
      const leased = h.queue.lease()!;
      const outcome = h.queue.fail(id, leased.leaseToken, 'boom');
      if (outcome.retryAt !== null) h.clock.set(outcome.retryAt);
    }

    const replayId = h.queue.replay(id)!;
    // A *new* job: the dead one's history is part of the record of what
    // this agent did, and a retry four days later is a new attempt.
    expect(replayId).not.toBe(id);
    expect(h.queue.get(replayId)!.status).toBe('pending');
    expect(h.queue.get(id)!.status).toBe('dead');
    expect(h.queue.deadLetters()[0]!.replayedAt).toBe(h.clock.now());
  });
});

describe('ordering and admission', () => {
  it('21. priority first, then due time, then arrival', () => {
    const low = job({ priority: 0 });
    const high = job({ priority: 10 });
    const alsoLow = job({ priority: 0 });

    expect(h.queue.lease()!.id).toBe(high);
    expect(h.queue.lease()!.id).toBe(low);
    expect(h.queue.lease()!.id).toBe(alsoLow);
  });

  it('22. a job scheduled for later is not leased now', () => {
    const later = job({ runAfter: h.clock.now() + 60_000 });
    expect(h.queue.lease()).toBeNull();
    h.clock.advance(60_001);
    expect(h.queue.lease()!.id).toBe(later);
  });

  it('23. an idempotency key that is already outstanding does not enqueue twice', () => {
    const first = job({ key: 'briefing:2026-01-01' });
    const second = job({ key: 'briefing:2026-01-01' });
    expect(second).toBe(first);
    expect(h.queue.list({ status: 'pending' })).toHaveLength(1);

    // But the same key is reusable once the work is finished — otherwise a
    // daily schedule would fire exactly once in the lifetime of the install.
    const leased = h.queue.lease()!;
    h.queue.complete(first, leased.leaseToken);
    const tomorrow = job({ key: 'briefing:2026-01-01' });
    expect(tomorrow).not.toBe(first);
  });
});

describe('rebuild', () => {
  it('24. job state comes back from the log; leases do not', () => {
    const done = job();
    const leasedToken = h.queue.lease()!;
    h.queue.complete(done, leasedToken.leaseToken);

    const outstanding = job();
    const held = h.queue.lease()!;
    expect(h.queue.get(outstanding)!.status).toBe('leased');

    h.substrate.events.rebuild();

    // The life of the job is in the log and comes back exactly.
    expect(h.queue.get(done)!.status).toBe('done');
    expect(h.queue.get(outstanding)!.status).toBe('leased');
    expect(h.queue.get(outstanding)!.attempts).toBe(1);

    // The lease does not, and that is correct: a rebuild implies a
    // restart, and a restart voids every claim. The job is immediately
    // claimable again rather than stuck until an expiry that nobody is
    // left to honour.
    const reclaimed = h.queue.lease()!;
    expect(reclaimed.id).toBe(outstanding);
    expect(reclaimed.leaseToken).not.toBe(held.leaseToken);
  });
});
