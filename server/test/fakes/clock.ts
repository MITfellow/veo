import type { Clock } from '../../src/substrate/ports.js';

/**
 * A clock that only moves when a test moves it.
 *
 * §17 requires advancing by **months**, because decay, bitemporal queries and
 * rule retirement are all meaningless at test-suite timescales. `advanceDays`
 * and `advanceMonths` exist so a test reads as "six months later" rather than
 * as an arithmetic puzzle.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: number | string = '2026-01-01T00:00:00.000Z', private zone = 'UTC') {
    this.current = typeof start === 'number' ? start : Date.parse(start);
    if (Number.isNaN(this.current)) throw new Error(`FakeClock: unparseable start ${String(start)}`);
  }

  now(): number { return this.current; }
  timeZone(): string { return this.zone; }

  set(ms: number | string): void {
    this.current = typeof ms === 'number' ? ms : Date.parse(ms);
  }

  advance(ms: number): number { this.current += ms; return this.current; }
  advanceSeconds(n: number): number { return this.advance(n * 1000); }
  advanceDays(n: number): number { return this.advance(n * 86_400_000); }

  /** Calendar-correct: month lengths differ, and a decay test that assumes 30 lies. */
  advanceMonths(n: number): number {
    const date = new Date(this.current);
    date.setUTCMonth(date.getUTCMonth() + n);
    this.current = date.getTime();
    return this.current;
  }
}
