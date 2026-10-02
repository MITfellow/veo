/**
 * The calendar the agent owns (S1).
 *
 * Not a mirror of anyone else's calendar: no sync, no network, no
 * third-party credential. Events go into the log and come back out of a
 * projection, exactly like memory and schedules, which is what makes
 * `rebuild()` reproduce the calendar instead of emptying it.
 *
 * Every write takes the time from the injected clock and the id from the
 * injected `Ids`, so a replay of the same log produces the same calendar
 * — and so a test can run in 2031 without the assertions rotting.
 */
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { TrustLevel } from '../../substrate/events/types.js';

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  timezone: string;
  location: string | null;
  notes: string | null;
  createdAt: number;
  cancelledAt: number | null;
}

export interface AddInput {
  title: string;
  startsAt: number;
  endsAt?: number;
  allDay?: boolean;
  timezone?: string;
  location?: string | null;
  notes?: string | null;
}

export interface Window {
  from?: number;
  to?: number;
  limit?: number;
  includeCancelled?: boolean;
}

interface Row {
  id: string;
  title: string;
  starts_at: number;
  ends_at: number;
  all_day: number;
  timezone: string;
  location: string | null;
  notes: string | null;
  created_at: number;
  cancelled_at: number | null;
}

const toEvent = (row: Row): CalendarEvent => ({
  id: row.id,
  title: row.title,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  allDay: row.all_day === 1,
  timezone: row.timezone,
  location: row.location,
  notes: row.notes,
  createdAt: row.created_at,
  cancelledAt: row.cancelled_at,
});

/** A whole day in the given zone, as the instants that bound it. */
export function dayBounds(epochMs: number, timezone: string): { from: number; to: number } {
  // `sv-SE` renders as `YYYY-MM-DD HH:mm:ss`, which is the one locale
  // that is already ISO-shaped and therefore safe to slice.
  const local = new Date(epochMs).toLocaleString('sv-SE', { timeZone: timezone });
  const day = local.slice(0, 10);
  const from = zonedToUtc(`${day} 00:00:00`, timezone);
  return { from, to: from + 24 * 60 * 60 * 1000 };
}

/**
 * Turn a wall-clock string in a zone into an instant.
 *
 * There is no primitive for this in the platform, so it is done by
 * guessing UTC and correcting by the offset that guess implies — the
 * same trick the scheduler uses for cron, and correct across DST
 * because the correction is computed at the guessed instant.
 */
