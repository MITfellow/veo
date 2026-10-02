import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/substrate/clock.js';
import { UlidIds, decodeTime, fakeIds, seededRandom } from '../../src/substrate/ids.js';

describe('ULID', () => {
  it('is monotonic within a single millisecond', () => {
    const clock = new FakeClock();
    const ids = new UlidIds(clock, seededRandom(42));
    const batch = Array.from({ length: 1000 }, () => ids.ulid());
    const sorted = [...batch].sort();
    expect(batch).toEqual(sorted);
    expect(new Set(batch).size).toBe(1000);
  });

  it('sorts lexicographically in time order across milliseconds', () => {
    const clock = new FakeClock();
    const ids = new UlidIds(clock, seededRandom(7));
    const out: string[] = [];
    for (let i = 0; i < 200; i++) {
      out.push(ids.ulid());
      clock.advance(1);
    }
    expect([...out].sort()).toEqual(out);
  });

  it('is 26 Crockford characters and round-trips its timestamp', () => {
    const clock = new FakeClock('2031-06-15T04:05:06.789Z');
    const id = new UlidIds(clock, seededRandom(1)).ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(decodeTime(id)).toBe(Date.parse('2031-06-15T04:05:06.789Z'));
  });

  it('is reproducible for a given seed', () => {
    const run = (): string[] => {
      const clock = new FakeClock();
      const ids = fakeIds(clock, 99);
      return Array.from({ length: 20 }, () => {
        clock.advance(3);
        return ids.ulid();
      });
    };
    expect(run()).toEqual(run());
  });

  it('never issues an id that sorts before one already issued, even if the clock jumps back', () => {
    const clock = new FakeClock('2026-05-01T00:00:00.000Z');
    const ids = new UlidIds(clock, seededRandom(5));
    const before = ids.ulid();
    clock.set('2026-04-01T00:00:00.000Z'); // NTP step backwards
    const after = ids.ulid();
    expect(after > before).toBe(true);
  });

  it('produces url-safe tokens of the requested length', () => {
    const ids = new UlidIds(new FakeClock(), seededRandom(3));
    const token = ids.token(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });
});

describe('FakeClock', () => {
  it('advances by milliseconds, days and months', () => {
    const clock = new FakeClock('2026-01-31T12:00:00.000Z');
    clock.advanceDays(1);
    expect(new Date(clock.now()).toISOString()).toBe('2026-02-01T12:00:00.000Z');

    const jan31 = new FakeClock('2026-01-31T12:00:00.000Z');
    jan31.advanceMonths(1);
    // Clamped to the end of February rather than overflowing into March.
    expect(new Date(jan31.now()).toISOString()).toBe('2026-02-28T12:00:00.000Z');

    const feb = new FakeClock('2026-02-28T00:00:00.000Z');
    feb.advanceYears(1);
    expect(new Date(feb.now()).toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });

  it('rejects an unparseable start', () => {
    expect(() => new FakeClock('not a date')).toThrow(/unparseable/);
  });
});
