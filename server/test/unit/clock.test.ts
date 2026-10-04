import { describe, expect, it } from 'vitest';
import { FakeClock } from '../fakes/clock.js';
import { systemClock } from '../../src/substrate/clock.js';

describe('Clock', () => {
  it('never advances on its own', () => {
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    const a = clock.now();
    for (let i = 0; i < 1000; i++) void Math.sqrt(i);
    expect(clock.now()).toBe(a);
  });

  it('advances by months with calendar-correct lengths', () => {
    // February is why this test exists: a naive +30 days lands on 2 March.
    const clock = new FakeClock('2026-01-31T00:00:00Z');
    clock.advanceMonths(1);
    expect(new Date(clock.now()).toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('advances by a year for decay tests', () => {
    const clock = new FakeClock('2026-01-01T00:00:00Z');
    clock.advanceDays(365);
    expect(new Date(clock.now()).getUTCFullYear()).toBe(2027);
  });

  it('carries a timezone that is supplied, not sniffed', () => {
    expect(systemClock('Asia/Kolkata').timeZone()).toBe('Asia/Kolkata');
  });

  it('rejects an unparseable start', () => {
    expect(() => new FakeClock('not a date')).toThrow(/unparseable/);
  });
});
