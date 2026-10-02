/**
 * Tests 1–12: cron, by the wall clock (§28).
 *
 * The DST cases are the reason this file exists. §33's bar for M8 names a
 * timezone change explicitly, and every scheduler that has ever gone wrong
 * in production went wrong here: it computed an offset once and added it,
 * so twice a year it fired at 8am or 10am, or twice, or not at all.
 *
 * Instants are written as UTC and asserted as local wall-clock readings,
 * because the wall clock is the thing the person actually cares about.
 */
import { describe, expect, it } from 'vitest';
import {
  CronParseError,
  MIN_INTERVAL_MS,
  firesBetween,
  instantOfLocal,
  localPartsOf,
  nextFireAfter,
  parseCron,
  validateCron,
} from '../../src/orchestration/cron.js';

const NY = 'America/New_York';
const LONDON = 'Europe/London';
const KOLKATA = 'Asia/Kolkata';

/** "2026-03-08 02:30" in a zone, as a readable assertion. */
function wall(ts: number, timezone: string): string {
  const p = localPartsOf(ts, timezone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function at(spec: string, from: number, timezone: string): string {
  const next = nextFireAfter(parseCron(spec), from, timezone);
  return next === null ? 'never' : wall(next, timezone);
}

describe('parsing', () => {
  it('1. parses the five fields, and says what is wrong when it cannot', () => {
    const parsed = parseCron('30 9 * * 1-5');
    expect([...parsed.minute]).toEqual([30]);
    expect([...parsed.hour]).toEqual([9]);
    expect([...parsed.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.domRestricted).toBe(false);
    expect(parsed.dowRestricted).toBe(true);

    const bad: Array<[string, string]> = [
      ['9 * * *', 'expected 5 fields'],
      ['99 9 * * *', 'outside 0-59'],
      ['0 9 * * xyz', 'not a number'],
      ['0 9 * * 1-5/0', 'not a step'],
      ['0 25 * * *', 'outside 0-23'],
    ];
    for (const [spec, message] of bad) {
      expect(() => parseCron(spec)).toThrow(CronParseError);
      expect(() => parseCron(spec)).toThrow(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('2. understands steps, ranges, lists and steps over ranges', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0,30 * * * *').minute]).toEqual([0, 30]);
    expect([...parseCron('0 9-17 * * *').hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parseCron('0 9-17/4 * * *').hour]).toEqual([9, 13, 17]);
    expect([...parseCron('0 0 1 */3 *').month]).toEqual([1, 4, 7, 10]);
  });

  it('3. takes day and month names, and 7 means Sunday', () => {
    expect([...parseCron('0 9 * * mon-fri').dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 1 jan,jul *').month]).toEqual([1, 7]);
    // Both spellings of Sunday collapse to one value, so nothing downstream
    // has to remember the wart.
    expect([...parseCron('0 9 * * 7').dayOfWeek]).toEqual([0]);
    expect([...parseCron('0 9 * * 0,7').dayOfWeek]).toEqual([0]);
  });
});

describe('finding the next fire', () => {
  it('4. "every weekday 9am" skips the weekend', () => {
    // Friday 2026-01-02 10:00 New York.
    const friday = instantOfLocal({ year: 2026, month: 1, day: 2, hour: 10, minute: 0 }, NY)!;
    expect(at('0 9 * * 1-5', friday, NY)).toBe('2026-01-05 09:00'); // Monday
    const monday = instantOfLocal({ year: 2026, month: 1, day: 5, hour: 10, minute: 0 }, NY)!;
    expect(at('0 9 * * 1-5', monday, NY)).toBe('2026-01-06 09:00'); // Tuesday
  });

  it('5. the next fire is strictly after the instant given', () => {
    const nine = instantOfLocal({ year: 2026, month: 1, day: 5, hour: 9, minute: 0 }, NY)!;
    const next = nextFireAfter(parseCron('0 9 * * *'), nine, NY)!;
    // Asking "what is next" while standing exactly on a fire must not
    // return the fire you are standing on, or the scheduler loops on it.
    expect(next).toBeGreaterThan(nine);
    expect(wall(next, NY)).toBe('2026-01-06 09:00');
  });

  it('6. with both day fields restricted, the match is an OR', () => {
    // Crontab semantics: the 13th OR any Friday, which is why "Friday the
    // 13th" is the one thing cron famously cannot express.
    const start = instantOfLocal({ year: 2026, month: 2, day: 1, hour: 0, minute: 0 }, NY)!;
    const spec = parseCron('0 0 13 * 5');
    const hits = firesBetween(spec, start, start + 20 * 86_400_000, NY).map((t) => wall(t, NY));
    expect(hits).toContain('2026-02-06 00:00'); // a Friday, not the 13th
    expect(hits).toContain('2026-02-13 00:00'); // the 13th, also a Friday
    expect(hits).toContain('2026-02-20 00:00'); // a Friday
  });

  it('7. a half-hour offset zone stays put all year', () => {
    // Kolkata is UTC+5:30 and has no DST: 9am local is 03:30Z in January
    // and 03:30Z in July. A scheduler that rounds to whole hours fails this.
    const jan = nextFireAfter(parseCron('0 9 * * *'), Date.UTC(2026, 0, 1), KOLKATA)!;
    const jul = nextFireAfter(parseCron('0 9 * * *'), Date.UTC(2026, 6, 1), KOLKATA)!;
    expect(new Date(jan).toISOString()).toContain('T03:30:00');
    expect(new Date(jul).toISOString()).toContain('T03:30:00');
    expect(wall(jan, KOLKATA)).toBe('2026-01-01 09:00');
  });
});

describe('daylight saving', () => {
  it('8. a fire inside the spring-forward gap does not happen that day', () => {
    // 2026-03-08, New York: 02:00 jumps to 03:00. 02:30 does not exist.
    const before = instantOfLocal({ year: 2026, month: 3, day: 7, hour: 12, minute: 0 }, NY)!;
    expect(instantOfLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toBeNull();
    // Honest behaviour: the alarm does not ring on a day its time does not
    // exist, rather than ringing at a surprise hour. The *schedule* layer
    // is what notices and reports it (`schedule.missed`); cron itself just
    // tells the truth about the clock.
    expect(at('30 2 * * *', before, NY)).toBe('2026-03-09 02:30');
  });

  it('9. a fire inside the fall-back repeat happens exactly once', () => {
    // 2026-11-01, New York: 02:00 falls back to 01:00, so 01:30 occurs
    // twice — once at 05:30Z (EDT) and once at 06:30Z (EST).
    const before = instantOfLocal({ year: 2026, month: 10, day: 31, hour: 12, minute: 0 }, NY)!;
    const first = nextFireAfter(parseCron('30 1 * * *'), before, NY)!;
    expect(wall(first, NY)).toBe('2026-11-01 01:30');
    expect(new Date(first).toISOString()).toContain('T05:30:00');

    const after = nextFireAfter(parseCron('30 1 * * *'), first, NY)!;
    // The second 01:30 is a real instant, but the next *scheduled* fire is
    // the next day: the scheduler always asks relative to the last fire,
    // so one wall-clock 01:30 produces one run.
    expect(wall(after, NY)).toBe('2026-11-02 01:30');
  });

  it('10. 9am stays 9am across both transitions, and the offset moves instead', () => {
    const spec = parseCron('0 9 * * *');
    const springEve = instantOfLocal({ year: 2026, month: 3, day: 7, hour: 12, minute: 0 }, NY)!;
    const spring = nextFireAfter(spec, springEve, NY)!;
    expect(wall(spring, NY)).toBe('2026-03-08 09:00');
    expect(new Date(spring).toISOString()).toContain('T13:00:00'); // EDT, UTC-4

    const fallEve = instantOfLocal({ year: 2026, month: 10, day: 31, hour: 12, minute: 0 }, NY)!;
    const fall = nextFireAfter(spec, fallEve, NY)!;
    expect(wall(fall, NY)).toBe('2026-11-01 09:00');
    expect(new Date(fall).toISOString()).toContain('T14:00:00'); // EST, UTC-5

    // Same question in London, whose transitions are on different dates —
    // proof that nothing here is hard-coded to one zone's calendar.
    const londonMar = nextFireAfter(spec, Date.UTC(2026, 2, 28), LONDON)!;
    const londonApr = nextFireAfter(spec, Date.UTC(2026, 3, 1), LONDON)!;
    expect(wall(londonMar, LONDON)).toBe('2026-03-28 09:00');
    expect(wall(londonApr, LONDON)).toBe('2026-04-01 09:00');
  });
});

describe('edges', () => {
  it('11. an unsatisfiable spec returns null instead of searching forever', () => {
    // 30 February. The search is bounded at a year and a bit; without the
    // bound this is an infinite loop in a background worker.
    expect(nextFireAfter(parseCron('0 0 30 2 *'), Date.UTC(2026, 0, 1), NY)).toBeNull();
  });

  it('12. a spec that fires faster than the floor is refused at validation', () => {
    expect(() => validateCron('* * * * *', NY)).toThrow(/denial of service/);
    expect(() => validateCron('*/5 * * * *', NY)).not.toThrow();
    expect(() => validateCron('0 9 * * *', 'Mars/Olympus')).toThrow(/not a timezone/);
    // The floor is a product decision, not an accident of implementation.
    expect(MIN_INTERVAL_MS).toBe(300_000);
  });
});
