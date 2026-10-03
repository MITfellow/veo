/**
 * Reminder tools (S3).
 *
 * `reminders.set` takes an owner and an instant. It deliberately does
 * *not* take "20 minutes before" — relative offsets need the owner's
 * own time, and resolving that is the caller's job precisely so this
 * tool cannot silently attach a reminder to the wrong moment.
 *
 * Setting one is reversible and visible, so the agent may do it.
 * Cancelling one is removing something the person asked for, which by
 * decision 035 is theirs — the same line as `calendar.cancel` and
 * `tasks.drop`, drawn for the fourth time.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { Reminder, ReminderStore } from '../cognition/reminders/store.js';
import type { TaskStore } from '../cognition/tasks/store.js';
import type { CalendarStore } from '../cognition/calendar/store.js';
import { zonedToUtc } from '../cognition/calendar/store.js';

export interface ReminderToolDeps {
  store: ReminderStore;
  tasks?: TaskStore;
  calendar?: CalendarStore;
}

const ReminderShape = z.object({
  id: z.string(),
  text: z.string(),
  remindAt: z.number().int(),
  ownerKind: z.enum(['task', 'event']),
  ownerId: z.string(),
  state: z.enum(['pending', 'fired', 'cancelled']),
});

const stateOf = (r: Reminder): 'pending' | 'fired' | 'cancelled' =>
  r.cancelledAt !== null ? 'cancelled' : r.firedAt !== null ? 'fired' : 'pending';

const view = (r: Reminder) => ({
  id: r.id,
  text: r.text,
  remindAt: r.remindAt,
  ownerKind: r.ownerKind,
  ownerId: r.ownerId,
  state: stateOf(r),
});

/** A bare date, or a date and time, read in the given zone. */
function parseWhen(when: string, timezone: string): number {
  const text = when.trim().replace('T', ' ');
  const full = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text} 09:00:00`
    : text.length === 16
      ? `${text}:00`
      : text;
  return zonedToUtc(full, timezone);
}

/* ──────────────────────────── reminders.set ─────────────────────────── */

const SetInput = z.object({
  /** What to say. Written as the person will read it, not as a label. */
  text: z.string().min(1).max(200),
  /** 'YYYY-MM-DD' (09:00 that day) or 'YYYY-MM-DD HH:MM'. */
  when: z.string().min(8).max(40),
  /** The task or calendar event this is about. */
  ownerKind: z.enum(['task', 'event']),
  ownerId: z.string().min(1).max(64),
  timezone: z.string().min(1).max(64).default('UTC'),
});

export function makeRemindersSet(
  deps: ReminderToolDeps,
): Tool<z.infer<typeof SetInput>, z.infer<typeof ReminderShape>> {
  return {
    name: 'reminders.set',
    version: '1',
    description:
      'Sets a reminder about a task or a calendar event, at a date and time. The reminder ' +
      'speaks up on its own when the moment arrives. Get the owner id from tasks.list or ' +
      'calendar.list first; a reminder about nothing is worse than no reminder.',
    input: SetInput,
    output: ReminderShape,
    capabilities: ['reminder:set'],
    // Reversible and visible, so DERIVED is enough. The capability is
    // `reminder:set` rather than `schedule:create` because decision
    // 035 took the latter away from DERIVED, and for a good reason
    // that does not apply here: a reminder is a fixed sentence at a
    // fixed instant about something the person already wrote down,
    // with no freedom in it. See decision 041.
    minTrust: 'DERIVED',
    risk: 'caution',
    effect: 'local',
    idempotent: false,
    timeoutMs: 5000,

    async execute(input, ctx) {
      const owner = ownerTitle(deps, ctx.principal, input.ownerKind, input.ownerId);
      if (owner === undefined) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: `There is no ${input.ownerKind} with id '${input.ownerId}'.`,
            retryable: false,
            hint: 'Call tasks.list or calendar.list to get the id first.',
          },
        };
      }

      let remindAt: number;
      try {
        remindAt = parseWhen(input.when, input.timezone);
      } catch {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `I could not read '${input.when}' as a date and time.`,
            retryable: false,
            hint: "Use 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'.",
          },
        };
      }
      if (!Number.isFinite(remindAt)) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `I could not read '${input.when}' as a date and time.`,
            retryable: false,
            hint: "Use 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM'.",
          },
        };
      }

      const reminder = deps.store.set(ctx.principal, {
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        remindAt,
        text: input.text,
      });
      return { ok: true, value: view(reminder), trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const when = new Date(result.value.remindAt).toISOString().slice(0, 16).replace('T', ' ');
      return { text: `Reminder set for ${when} UTC: ${result.value.text}`, truncated: false };
    },
  };
}

/* ─────────────────────────── reminders.list ─────────────────────────── */

const ListInput = z.object({
  includeDone: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(20),
});
const ListOutput = z.object({ reminders: z.array(ReminderShape) });

export function makeRemindersList(
  deps: ReminderToolDeps,
): Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> {
  return {
    name: 'reminders.list',
    version: '1',
    description:
      'Lists the reminders that have not gone off yet, soonest first. Set includeDone to ' +
      'see the ones already fired or cancelled.',
    input: ListInput,
    output: ListOutput,
    capabilities: ['reminder:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5000,

    async execute(input, ctx) {
      const found = input.includeDone
        ? deps.store.all(ctx.principal, input.limit)
        : deps.store.pending(ctx.principal, input.limit);
      return { ok: true, value: { reminders: found.map(view) }, trust: 'USER' };
    },

    renderForModel(result, budget) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.reminders.length === 0) {
        return { text: 'No reminders set.', truncated: false };
      }
      const lines: string[] = [];
      let truncated = false;
      for (const reminder of result.value.reminders) {
        const when = new Date(reminder.remindAt).toISOString().slice(0, 16).replace('T', ' ');
        const line = `- ${when} UTC: ${reminder.text}${
          reminder.state === 'pending' ? '' : ` (${reminder.state})`
        }`;
        if (lines.join('\n').length + line.length > budget * 4) {
          truncated = true;
          break;
        }
        lines.push(line);
      }
      return { text: lines.join('\n'), truncated };
    },
  };
}

/* ────────────────────────── reminders.cancel ────────────────────────── */

const CancelInput = z.object({ id: z.string().min(1).max(64) });
const CancelOutput = z.object({ id: z.string(), cancelled: z.boolean() });

export function makeRemindersCancel(
  deps: ReminderToolDeps,
): Tool<z.infer<typeof CancelInput>, z.infer<typeof CancelOutput>> {
  return {
    name: 'reminders.cancel',
    version: '1',
    description:
      'Calls off a reminder, by the id from reminders.list. Confirm with the user first — ' +
      'they asked to be told about this, and silently not telling them is the one failure ' +
      'a reminder must never have.',
    input: CancelInput,
    output: CancelOutput,
    capabilities: ['reminder:set'],
    // Decision 035 again: the agent may set one, the person calls one off.
    minTrust: 'USER',
    risk: 'dangerous',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5000,

    async dryRun(input, ctx) {
      const reminder = deps.store.get(ctx.principal, input.id);
      if (reminder === undefined) return `There is no reminder with id '${input.id}'.`;
      const when = new Date(reminder.remindAt).toISOString().slice(0, 16).replace('T', ' ');
      return `Call off the reminder for ${when} UTC: ${reminder.text}`;
    },

    async execute(input, ctx) {
      const cancelled = deps.store.cancel(ctx.principal, input.id, 'cancelled by request');
      if (!cancelled) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: `There is no reminder with id '${input.id}'.`,
            retryable: false,
            hint: 'Call reminders.list to get the id first.',
          },
        };
      }
      return { ok: true, value: { id: input.id, cancelled: true }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: 'Reminder called off.', truncated: false };
    },
  };
}

/**
 * Does the owner exist? Returns its title, or undefined.
 *
 * A reminder pointing at a deleted task is the failure that teaches
 * someone to ignore reminders, so the owner is checked at the door
 * rather than at firing time.
 */
function ownerTitle(
  deps: ReminderToolDeps,
  principal: string,
  kind: 'task' | 'event',
  id: string,
): string | undefined {
  if (kind === 'task') return deps.tasks?.get(principal, id)?.title;
  return deps.calendar?.get(principal, id)?.title;
}

export function makeReminderTools(deps: ReminderToolDeps): Array<Tool<never, never>> {
  return [
    makeRemindersSet(deps),
    makeRemindersList(deps),
    makeRemindersCancel(deps),
  ] as unknown as Array<Tool<never, never>>;
}
