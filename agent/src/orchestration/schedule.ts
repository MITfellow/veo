/**
 * `ScheduleStore` — §28's scheduler: cron + one-shot, persisted,
 * timezone-aware, DST-correct, with an explicit catch-up policy.
 *
 * The interesting half of this file is `due()`, and the interesting half of
 * `due()` is what it does about time that passed while nobody was running.
 *
 * §28 lists three catch-up policies and does not pick one. The default here
 * is **`fire-once`** (decision 034): after a three-day outage, "every
 * weekday 9am" has three missed slots, and three identical morning
 * briefings arriving at 2pm on Thursday is worse than one. Firing nothing
 * silently is also wrong, so every skipped slot emits `schedule.missed` —
 * the user can see exactly what their agent did not do.
 *
 * `fire-all` exists and is bounded by `MAX_CATCH_UP`. An unbounded fire-all
 * is a self-inflicted denial of service after any long weekend.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Ids, Storage } from '../substrate/ports.js';
import type { JobQueue } from './queue.js';
import { firesBetween, nextFireAfter, parseCron, validateCron, type CronSpec } from './cron.js';

export type CatchUpPolicy = 'fire-all' | 'fire-once' | 'skip';

/** The most fires a single catch-up will ever enqueue. */
export const MAX_CATCH_UP = 10;

/** The job kind a schedule produces. One kind, so the worker stays small. */
export const SCHEDULED_RUN = 'scheduled.run';

export interface Schedule {
  id: string;
  name: string;
  kind: 'cron' | 'once';
  spec: string;
  timezone: string;
  payload: Record<string, unknown>;
  principal: string;
  catchUp: CatchUpPolicy;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  fireCount: number;
  missedCount: number;
}

export interface CreateScheduleInput {
  name: string;
  /** A 5-field cron spec, or an ISO instant / epoch ms for a one-shot. */
  spec: string;
  timezone?: string;
  payload: Record<string, unknown>;
  catchUp?: CatchUpPolicy;
  kind?: 'cron' | 'once';
}

export interface ScheduleStoreDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
  queue: JobQueue;
}

interface ScheduleRow {
  id: string;
  name: string;
  kind: 'cron' | 'once';
  spec: string;
  timezone: string;
  payload: string;
  principal: string;
  catch_up: CatchUpPolicy;
  enabled: number;
  created_at: number;
  last_fired_at: number | null;
  next_fire_at: number | null;
  fire_count: number;
  missed_count: number;
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    spec: row.spec,
    timezone: row.timezone,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    principal: row.principal,
    catchUp: row.catch_up,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    fireCount: row.fire_count,
    missedCount: row.missed_count,
  };
}

export class ScheduleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleParseError';
  }
}

/** Resolve a one-shot's spec to an instant, or throw a readable error. */
function onceAt(spec: string): number {
  const asNumber = Number(spec);
  const ts = Number.isFinite(asNumber) && spec.trim() !== '' ? asNumber : Date.parse(spec);
  if (!Number.isFinite(ts)) {
    throw new ScheduleParseError(`'${spec}' is not an instant: use an ISO timestamp or epoch milliseconds`);
  }
  return ts;
}

export class ScheduleStore {
  constructor(private readonly deps: ScheduleStoreDeps) {}

  create(principal: string, input: CreateScheduleInput): Schedule {
    const timezone = input.timezone ?? this.deps.clock.timezone();
    const kind = input.kind ?? (input.spec.trim().split(/\s+/).length === 5 ? 'cron' : 'once');
    const now = this.deps.clock.now();

    let nextFireAt: number | null;
    if (kind === 'cron') {
      const parsed = validateCron(input.spec, timezone);
      nextFireAt = nextFireAfter(parsed, now, timezone);
    } else {
      const at = onceAt(input.spec);
      // A one-shot in the past is kept, not rejected, and fires on the next
      // tick: "do this at 9am" submitted at 9:01 is a request, not a typo.
      nextFireAt = at;
    }

    const scheduleId = this.deps.ids.ulid();
    this.deps.events.append({
      type: 'schedule.created',
      principal,
      trust: 'USER',
      payload: {
        scheduleId,
        name: input.name,
        spec: input.spec,
        timezone,
        kind,
        payload: input.payload,
        catchUp: input.catchUp ?? 'fire-once',
        nextFireAt,
      },
    });

    return this.get(scheduleId)!;
  }

  update(
    principal: string,
    scheduleId: string,
    patch: { spec?: string; timezone?: string; catchUp?: CatchUpPolicy; enabled?: boolean },
  ): Schedule | null {
    const current = this.get(scheduleId);
    if (current === null) return null;

    const spec = patch.spec ?? current.spec;
    const timezone = patch.timezone ?? current.timezone;
    const catchUp = patch.catchUp ?? current.catchUp;
    const enabled = patch.enabled ?? current.enabled;

    // Re-anchor to the new wall clock. This is the whole point of the
    // timezone-change case in §33: moving to Lisbon must keep "9am" meaning
    // the clock on the wall, not the instant it used to be.
    const nextFireAt =
      current.kind === 'cron'
        ? nextFireAfter(validateCron(spec, timezone), this.deps.clock.now(), timezone)
        : onceAt(spec);

    const changed: string[] = [];
    if (patch.spec !== undefined && patch.spec !== current.spec) changed.push('spec');
    if (patch.timezone !== undefined && patch.timezone !== current.timezone) changed.push('timezone');
    if (patch.catchUp !== undefined && patch.catchUp !== current.catchUp) changed.push('catchUp');
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) changed.push('enabled');

