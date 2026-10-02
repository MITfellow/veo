/**
 * Tests 41–50: the scheduler (§28), ending with §33's bar for this
 * milestone:
 *
 *   "every weekday 9am" survives restarts, a timezone change and a 3-day
 *   outage, with correct catch-up.
 *
 * That is test 48, and the other nine exist to make its failure
 * interpretable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instantOfLocal, localPartsOf } from '../../src/orchestration/cron.js';
import { MAX_CATCH_UP, SCHEDULED_RUN } from '../../src/orchestration/schedule.js';
import { DAY, NY, PRINCIPAL, harness, type SchedulingHarness } from '../fixtures/scheduling.js';

let h: SchedulingHarness;

/** Monday 2026-01-05, 08:00 New York. */
const MONDAY_8AM = instantOfLocal({ year: 2026, month: 1, day: 5, hour: 8, minute: 0 }, NY)!;

beforeEach(() => {
  h = harness({ now: MONDAY_8AM, timezone: NY });
});
afterEach(() => {
  h.close();
});

function wall(ts: number | null, timezone = NY): string {
  if (ts === null) return 'never';
  const p = localPartsOf(ts, timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

const weekdays = (over: Partial<{ catchUp: 'fire-all' | 'fire-once' | 'skip' }> = {}) =>
  h.schedules.create(PRINCIPAL, {
    name: 'Morning briefing',
    spec: '0 9 * * 1-5',
    timezone: NY,
    payload: { prompt: 'What is on today?' },
    catchUp: over.catchUp ?? 'fire-once',
  });

describe('the store', () => {
  it('41. create, list, update and delete, each as an event', () => {
    const schedule = weekdays();
    expect(schedule.nextFireAt).not.toBeNull();
    expect(wall(schedule.nextFireAt)).toBe('2026-01-05 09:00');
    expect(h.schedules.list(PRINCIPAL)).toHaveLength(1);

    h.schedules.update(PRINCIPAL, schedule.id, { enabled: false });
    expect(h.schedules.get(schedule.id)!.enabled).toBe(false);

    expect(h.schedules.delete(PRINCIPAL, schedule.id)).toBe(true);
    expect(h.schedules.get(schedule.id)).toBeNull();

    const types = h.substrate.events
      .read({ types: ['schedule.created', 'schedule.updated', 'schedule.deleted'] })
      .map((e) => e.type);
    expect(types).toEqual(['schedule.created', 'schedule.updated', 'schedule.deleted']);
  });

  it('42. a due schedule enqueues exactly one job', () => {
    const schedule = weekdays();
    expect(h.schedules.due().fired).toBe(0); // 08:00, not due yet

    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    const result = h.schedules.due();
    expect(result.fired).toBe(1);
    expect(result.enqueued).toHaveLength(1);

    const [job] = h.queue.list({ scheduleId: schedule.id });
    expect(job!.kind).toBe(SCHEDULED_RUN);
    expect(job!.principal).toBe(PRINCIPAL);
    expect(job!.payload).toMatchObject({ scheduleId: schedule.id, prompt: 'What is on today?' });
    expect(wall(schedule.nextFireAt)).toBe('2026-01-05 09:00');
    expect(wall(h.schedules.get(schedule.id)!.nextFireAt)).toBe('2026-01-06 09:00');
  });

  it('43. ticking twice inside the same slot does not fire twice', () => {
    const schedule = weekdays();
    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    h.schedules.due();
    h.clock.advance(30_000);
    expect(h.schedules.due().fired).toBe(0);
    h.clock.advance(30_000);
    expect(h.schedules.due().fired).toBe(0);
    expect(h.queue.list({ scheduleId: schedule.id })).toHaveLength(1);
    expect(h.schedules.get(schedule.id)!.fireCount).toBe(1);
  });
});

describe('catch-up after an outage', () => {
  /** Nothing ran from Monday 08:00 until Thursday 14:00. */
  const outage = () => h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 8, hour: 14, minute: 0 }, NY)!);

  it('44. skip runs nothing, and reports every slot it did not run', () => {
    const schedule = weekdays({ catchUp: 'skip' });
    outage();

    const result = h.schedules.due();
    expect(result.fired).toBe(0);
    // Monday, Tuesday, Wednesday, Thursday.
    expect(result.missed).toBe(4);
    expect(h.schedules.get(schedule.id)!.missedCount).toBe(4);
    // Silence would be the actual failure: "your agent did not do these
    // four things" is information the user is owed.
    const missed = h.substrate.events.read({ types: ['schedule.missed'] });
    expect(missed).toHaveLength(4);
    expect(wall((missed[0]!.payload as { scheduledFor: number }).scheduledFor)).toBe('2026-01-05 09:00');
  });

  it('45. fire-once runs the most recent slot only', () => {
    const schedule = weekdays({ catchUp: 'fire-once' });
    outage();

    const result = h.schedules.due();
    expect(result.fired).toBe(1);
    expect(result.missed).toBe(3);

    // The one that runs is *this morning's*, not Monday's: a stale
    // briefing is worse than a late one.
    const fired = h.substrate.events.read({ types: ['schedule.fired'] });
    expect(wall((fired[0]!.payload as { scheduledFor: number }).scheduledFor)).toBe('2026-01-08 09:00');
    expect(h.queue.list({ scheduleId: schedule.id })).toHaveLength(1);
  });

  it('46. fire-all is bounded, and the remainder is reported as missed', () => {
    const schedule = weekdays({ catchUp: 'fire-all' });
    // A month away, not three days: more missed slots than the cap.
    h.clock.set(instantOfLocal({ year: 2026, month: 2, day: 9, hour: 14, minute: 0 }, NY)!);

    const result = h.schedules.due();
    expect(result.fired).toBe(MAX_CATCH_UP);
    expect(result.missed).toBeGreaterThan(0);
    // An unbounded fire-all after a long absence is a denial of service
    // the agent commits against its own owner.
    expect(h.queue.list({ scheduleId: schedule.id, limit: 100 })).toHaveLength(MAX_CATCH_UP);
  });
});