/**
 * Strict, because `Date.parse` is not. V8 falls back to a lenient
 * implementation-defined parser that reads `'next tuesday-ish:00Z'` as
 * 2000-01-01 rather than failing — so a date the agent could not
 * actually understand would be silently filed twenty-six years in the
 * past instead of refused. Anything that is not an ISO wall clock is
 * rejected here.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

export function zonedToUtc(wallClock: string, timezone: string): number {
  if (!WALL_CLOCK.test(wallClock.trim())) {
    throw new Error(`'${wallClock}' is not a date and time`);
  }
  const asUtc = Date.parse(`${wallClock.trim().replace(' ', 'T')}Z`);
  if (Number.isNaN(asUtc)) throw new Error(`'${wallClock}' is not a date and time`);
  const rendered = new Date(asUtc).toLocaleString('sv-SE', { timeZone: timezone });
  const offset = Date.parse(`${rendered.replace(' ', 'T')}Z`) - asUtc;
  return asUtc - offset;
}

export class CalendarStore {
  constructor(
    private readonly deps: { storage: Storage; events: EventLog; clock: Clock; ids: Ids },
  ) {}

  /**
   * Add an event. Returns it as projected, so the caller sees what was
   * actually stored rather than what it asked for.
   */
  add(principal: string, input: AddInput, trust: TrustLevel = 'USER'): CalendarEvent {
    const title = input.title.trim();
    if (title === '') throw new Error('an event needs a title');

    const timezone = input.timezone ?? 'UTC';
    // Validate the zone here rather than letting a bad one reach the
    // projection, where it would be stored and break every render.
    try {
      new Date(0).toLocaleString('sv-SE', { timeZone: timezone });
    } catch {
      throw new Error(`'${timezone}' is not a timezone this system recognizes`);
    }

    const allDay = input.allDay ?? false;
    const startsAt = input.startsAt;
    const endsAt = input.endsAt ?? (allDay ? startsAt + 24 * 60 * 60 * 1000 - 1 : startsAt + 3_600_000);
    if (endsAt < startsAt) throw new Error('an event cannot end before it starts');

    const eventId = `C-${this.deps.ids.ulid()}`;
    this.deps.events.append({
      type: 'calendar.added',
      principal,
      trust,
      payload: {
        eventId,
        title,
        startsAt,
        endsAt,
        allDay,
        timezone,
        location: input.location ?? null,
        notes: input.notes ?? null,
      },
    });

    const stored = this.get(principal, eventId);
    if (stored === undefined) throw new Error('the calendar event did not project');
    return stored;
  }

  /**
   * Cancel an event. Idempotent: cancelling something already cancelled
   * is not an error, because the caller's intent is already satisfied.
   */
  cancel(principal: string, eventId: string, trust: TrustLevel = 'USER'): boolean {
    const existing = this.get(principal, eventId);
    if (existing === undefined) return false;
    // Already cancelled: report success rather than failure. The tool is
    // declared idempotent, and "cancel the thing that is already
    // cancelled" has got the outcome the caller wanted.
    if (existing.cancelledAt !== null) return true;

    this.deps.events.append({
      type: 'calendar.cancelled',
      principal,
      trust,
      payload: { eventId },
    });
    return true;
  }

  /**
   * Scoped by principal, and not as a formality: `cancel` is built on
   * this, so an unscoped `get` would let anyone who can guess an id
   * cancel someone else's appointment. Found by the S1 tests.
   */
  get(principal: string, eventId: string): CalendarEvent | undefined {
    const row = this.deps.storage.get<Row>(
      'SELECT * FROM calendar_events WHERE id = ? AND principal = ?',
      [eventId, principal],
    );
    return row === undefined ? undefined : toEvent(row);
  }

  /** Events overlapping the window, soonest first. */
  list(principal: string, window: Window = {}): CalendarEvent[] {
    const where = ['principal = ?'];
    const params: Array<string | number> = [principal];
    if (window.includeCancelled !== true) where.push('cancelled_at IS NULL');
    // Overlap, not containment: a meeting that started before the window
    // and is still running is on today, and a reader who is told it is
    // not will walk into it.
    if (window.to !== undefined) {
      where.push('starts_at < ?');
      params.push(window.to);
    }
    if (window.from !== undefined) {
      where.push('ends_at >= ?');
      params.push(window.from);
    }
    const limit = Math.min(Math.max(window.limit ?? 100, 1), 500);
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM calendar_events WHERE ${where.join(' AND ')} ORDER BY starts_at ASC LIMIT ${limit}`,
        params,
      )
      .map(toEvent);
  }

  /** Text match over title, location and notes. */
  find(principal: string, query: string, limit = 20): CalendarEvent[] {
    const needle = `%${query.trim().toLowerCase()}%`;
    if (query.trim() === '') return [];
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM calendar_events
          WHERE principal = ? AND cancelled_at IS NULL
            AND (lower(title) LIKE ? OR lower(COALESCE(location,'')) LIKE ?
                 OR lower(COALESCE(notes,'')) LIKE ?)
          ORDER BY starts_at ASC LIMIT ?`,
        [principal, needle, needle, needle, Math.min(Math.max(limit, 1), 100)],
      )
      .map(toEvent);
  }

  /** What is on today, in the given zone. */
  today(principal: string, timezone = 'UTC'): CalendarEvent[] {
    const { from, to } = dayBounds(this.deps.clock.now(), timezone);
    return this.list(principal, { from, to });
  }

  /**
   * Events that overlap this one. Reported, never enforced: it is the
   * user's calendar and double-booking is sometimes the correct answer.
   */
  conflicts(principal: string, startsAt: number, endsAt: number, exclude?: string): CalendarEvent[] {
    return this.list(principal, { from: startsAt, to: endsAt, limit: 20 }).filter(
      (candidate) => candidate.id !== exclude,
    );
  }
}