    this.deps.events.append({
      type: 'schedule.updated',
      principal,
      trust: 'USER',
      payload: { scheduleId, changed, spec, timezone, catchUp, enabled, nextFireAt },
    });

    return this.get(scheduleId);
  }

  delete(principal: string, scheduleId: string): boolean {
    if (this.get(scheduleId) === null) return false;
    // Pending work goes with it. A briefing enqueued five minutes ago for a
    // schedule the user has just deleted is not something they asked for.
    this.deps.queue.cancelPendingForSchedule(scheduleId);
    this.deps.events.append({
      type: 'schedule.deleted',
      principal,
      trust: 'USER',
      payload: { scheduleId },
    });
    return true;
  }

  get(scheduleId: string): Schedule | null {
    const row = this.deps.storage.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [scheduleId]);
    return row === undefined ? null : toSchedule(row);
  }

  list(principal?: string): Schedule[] {
    const rows =
      principal === undefined
        ? this.deps.storage.all<ScheduleRow>('SELECT * FROM schedules ORDER BY created_at ASC')
        : this.deps.storage.all<ScheduleRow>(
            'SELECT * FROM schedules WHERE principal = ? ORDER BY created_at ASC',
            [principal],
          );
    return rows.map(toSchedule);
  }

  /**
   * Fire everything that is due, enqueue the work, and report what was
   * skipped. Idempotent within a slot: the idempotency key is
   * `schedule:<id>:<slot>`, so ticking twice in the same minute — or twice
   * in the same second, which a busy worker will do — produces one job.
   */
  due(now = this.deps.clock.now()): { fired: number; missed: number; enqueued: string[] } {
    const enqueued: string[] = [];
    let fired = 0;
    let missed = 0;

    for (const schedule of this.list()) {
      if (!schedule.enabled) continue;
      if (schedule.nextFireAt === null || schedule.nextFireAt > now) continue;

      const slots = this.slotsDue(schedule, now);
      if (slots.length === 0) continue;

      const { run, skip } = this.applyCatchUp(schedule, slots);

      for (const slot of skip) {
        this.deps.events.append({
          type: 'schedule.missed',
          principal: schedule.principal,
          trust: 'SYSTEM',
          payload: { scheduleId: schedule.id, scheduledFor: slot, policy: schedule.catchUp },
        });
        missed += 1;
      }

      for (const slot of run) {
        const jobId = this.deps.queue.enqueue({
          kind: SCHEDULED_RUN,
          // The principal comes from the schedule row, never from the
          // payload: a payload is data and data does not get to choose
          // whose authority it runs under (§12).
          principal: schedule.principal,
          // The schedule's own fields go **last**. Found by an adversarial
          // test: with the spread first, a payload containing its own
          // `scheduleId` overwrote the real one, and a user-authored
          // schedule could point its jobs at someone else's.
          payload: { ...schedule.payload, scheduleId: schedule.id, scheduledFor: slot },
          scheduleId: schedule.id,
          idempotencyKey: `schedule:${schedule.id}:${slot}`,
          priority: 0,
        });
        enqueued.push(jobId);
        this.deps.events.append({
          type: 'schedule.fired',
          principal: schedule.principal,
          trust: 'SYSTEM',
          payload: { scheduleId: schedule.id, scheduledFor: slot },
        });
        fired += 1;
      }

      this.reschedule(schedule, Math.max(...[...run, ...skip, now]));
    }

    return { fired, missed, enqueued };
  }

  /** Every slot between the last fire (or the next due instant) and now. */
  private slotsDue(schedule: Schedule, now: number): number[] {
    if (schedule.kind === 'once') {
      return schedule.nextFireAt !== null && schedule.nextFireAt <= now ? [schedule.nextFireAt] : [];
    }

    const parsed = parseCron(schedule.spec);
    const from = schedule.lastFiredAt ?? (schedule.nextFireAt ?? now) - 1;
    const slots = firesBetween(parsed, from, now, schedule.timezone, MAX_CATCH_UP * 10);
    return slots;
  }

  private applyCatchUp(schedule: Schedule, slots: number[]): { run: number[]; skip: number[] } {
    if (slots.length <= 1) return { run: slots, skip: [] };

    switch (schedule.catchUp) {
      case 'skip':
        // Nothing runs. Everything is reported: "your agent did not do
        // these six things" is information the user is owed.
        return { run: [], skip: slots };
      case 'fire-all': {
        const run = slots.slice(-MAX_CATCH_UP);
        return { run, skip: slots.slice(0, Math.max(0, slots.length - MAX_CATCH_UP)) };
      }
      case 'fire-once':
      default: {
        const last = slots[slots.length - 1]!;
        return { run: [last], skip: slots.slice(0, -1) };
      }
    }
  }

  private reschedule(schedule: Schedule, after: number): void {
    const next =
      schedule.kind === 'once'
        ? null
        : nextFireAfter(parseCron(schedule.spec), after, schedule.timezone);

    this.deps.storage.run('UPDATE schedules SET next_fire_at = ?, enabled = ? WHERE id = ?', [
      next,
      schedule.kind === 'once' ? 0 : 1,
      schedule.id,
    ]);
  }

  /** Used by the worker's boot path and by tests that need the parsed form. */
  specOf(schedule: Schedule): CronSpec | null {
    return schedule.kind === 'cron' ? parseCron(schedule.spec) : null;
  }
}
