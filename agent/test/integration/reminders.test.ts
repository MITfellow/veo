/**
 * S3 tests 21–33: reminders.
 *
 * Deferred in S1 and again in S2, both times because the honest
 * answer was "this needs a scheduler and building a second one is how
 * you get an app with two clocks". §28's scheduler exists, so a
 * reminder is a one-shot schedule plus a link row.
 *
 * The tests that matter are the cascade ones (26–28). A reminder for
 * a task that no longer exists is the failure that teaches a person
 * to ignore reminders, and once they do that the feature is worse
 * than absent.
 */
import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { JobQueue } from '../../src/orchestration/queue.js';
import { ScheduleStore, SCHEDULED_RUN } from '../../src/orchestration/schedule.js';
import { ReminderStore } from '../../src/cognition/reminders/store.js';
import { TaskStore } from '../../src/cognition/tasks/store.js';
import { makeRemindersCancel, makeRemindersList, makeRemindersSet } from '../../src/tools/reminders.js';
import { permits } from '../../src/security/trust.js';
import type { ToolContext } from '../../src/capability/tool.js';

const USER = 'user';
const NOON = Date.UTC(2027, 4, 3, 12, 0, 0);
const at = (hours: number): number => NOON + hours * 3_600_000;

function fixture() {
  const substrate = createTestSubstrate();
  const { storage, events, clock, ids } = substrate;
  const queue = new JobQueue({ storage, events, clock, ids });
  const schedules = new ScheduleStore({ storage, events, clock, ids, queue });
  const tasks = new TaskStore({ storage, events, clock, ids });
  const store = new ReminderStore({ storage, events, clock, ids, schedules });
  return { ...substrate, queue, schedules, tasks, store };
}

const ctx = (): ToolContext =>
  ({ principal: USER, now: () => NOON, effectiveTrust: 'DERIVED' }) as unknown as ToolContext;

describe('a reminder is a schedule with an owner', () => {
  it('21. set appends reminder.set and creates a one-shot schedule', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Call the bank' });

    const reminder = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(4),
      text: 'Call the bank',
    });

    expect(reminder.remindAt).toBe(at(4));
    const schedule = s.schedules.get(reminder.scheduleId);
    expect(schedule?.kind).toBe('once');
    expect(schedule?.nextFireAt).toBe(at(4));
    expect(s.events.read({}).map((e) => e.type)).toContain('reminder.set');
  });

  it('22. there is exactly one timer in the system, and it is the scheduler', () => {
    // The reminder table holds no next-fire time of its own to drift
    // out of step with the schedule's.
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Renew the passport' });
    s.store.set(USER, { ownerKind: 'task', ownerId: task.id, remindAt: at(2), text: 'Passport' });

    const columns = s.storage
      .all<{ name: string }>("SELECT name FROM pragma_table_info('reminders')")
      .map((row) => row.name);
    expect(columns).toContain('schedule_id');
    expect(columns.filter((name) => name.includes('next'))).toEqual([]);
  });

  it('23. the firing goes through the queue as a scheduled run', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Take the bins out' });
    s.store.set(USER, { ownerKind: 'task', ownerId: task.id, remindAt: at(1), text: 'Bins' });

    const result = s.schedules.due(at(2));
    expect(result.fired).toBe(1);

    const job = s.queue.lease();
    expect(job?.kind).toBe(SCHEDULED_RUN);
    // The payload carries the reminder id, which is how the worker
    // knows to stamp `reminder.fired` at the moment it really fired.
    expect(typeof job?.payload.reminderId).toBe('string');
    expect(String(job?.payload.prompt)).toContain('Bins');
  });

  it('24. markFired stamps it once and only once', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Water the plants' });
    const reminder = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(1),
      text: 'Plants',
    });

    expect(s.store.markFired(USER, reminder.id)).toBe(true);
    expect(s.store.markFired(USER, reminder.id)).toBe(false);
    expect(s.store.get(USER, reminder.id)?.firedAt).not.toBeNull();
    expect(s.store.pending(USER)).toEqual([]);
  });

  it('25. cancelling removes the schedule too, so nothing is left armed', () => {
    // The bug this is here for: cancel the reminder, leave the
    // schedule, and the person is told about something they called
    // off — which is worse than the original problem.
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Dentist' });
    const reminder = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(1),
      text: 'Dentist',
    });

    expect(s.store.cancel(USER, reminder.id)).toBe(true);
    expect(s.schedules.get(reminder.scheduleId)).toBeNull();
    expect(s.schedules.due(at(2)).fired).toBe(0);
    expect(s.store.pending(USER)).toEqual([]);
  });
});

