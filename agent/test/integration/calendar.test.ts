/**
 * S1 tests 23–33: the calendar store, its projection and its trust rules.
 *
 * The one that matters most is 29. A calendar whose rows are the truth is
 * a calendar that a rebuild empties — so every assertion about what is in
 * the table is really an assertion about what the log can reconstruct.
 */
import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { CalendarStore, dayBounds, zonedToUtc } from '../../src/cognition/calendar/store.js';
import { makeCalendarAdd, makeCalendarCancel, makeCalendarList } from '../../src/tools/calendar.js';
import type { ToolContext } from '../../src/capability/tool.js';

const USER = 'user';
const utc = (wallClock: string): number => zonedToUtc(wallClock, 'UTC');

function fixture() {
  const substrate = createTestSubstrate();
  const store = new CalendarStore({
    storage: substrate.storage,
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
  });
  return { ...substrate, store };
}

describe('the calendar is events, not rows', () => {
  it('23. an add writes a calendar.added event and projects one row', () => {
    const s = fixture();
    const before = s.events.count();

    const event = s.store.add(USER, {
      title: 'Dentist',
      startsAt: utc('2026-07-01 09:30'),
      timezone: 'Europe/Lisbon',
      location: 'Rua Garrett 12',
    });

    expect(s.events.count()).toBe(before + 1);
    const [appended] = s.events.read({ types: ['calendar.added'], limit: 10 });
    expect(appended?.payload).toMatchObject({
      eventId: event.id,
      title: 'Dentist',
      startsAt: utc('2026-07-01 09:30'),
      location: 'Rua Garrett 12',
    });

    const row = s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM calendar_events')?.n;
    expect(row).toBe(1);
    // An event with no end gets an hour, which is what people mean.
    expect(event.endsAt).toBe(utc('2026-07-01 10:30'));
    s.close();
  });

  it('24. list is ordered by start time, not insertion order', () => {
    const s = fixture();
    s.store.add(USER, { title: 'third', startsAt: utc('2026-07-01 17:00') });
    s.store.add(USER, { title: 'first', startsAt: utc('2026-07-01 08:00') });
    s.store.add(USER, { title: 'second', startsAt: utc('2026-07-01 12:00') });

    const { from, to } = dayBounds(utc('2026-07-01 12:00'), 'UTC');
    expect(s.store.list(USER, { from, to: to + 1 }).map((e) => e.title)).toEqual([
      'first',
      'second',
      'third',
    ]);
    s.close();
  });

  it('25. list windows by from/to, and includes events that merely overlap', () => {
    const s = fixture();
    s.store.add(USER, { title: 'before', startsAt: utc('2026-06-30 10:00') });
    s.store.add(USER, { title: 'inside', startsAt: utc('2026-07-01 10:00') });
    s.store.add(USER, { title: 'after', startsAt: utc('2026-07-02 10:00') });
    // Starts the day before and runs into the window — a conference that
    // began yesterday is still on today, and a naive BETWEEN on
    // starts_at would drop it.
    s.store.add(USER, {
      title: 'straddles',
      startsAt: utc('2026-06-30 23:00'),
      endsAt: utc('2026-07-01 02:00'),
    });

    const { from, to } = dayBounds(utc('2026-07-01 12:00'), 'UTC');
    const titles = s.store.list(USER, { from, to }).map((e) => e.title);
    expect(titles).toContain('inside');
    expect(titles).toContain('straddles');
    expect(titles).not.toContain('before');
    expect(titles).not.toContain('after');
    s.close();
  });

  it('26. find matches title, location and notes', () => {
    const s = fixture();
    s.store.add(USER, { title: 'Standup', startsAt: utc('2026-07-01 09:00') });
    s.store.add(USER, {
      title: 'Lunch',
      startsAt: utc('2026-07-01 13:00'),
      location: 'Cantina Zé',
    });
    s.store.add(USER, {
      title: 'Review',
      startsAt: utc('2026-07-02 11:00'),
      notes: 'bring the migration plan',
    });

    expect(s.store.find(USER, 'standup').map((e) => e.title)).toEqual(['Standup']);
    expect(s.store.find(USER, 'cantina').map((e) => e.title)).toEqual(['Lunch']);
    expect(s.store.find(USER, 'migration').map((e) => e.title)).toEqual(['Review']);
    expect(s.store.find(USER, 'nothing here')).toEqual([]);
    s.close();
  });

  it('27. cancel removes it from list', () => {
    const s = fixture();
    const event = s.store.add(USER, { title: 'Dentist', startsAt: utc('2026-07-01 09:30') });
    const { from, to } = dayBounds(utc('2026-07-01 12:00'), 'UTC');
    expect(s.store.list(USER, { from, to })).toHaveLength(1);

    expect(s.store.cancel(USER, event.id)).toBe(true);
    expect(s.store.list(USER, { from, to })).toEqual([]);
    // Cancelling twice is not an error — the tool is idempotent — but it
    // must not append a second event.
    expect(s.store.cancel(USER, event.id)).toBe(true);
    expect(s.events.read({ types: ['calendar.cancelled'], limit: 10 })).toHaveLength(1);
    s.close();
  });

  it('28. a cancelled event is still in the log and still gettable', () => {
    const s = fixture();
    const event = s.store.add(USER, { title: 'Dentist', startsAt: utc('2026-07-01 09:30') });
    s.store.cancel(USER, event.id);

    // The row is stamped, never deleted: "what was on my calendar in
    // July" has to stay answerable after the thing is called off.
    const row = s.storage.get<{ cancelled_at: number | null; title: string }>(
      'SELECT cancelled_at, title FROM calendar_events WHERE id = ?',
      [event.id],
    );
    expect(row?.title).toBe('Dentist');
    expect(row?.cancelled_at).not.toBeNull();
    expect(s.events.read({ types: ['calendar.cancelled'], limit: 10 })).toHaveLength(1);
    s.close();
  });

  it('29. a rebuild from events alone reproduces the calendar exactly', () => {
    const s = fixture();
    const kept = s.store.add(USER, {
      title: 'Kept',
      startsAt: utc('2026-07-01 09:00'),
      location: 'Office',
      notes: 'agenda attached',
      timezone: 'Europe/Lisbon',
    });
    const dropped = s.store.add(USER, { title: 'Dropped', startsAt: utc('2026-07-02 09:00') });
    s.store.add(USER, { title: 'All hands', startsAt: utc('2026-07-03 00:00'), allDay: true });
    s.store.cancel(USER, dropped.id);

    const snapshot = s.storage.all('SELECT * FROM calendar_events ORDER BY id');
    expect(snapshot).toHaveLength(3);

    s.storage.exec('DELETE FROM calendar_events');
    expect(s.storage.all('SELECT * FROM calendar_events')).toHaveLength(0);

    s.events.rebuild();

    expect(s.storage.all('SELECT * FROM calendar_events ORDER BY id')).toEqual(snapshot);
    expect(s.store.get(USER, kept.id)).toEqual(kept);
    s.close();
  });

  it('30. an end before its start is refused', () => {
    const s = fixture();
    expect(() =>
      s.store.add(USER, {
        title: 'Backwards',
        startsAt: utc('2026-07-01 17:00'),
        endsAt: utc('2026-07-01 09:00'),
      }),
    ).toThrow(/end before it starts/);
    // And nothing was written: a refusal must not leave an event behind.
    expect(s.events.read({ types: ['calendar.added'], limit: 10 })).toHaveLength(0);
    s.close();
  });

  it('31. an all-day event spans the whole day and is flagged as such', () => {
    const s = fixture();
    const event = s.store.add(USER, {
      title: 'Public holiday',
      startsAt: utc('2026-07-01 00:00'),
      allDay: true,
    });
    expect(event.allDay).toBe(true);
    expect(event.endsAt - event.startsAt).toBe(24 * 60 * 60 * 1000 - 1);
    s.close();
  });

  it('keeps one principal out of another principal\u2019s calendar', () => {
    const s = fixture();
    s.store.add('alice', { title: 'Alice only', startsAt: utc('2026-07-01 09:00') });
    const { from, to } = dayBounds(utc('2026-07-01 12:00'), 'UTC');
    expect(s.store.list('bob', { from, to })).toEqual([]);
    expect(s.store.find('bob', 'alice')).toEqual([]);
    // And bob cannot cancel what he cannot see, even knowing the id.
    const alices = s.store.list('alice', { from, to })[0]!;
    expect(s.store.cancel('bob', alices.id)).toBe(false);
    expect(s.store.get('alice', alices.id)?.cancelledAt).toBeNull();
    s.close();
  });
});

