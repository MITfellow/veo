/**
 * Tests 57–60: attacks on the clock (§28, §12).
 *
 * A scheduler is a standing grant of future authority, which makes it the
 * most attractive thing in the system to an attacker who only gets one
 * shot at the input. The four attacks worth taking seriously are: get a
 * schedule created from untrusted content, get one that fires constantly,
 * get the clock to do the work, and get a job to run as someone else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateCron } from '../../src/orchestration/cron.js';
import { capabilitiesFor, permits } from '../../src/security/trust.js';
import { SCHEDULED_RUN } from '../../src/orchestration/schedule.js';
import { instantOfLocal } from '../../src/orchestration/cron.js';
import { NY, PRINCIPAL, harness, type SchedulingHarness } from '../fixtures/scheduling.js';

let h: SchedulingHarness;
beforeEach(() => {
  h = harness({ now: instantOfLocal({ year: 2026, month: 1, day: 5, hour: 8, minute: 0 }, NY)!, timezone: NY });
});
afterEach(() => {
  h.close();
});

describe('the clock is not a way in', () => {
  it('57. untrusted content cannot create a schedule', () => {
    // The capability is trust-gated, and FOREIGN does not have it. This is
    // the structural answer: there is no `schedule.create` tool for a web
    // page to talk its way into, and even if there were, the lattice
    // refuses the capability before the tool is reached.
    expect(permits('USER', 'schedule:create')).toBe(true);
    // Not even the agent's own output: a schedule is a standing grant of
    // future authority, and DERIVED is downstream of every page the agent
    // has ever been shown.
    expect(permits('DERIVED', 'schedule:create')).toBe(false);
    expect(permits('TOOL', 'schedule:create')).toBe(false);
    expect(permits('FOREIGN', 'schedule:create')).toBe(false);
    // (There is no 'UNTRUSTED' level — §12's floor is FOREIGN.)
    // The lattice property still holds after the change: a lower level
    // never has a capability a higher one lacks.
    for (const capability of capabilitiesFor('DERIVED')) {
      expect(permits('USER', capability)).toBe(true);
    }

    // And the event itself is written at USER trust by the store, so a
    // replay cannot be convinced that a page authored one.
    h.schedules.create(PRINCIPAL, { name: 'ok', spec: '0 9 * * *', payload: { prompt: 'hi' } });
    const [created] = h.substrate.events.read({ types: ['schedule.created'] });
    expect(created!.trust).toBe('USER');
    expect(created!.principal).toBe(PRINCIPAL);
  });

  it('58. a schedule that would fire constantly is refused', () => {
    for (const spec of ['* * * * *', '*/1 * * * *', '*/2 * * * *']) {
      expect(() => validateCron(spec, NY)).toThrow(/denial of service/);
    }
    // The floor is five minutes, so the legitimate end of the range is
    // still expressible.
    expect(() => validateCron('*/5 * * * *', NY)).not.toThrow();

    // The store refuses too — the check lives below the HTTP edge, so a
    // second caller cannot skip it.
    expect(() =>
      h.schedules.create(PRINCIPAL, { name: 'greedy', spec: '* * * * *', payload: { prompt: 'x' } }),
    ).toThrow(/denial of service/);
    expect(h.schedules.list()).toHaveLength(0);
  });

  it('59. a clock that jumps backwards neither double-fires nor stalls', () => {
    const schedule = h.schedules.create(PRINCIPAL, {
      name: 'briefing',
      spec: '0 9 * * *',
      timezone: NY,
      payload: { prompt: 'hi' },
    });

    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    expect(h.schedules.due().fired).toBe(1);

    // NTP corrects a fast clock backwards by two minutes, so "now" is
    // before the fire that already happened.
    h.clock.advance(-120_000);
    expect(h.schedules.due().fired).toBe(0);
    expect(h.schedules.due().missed).toBe(0);

    // And the system is not wedged: tomorrow still fires, exactly once.
    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 6, hour: 9, minute: 30 }, NY)!);
    expect(h.schedules.due().fired).toBe(1);
    expect(h.schedules.get(schedule.id)!.fireCount).toBe(2);
  });

  it('60. a payload cannot smuggle a different principal', () => {
    h.schedules.create(PRINCIPAL, {
      name: 'innocent',
      spec: '0 9 * * *',
      timezone: NY,
      // The payload is data. Data does not get to choose whose authority
      // it runs under (§12), so these keys are inert.
      payload: { prompt: 'hi', principal: 'user:attacker', trust: 'USER', scheduleId: 'spoofed' },
    });

    h.clock.set(instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!);
    h.schedules.due();

    const job = h.queue.lease()!;
    expect(job.kind).toBe(SCHEDULED_RUN);
    // The principal comes from the schedule row, and the scheduleId the
    // store writes wins over the one in the payload because it is applied
    // after the spread.
    expect(job.principal).toBe(PRINCIPAL);
    expect(job.scheduleId).not.toBe('spoofed');
    expect(job.payload.scheduleId).not.toBe('spoofed');

    const [enqueued] = h.substrate.events.read({ types: ['job.enqueued'] });
    expect(enqueued!.principal).toBe(PRINCIPAL);
  });
});