describe('a reminder belongs to something, and goes when it does', () => {
  it('26. cancelFor takes every pending reminder on an owner', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'File the return' });
    s.store.set(USER, { ownerKind: 'task', ownerId: task.id, remindAt: at(1), text: 'Return 1' });
    s.store.set(USER, { ownerKind: 'task', ownerId: task.id, remindAt: at(5), text: 'Return 2' });

    expect(s.store.cancelFor(USER, 'task', task.id, 'task completed')).toBe(2);
    expect(s.store.pending(USER)).toEqual([]);
    expect(s.schedules.due(at(9)).fired).toBe(0);
  });

  it('27. a reminder that already fired is not cancelled retrospectively', () => {
    // "I was reminded and ignored it" is a true fact about the past
    // and must survive the task being completed afterwards.
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Pay the invoice' });
    const reminder = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(1),
      text: 'Invoice',
    });
    s.store.markFired(USER, reminder.id);

    expect(s.store.cancelFor(USER, 'task', task.id, 'task completed')).toBe(0);
    const after = s.store.get(USER, reminder.id);
    expect(after?.firedAt).not.toBeNull();
    expect(after?.cancelledAt).toBeNull();
  });

  it('28. the reason is recorded, so the log says why it went quiet', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Ring the plumber' });
    s.store.set(USER, { ownerKind: 'task', ownerId: task.id, remindAt: at(3), text: 'Plumber' });
    s.store.cancelFor(USER, 'task', task.id, 'task dropped');

    const cancelled = s.events.read({}).filter((e) => e.type === 'reminder.cancelled');
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0]!.payload as { reason: string }).reason).toBe('task dropped');
  });

  it("29. one principal cannot see or cancel another's reminders", () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Private' });
    const reminder = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(1),
      text: 'Private',
    });

    expect(s.store.get('someone-else', reminder.id)).toBeUndefined();
    expect(s.store.cancel('someone-else', reminder.id)).toBe(false);
    expect(s.store.pending('someone-else')).toEqual([]);
    expect(s.store.get(USER, reminder.id)?.cancelledAt).toBeNull();
  });

  it('30. a rebuild reproduces the reminders from the log', () => {
    const s = fixture();
    const task = s.tasks.add(USER, { title: 'Collect the parcel' });
    const kept = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(6),
      text: 'Parcel',
    });
    const gone = s.store.set(USER, {
      ownerKind: 'task',
      ownerId: task.id,
      remindAt: at(7),
      text: 'Other',
    });
    s.store.cancel(USER, gone.id);

    s.storage.exec('DELETE FROM reminders');
    s.events.rebuild();

    expect(s.store.get(USER, kept.id)?.text).toBe('Parcel');
    expect(s.store.get(USER, gone.id)?.cancelledAt).not.toBeNull();
    expect(s.store.pending(USER).map((r) => r.id)).toEqual([kept.id]);
  });
});

describe('the reminder tools', () => {
  it('31. refuse an owner that does not exist', async () => {
    const s = fixture();
    const set = makeRemindersSet({ store: s.store, tasks: s.tasks });

    const result = await set.execute(
      {
        text: 'Something',
        when: '2027-05-04 09:00',
        ownerKind: 'task',
        ownerId: 'T-nope',
        timezone: 'UTC',
      },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(s.store.pending(USER)).toEqual([]);
  });

  it('32. set, list and cancel round-trip through the tools', async () => {
    const s = fixture();
    const deps = { store: s.store, tasks: s.tasks };
    const task = s.tasks.add(USER, { title: 'Book the car in' });

    const created = await makeRemindersSet(deps).execute(
      {
        text: 'Book the car in',
        when: '2027-05-04 08:30',
        ownerKind: 'task',
        ownerId: task.id,
        timezone: 'UTC',
      },
      ctx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.remindAt).toBe(Date.UTC(2027, 4, 4, 8, 30));

    const listed = await makeRemindersList(deps).execute({ includeDone: false, limit: 20 }, ctx());
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.reminders.map((r) => r.id)).toEqual([created.value.id]);

    const cancel = makeRemindersCancel(deps);
    // Dangerous, so it must be able to describe itself before doing it.
    expect(cancel.risk).toBe('dangerous');
    expect(await cancel.dryRun!({ id: created.value.id }, ctx())).toContain('Book the car in');
    expect((await cancel.execute({ id: created.value.id }, ctx())).ok).toBe(true);
    expect(s.store.pending(USER)).toEqual([]);
  });

  it('33. the agent may set a reminder but not call one off, and still cannot schedule', () => {
    // Decision 041. The capability is `reminder:set`, deliberately not
    // `schedule:create`: giving DERIVED the latter back would undo
    // decision 035 and hand model output a standing reason to wake up.
    const s = fixture();
    const deps = { store: s.store, tasks: s.tasks };

    expect(makeRemindersSet(deps).minTrust).toBe('DERIVED');
    expect(makeRemindersSet(deps).capabilities).toEqual(['reminder:set']);
    expect(makeRemindersCancel(deps).minTrust).toBe('USER');

    expect(permits('DERIVED', 'reminder:set')).toBe(true);
    expect(permits('DERIVED', 'schedule:create')).toBe(false);
    // And nothing untrusted gets either one.
    expect(permits('FOREIGN', 'reminder:set')).toBe(false);
    expect(permits('FOREIGN', 'reminder:read')).toBe(false);
    expect(permits('TOOL', 'reminder:set')).toBe(false);
  });
});
