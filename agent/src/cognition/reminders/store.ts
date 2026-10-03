/**
 * Reminders (S3).
 *
 * Deferred twice — once in S1 and once in S2 — because both times the
 * honest answer was "this needs a scheduler, and building a second one
 * is how you get an app with two clocks". §28's scheduler exists now,
 * so a reminder is a one-shot schedule plus a link row saying what it
 * belongs to.
 *
 * The owner is the part that earns its keep. A reminder attached to a
 * task is cancelled when the task is completed or dropped — not by a
 * rule written into the task store, but by `cancelFor`, which anything
 * closing an owner calls. A reminder for a thing that no longer exists
 * is the single worst failure a reminder system has, because it trains
 * the person to ignore it.
 */
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { TrustLevel } from '../../substrate/events/types.js';
import type { ScheduleStore } from '../../orchestration/schedule.js';

export type OwnerKind = 'task' | 'event';

export interface Reminder {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string;
  scheduleId: string;
  remindAt: number;
  text: string;
  createdAt: number;
  cancelledAt: number | null;
  firedAt: number | null;
  /** S4: when the person actually looked at it, if they have. */
  seenAt: number | null;
}

export interface SetReminderInput {
  ownerKind: OwnerKind;
  ownerId: string;
  /** Epoch ms. The caller resolves "20 minutes before" into an instant. */
  remindAt: number;
  text: string;
}

interface Row {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  schedule_id: string;
  remind_at: number;
  text: string;
  created_at: number;
  cancelled_at: number | null;
  fired_at: number | null;
  seen_at: number | null;
}

const toReminder = (row: Row): Reminder => ({
  id: row.id,
  ownerKind: row.owner_kind,
  ownerId: row.owner_id,
  scheduleId: row.schedule_id,
  remindAt: row.remind_at,
  text: row.text,
  createdAt: row.created_at,
  cancelledAt: row.cancelled_at,
  firedAt: row.fired_at,
  seenAt: row.seen_at,
});

/** The job payload a fired reminder hands the worker. */
export const REMINDER_PROMPT_PREFIX = 'Reminder:';

const MAX_PENDING = 200;

export class ReminderStore {
  constructor(
    private readonly deps: {
      storage: Storage;
      events: EventLog;
      clock: Clock;
      ids: Ids;
      schedules: ScheduleStore;
    },
  ) {}

  /**
   * Set one.
   *
   * The schedule is created first and deliberately: if creating it
   * throws — a bad instant, a storage failure — no `reminder.set` is
   * appended, and the log never contains a reminder with nothing
   * behind it. The other order would leave a row that looks armed and
   * is not, which is exactly the lie this whole module exists to
   * avoid.
   */
  set(principal: string, input: SetReminderInput, trust: TrustLevel = 'USER'): Reminder {
    const text = input.text.trim();
    if (text === '') throw new Error('a reminder needs something to say');
    if (text.length > 200) throw new Error('that is too long for a reminder');
    if (!Number.isFinite(input.remindAt)) throw new Error('a reminder needs a time');

    const reminderId = `R-${this.deps.ids.ulid()}`;
    const schedule = this.deps.schedules.create(principal, {
      name: text.slice(0, 60),
      spec: String(Math.trunc(input.remindAt)),
      kind: 'once',
      // `fire-once` so a machine that was asleep through the moment
      // still says it, once, when it wakes — late is better than never
      // for a reminder, and twice is worse than both.
      catchUp: 'fire-once',
      payload: {
        prompt: `${REMINDER_PROMPT_PREFIX} ${text}`,
        reminderId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
      },
    });

    this.deps.events.append({
      type: 'reminder.set',
      principal,
      trust,
      payload: {
        reminderId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        scheduleId: schedule.id,
        remindAt: Math.trunc(input.remindAt),
        text,
      },
    });

    const stored = this.get(principal, reminderId);
    if (stored === undefined) throw new Error('the reminder did not project');
    return stored;
  }