describe('moving in time and space', () => {
  it('47. changing the timezone re-anchors to the new wall clock', () => {
    const schedule = weekdays();
    expect(wall(schedule.nextFireAt)).toBe('2026-01-05 09:00');

    const moved = h.schedules.update(PRINCIPAL, schedule.id, { timezone: 'Europe/Lisbon' })!;
    // Still 9am — on the new wall clock. It is 08:00 in New York, which is
    // already 13:00 in Lisbon, so today's Lisbon slot has gone and the
    // next one is tomorrow morning. Re-anchoring from *now* rather than
    // from the old instant is what makes "9am" keep meaning 9am: flying
    // east costs you today's alarm, exactly as a physical one would.
    expect(wall(moved.nextFireAt, 'Europe/Lisbon')).toBe('2026-01-06 09:00');
    expect(wall(moved.nextFireAt, NY)).toBe('2026-01-06 04:00'); // Lisbon is UTC+0 in January, New York UTC-5
  });

  it('48. §33: weekday 9am survives a restart, a move and a three-day outage', () => {
    const schedule = weekdays({ catchUp: 'fire-once' });

    // Monday morning: it fires.
    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    expect(h.schedules.due().fired).toBe(1);

    // The process dies and comes back. Nothing is lost and nothing
    // re-fires: `last_fired_at` is durable.
    let current = h.reopen();
    try {
      expect(current.schedules.get(schedule.id)!.fireCount).toBe(1);
      expect(current.schedules.due().fired).toBe(0);

      // The user flies to Lisbon on Tuesday and changes their timezone.
      current.clock.set(instantOfLocal({ year: 2026, month: 1, day: 6, hour: 12, minute: 0 }, NY)!);
      current.schedules.update(PRINCIPAL, schedule.id, { timezone: 'Europe/Lisbon' });
      expect(wall(current.schedules.get(schedule.id)!.nextFireAt, 'Europe/Lisbon')).toBe('2026-01-07 09:00');

      // Then the laptop is shut for three days: Wednesday, Thursday,
      // Friday all pass unexecuted. It comes back on Saturday afternoon.
      current = current.reopen();
      current.clock.set(instantOfLocal({ year: 2026, month: 1, day: 10, hour: 15, minute: 0 }, 'Europe/Lisbon')!);

      const result = current.schedules.due();
      // Four weekday slots passed unexecuted on the new wall clock —
      // Tuesday (the move happened at 17:00 Lisbon, after that morning's
      // slot), Wednesday, Thursday, Friday. fire-once runs the latest and
      // reports the other three.
      expect(result.fired).toBe(1);
      expect(result.missed).toBe(3);

      const fires = current.substrate.events.read({ types: ['schedule.fired'] });
      expect(wall((fires.at(-1)!.payload as { scheduledFor: number }).scheduledFor, 'Europe/Lisbon')).toBe(
        '2026-01-09 09:00',
      );

      // And the next fire is Monday 9am Lisbon — not Saturday, not 4am.
      expect(wall(current.schedules.get(schedule.id)!.nextFireAt, 'Europe/Lisbon')).toBe('2026-01-12 09:00');

      // Exactly one job per fire across the whole story, and no duplicates.
      const jobs = current.queue.list({ scheduleId: schedule.id, limit: 100 });
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((j) => JSON.stringify(j.payload))).size).toBe(2);
    } finally {
      current.substrate.close();
    }
  });
});

describe('failures and deletion', () => {
  it('49. a failed scheduled run retries as a job; the schedule does not re-fire', () => {
    const schedule = weekdays();
    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    h.schedules.due();

    const leased = h.queue.lease()!;
    const outcome = h.queue.fail(leased.id, leased.leaseToken, 'model unreachable');
    expect(outcome.retried).toBe(true);

    // The *job* comes back. The *schedule* has already fired for this slot
    // and must not produce a second one, or a flaky model turns one
    // briefing into five.
    h.clock.set(outcome.retryAt!);
    expect(h.schedules.due().fired).toBe(0);
    expect(h.queue.list({ scheduleId: schedule.id })).toHaveLength(1);
    expect(h.queue.lease()!.id).toBe(leased.id);
  });

  it('50. deleting a schedule cancels the work it has already queued', () => {
    const schedule = weekdays();
    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    h.schedules.due();
    expect(h.queue.counts().pending).toBe(1);

    h.schedules.delete(PRINCIPAL, schedule.id);
    // A briefing enqueued five minutes ago for a schedule the user has
    // just deleted is not something they asked for.
    expect(h.queue.counts().pending).toBe(0);
    expect(h.queue.lease()).toBeNull();
  });

  it('a one-shot fires once and then disables itself', () => {
    const once = h.schedules.create(PRINCIPAL, {
      name: 'Remind me',
      spec: String(h.clock.now() + DAY),
      payload: { prompt: 'call the dentist' },
      kind: 'once',
    });

    h.clock.advance(DAY + 1000);
    expect(h.schedules.due().fired).toBe(1);
    h.clock.advance(DAY);
    expect(h.schedules.due().fired).toBe(0);
    expect(h.schedules.get(once.id)!.enabled).toBe(false);
    expect(h.schedules.get(once.id)!.nextFireAt).toBeNull();
  });
});
