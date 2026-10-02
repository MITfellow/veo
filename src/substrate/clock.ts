import type { Clock } from './ports.js';

export class SystemClock implements Clock {
  constructor(private readonly tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone) {}

  now(): number {
    return Date.now();
  }

  timezone(): string {
    return this.tz;
  }
}

/**
 * Time under test.
 *
 * Memory decay, consolidation and bitemporal queries are all functions of
 * elapsed time, so the suite has to be able to move a year in one call (§11).
 * Month arithmetic goes through UTC `Date` so that "advance 3 months" from
 * 31 January lands on 30 April rather than silently overflowing into May —
 * the same clamping a human expects.
 */
export class FakeClock implements Clock {
  private current: number;

  constructor(
    start: number | string = '2026-01-01T09:00:00.000Z',
    private tz: string = 'UTC',
  ) {
    this.current = typeof start === 'number' ? start : Date.parse(start);
    if (Number.isNaN(this.current)) throw new Error(`FakeClock: unparseable start ${String(start)}`);
  }

  now(): number {
    return this.current;
  }

  timezone(): string {
    return this.tz;
  }

  setTimezone(tz: string): void {
    this.tz = tz;
  }

  set(at: number | string): void {
    this.current = typeof at === 'number' ? at : Date.parse(at);
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  advanceSeconds(n: number): number {
    return this.advance(n * 1000);
  }

  advanceMinutes(n: number): number {
    return this.advance(n * 60_000);
  }

  advanceHours(n: number): number {
    return this.advance(n * 3_600_000);
  }

  advanceDays(n: number): number {
    return this.advance(n * 86_400_000);
  }

  /** Calendar months, clamped to the end of the target month. */
  advanceMonths(n: number): number {
    const d = new Date(this.current);
    const day = d.getUTCDate();
    const target = new Date(d);
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() + n);
    const daysInTarget = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    target.setUTCDate(Math.min(day, daysInTarget));
    this.current = target.getTime();
    return this.current;
  }

  advanceYears(n: number): number {
    return this.advanceMonths(n * 12);
  }
}