  /** Cancel one. Deletes the schedule too, so nothing is left armed. */
  cancel(principal: string, reminderId: string, reason = 'cancelled'): boolean {
    const existing = this.get(principal, reminderId);
    if (existing === undefined) return false;
    if (existing.cancelledAt !== null || existing.firedAt !== null) return true;

    this.deps.schedules.delete(principal, existing.scheduleId);
    this.deps.events.append({
      type: 'reminder.cancelled',
      principal,
      trust: 'USER',
      payload: { reminderId, reason },
    });
    return true;
  }

  /**
   * Cancel everything hanging off an owner that has gone away.
   *
   * Called by whatever closes the owner. Returns how many were
   * cancelled, so the caller can say so.
   */
  cancelFor(principal: string, ownerKind: OwnerKind, ownerId: string, reason: string): number {
    let cancelled = 0;
    for (const reminder of this.forOwner(principal, ownerKind, ownerId)) {
      if (reminder.cancelledAt !== null || reminder.firedAt !== null) continue;
      if (this.cancel(principal, reminder.id, reason)) cancelled += 1;
    }
    return cancelled;
  }

  /** Record that it went off. Appended by the worker, not by a timer here. */
  markFired(principal: string, reminderId: string): boolean {
    const existing = this.get(principal, reminderId);
    if (existing === undefined || existing.firedAt !== null) return false;

    this.deps.events.append({
      type: 'reminder.fired',
      principal,
      trust: 'SYSTEM',
      payload: { reminderId },
    });
    return true;
  }

  /**
   * Record that the person looked at it.
   *
   * Returns false when there is nothing to mark — unknown, never
   * fired, or already seen — so a double-click does not append a
   * second event.
   */
  markSeen(principal: string, reminderId: string): boolean {
    const existing = this.get(principal, reminderId);
    if (existing === undefined) return false;
    if (existing.firedAt === null || existing.seenAt !== null) return false;

    this.deps.events.append({
      type: 'reminder.seen',
      principal,
      trust: 'USER',
      payload: { reminderId },
    });
    return true;
  }

  /**
   * What the person has been told and has not looked at. Newest first:
   * this is a notification list, and the most recent interruption is
   * the one still in their head.
   *
   * Cancelled ones are excluded. A reminder called off *after* it
   * fired is still a thing that happened — `all()` shows it — but it
   * is not something to badge someone about.
   */
  unseen(principal: string, limit = 20): Reminder[] {
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM reminders
          WHERE principal = ?
            AND fired_at IS NOT NULL
            AND seen_at IS NULL
            AND cancelled_at IS NULL
          ORDER BY fired_at DESC
          LIMIT ${Math.min(Math.max(limit, 1), MAX_PENDING)}`,
        [principal],
      )
      .map(toReminder);
  }

  get(principal: string, reminderId: string): Reminder | undefined {
    const row = this.deps.storage.get<Row>(
      'SELECT * FROM reminders WHERE id = ? AND principal = ?',
      [reminderId, principal],
    );
    return row === undefined ? undefined : toReminder(row);
  }

  forOwner(principal: string, ownerKind: OwnerKind, ownerId: string): Reminder[] {
    return this.deps.storage
      .all<Row>(
        'SELECT * FROM reminders WHERE principal = ? AND owner_kind = ? AND owner_id = ? ORDER BY remind_at ASC',
        [principal, ownerKind, ownerId],
      )
      .map(toReminder);
  }

  /** What is still coming, soonest first. */
  pending(principal: string, limit = 50): Reminder[] {
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM reminders
          WHERE principal = ? AND cancelled_at IS NULL AND fired_at IS NULL
          ORDER BY remind_at ASC
          LIMIT ${Math.min(Math.max(limit, 1), MAX_PENDING)}`,
        [principal],
      )
      .map(toReminder);
  }

  /** Everything, including what has been and gone. */
  all(principal: string, limit = 50): Reminder[] {
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM reminders WHERE principal = ? ORDER BY remind_at DESC LIMIT ${Math.min(Math.max(limit, 1), MAX_PENDING)}`,
        [principal],
      )
      .map(toReminder);
  }
}