describe('the calendar tools', () => {
  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      principal: USER,
      now: () => utc('2026-07-01 08:00'),
      effectiveTrust: 'USER',
      ...overrides,
    }) as unknown as ToolContext;

  it('32. DERIVED may add but may not cancel', () => {
    const s = fixture();
    const add = makeCalendarAdd({ store: s.store });
    const cancel = makeCalendarCancel({ store: s.store });

    // Not enforced in the tool body — the invoker enforces minTrust —
    // so what is asserted is the declaration the invoker reads. The
    // reasoning is decision 035's: a model may put something in your
    // calendar, because that is visible and reversible; taking
    // something out that you put there is not its call.
    expect(add.minTrust).toBe('DERIVED');
    expect(cancel.minTrust).toBe('USER');
    expect(add.risk).toBe('caution');
    expect(cancel.risk).toBe('dangerous');
    expect(cancel.dryRun).toBeTypeOf('function');
    s.close();
  });

  it('previews what a cancel would remove, by name and date', async () => {
    const s = fixture();
    const event = s.store.add(USER, { title: 'Dentist', startsAt: utc('2026-07-01 09:30') });
    const cancel = makeCalendarCancel({ store: s.store });

    const preview = await cancel.dryRun!({ id: event.id }, ctx());
    expect(preview).toContain('Dentist');
    expect(preview).toContain('2026-07-01');
    // And the preview changes nothing.
    expect(s.store.get(USER, event.id)?.cancelledAt).toBeNull();

    expect(await cancel.dryRun!({ id: 'C-nope' }, ctx())).toMatch(/no calendar event/);
    s.close();
  });

  it('33. reports an overlap rather than refusing it', async () => {
    const s = fixture();
    const add = makeCalendarAdd({ store: s.store });

    await add.execute(
      { title: 'Standup', when: '2026-07-01 09:00', timezone: 'UTC' },
      ctx(),
    );
    const clash = await add.execute(
      { title: 'Dentist', when: '2026-07-01 09:30', timezone: 'UTC' },
      ctx(),
    );

    expect(clash.ok).toBe(true);
    if (!clash.ok) return;
    // Double-booking is sometimes exactly what someone means to do. The
    // tool says so and gets out of the way.
    expect(clash.value.conflicts.map((c) => c.title)).toEqual(['Standup']);
    expect(add.renderForModel(clash, 200).text).toMatch(/overlaps 'Standup'/);

    const { from, to } = dayBounds(utc('2026-07-01 12:00'), 'UTC');
    expect(s.store.list(USER, { from, to })).toHaveLength(2);
    s.close();
  });

  it('takes a bare date as an all-day event and a date-time as timed', async () => {
    const s = fixture();
    const add = makeCalendarAdd({ store: s.store });

    const allDay = await add.execute({ title: 'Holiday', when: '2026-07-04', timezone: 'UTC' }, ctx());
    const timed = await add.execute(
      { title: 'Call', when: '2026-07-04 15:00', timezone: 'UTC' },
      ctx(),
    );
    expect(allDay.ok && allDay.value.allDay).toBe(true);
    expect(timed.ok && timed.value.allDay).toBe(false);
    s.close();
  });

  it('lists today by default, reading the injected clock', async () => {
    const s = fixture();
    s.store.add(USER, { title: 'Today', startsAt: utc('2026-07-01 09:00') });
    s.store.add(USER, { title: 'Tomorrow', startsAt: utc('2026-07-02 09:00') });
    const list = makeCalendarList({ store: s.store });

    const today = await list.execute({ days: 1, timezone: 'UTC' }, ctx());
    expect(today.ok && today.value.events.map((e) => e.title)).toEqual(['Today']);

    const week = await list.execute({ days: 7, timezone: 'UTC' }, ctx());
    expect(week.ok && week.value.events.map((e) => e.title)).toEqual(['Today', 'Tomorrow']);
    s.close();
  });

  it('says plainly when there is nothing on, rather than returning an empty object', async () => {
    const s = fixture();
    const list = makeCalendarList({ store: s.store });
    const result = await list.execute({ days: 1, timezone: 'UTC' }, ctx());
    expect(list.renderForModel(result, 100).text).toBe('Nothing in the calendar for that period.');
    s.close();
  });

  it('refuses a date it cannot read instead of inventing one', async () => {
    const s = fixture();
    const add = makeCalendarAdd({ store: s.store });
    const result = await add.execute(
      { title: 'Whenever', when: 'sometime next week', timezone: 'UTC' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(s.events.read({ types: ['calendar.added'], limit: 10 })).toHaveLength(0);
    s.close();
  });
});
