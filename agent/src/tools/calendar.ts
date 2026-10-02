/**
 * `calendar.*` — the agent's own calendar (S1).
 *
 * Not a connector. There is no sync, no network call and no third-party
 * credential anywhere beneath this: the events live in the same event
 * log as everything else the agent knows, which is why they survive a
 * rebuild and show up in an export.
 *
 * The trust split is the interesting part. `add` is `caution` and
 * reachable at DERIVED — the model may put something in your calendar,
 * and that will leave a trace. `cancel` requires USER, by the same
 * reasoning as decision 035 for schedules: removing something a person
 * put there is not a thing a model should be able to decide on its own.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { CalendarEvent, CalendarStore } from '../cognition/calendar/store.js';
import { dayBounds, zonedToUtc } from '../cognition/calendar/store.js';

export interface CalendarToolDeps {
  store: CalendarStore;
}

const WHEN = z
  .string()
  .min(8)
  .max(40)
  .describe('A date, or a date and time: 2026-04-01 or 2026-04-01 14:30');

/** Accept a bare date (meaning all day) or a date and time. */
function parseWhen(when: string, timezone: string): { epochMs: number; dateOnly: boolean } {
  const text = when.trim().replace('T', ' ');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const full = dateOnly ? `${text} 00:00:00` : text.length === 16 ? `${text}:00` : text;
  return { epochMs: zonedToUtc(full, timezone), dateOnly };
}

const describe = (event: CalendarEvent): string => {
  const start = new Date(event.startsAt).toLocaleString('sv-SE', { timeZone: event.timezone });
  const day = start.slice(0, 10);
  const time = event.allDay ? 'all day' : start.slice(11, 16);
  const end = event.allDay
    ? ''
    : `–${new Date(event.endsAt).toLocaleString('sv-SE', { timeZone: event.timezone }).slice(11, 16)}`;
  return (
    `${day} ${time}${end} — ${event.title}` +
    (event.location === null || event.location === '' ? '' : ` (at ${event.location})`)
  );
};

/* ───────────────────────────── calendar.add ─────────────────────────── */

const AddInput = z.object({
  title: z.string().min(1).max(200),
  when: WHEN,
  /** Optional end. A bare date means all day; otherwise it defaults to an hour. */
  until: z.string().max(40).optional(),
  timezone: z.string().min(1).max(64).default('UTC'),
  location: z.string().max(200).optional(),
  notes: z.string().max(2_000).optional(),
});

const AddOutput = z.object({
  id: z.string(),
  title: z.string(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  allDay: z.boolean(),
  conflicts: z.array(z.object({ id: z.string(), title: z.string() })),
});

export function makeCalendarAdd(
  deps: CalendarToolDeps,
): Tool<z.infer<typeof AddInput>, z.infer<typeof AddOutput>> {
  return {
    name: 'calendar.add',
    version: '1',
    description:
      "Puts something in the user's calendar. Give a title and a date, optionally a time, " +
      'an end, a location and notes. Confirm the details with the user before guessing them.',
    input: AddInput,
    output: AddOutput,
    capabilities: ['calendar:write'],
    minTrust: 'DERIVED',
    risk: 'caution',
    effect: 'local',
    idempotent: false,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      let start: { epochMs: number; dateOnly: boolean };
      try {
        start = parseWhen(input.when, input.timezone);
      } catch {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `'${input.when}' is not a date I can read`,
            retryable: false,
            hint: 'Write it as 2026-04-01 or 2026-04-01 14:30.',
          },
        };
      }

      let endsAt: number | undefined;
      if (input.until !== undefined && input.until.trim() !== '') {
        try {
          endsAt = parseWhen(input.until, input.timezone).epochMs;
        } catch {
          return {
            ok: false,
            error: {
              kind: 'invalid_input',
              message: `'${input.until}' is not a date I can read`,
              retryable: false,
            },
          };
        }
        if (endsAt < start.epochMs) {
          return {
            ok: false,
            error: {
              kind: 'invalid_input',
              message: 'that would end before it starts',
              retryable: false,
            },
          };
        }
      }

      try {
        const event = deps.store.add(ctx.principal, {
          title: input.title,
          startsAt: start.epochMs,
          ...(endsAt === undefined ? {} : { endsAt }),
          allDay: start.dateOnly && endsAt === undefined,
          timezone: input.timezone,
          location: input.location ?? null,
          notes: input.notes ?? null,
        });

        // Reported, never enforced: double-booking is sometimes right,
        // and a calendar that refuses it is a calendar people work around.
        const conflicts = deps.store
          .conflicts(ctx.principal, event.startsAt, event.endsAt, event.id)
          .map((other) => ({ id: other.id, title: other.title }));

        return {
          ok: true,
          value: {
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            conflicts,
          },
          trust: 'USER',
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: error instanceof Error ? error.message : 'the event could not be added',
            retryable: false,
          },
        };
      }
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const clash =
        result.value.conflicts.length === 0
          ? ''
          : ` Note: it overlaps ${result.value.conflicts.map((c) => `'${c.title}'`).join(', ')}.`;
      return { text: `Added '${result.value.title}'.${clash}`, truncated: false };
    },
  };
}

/* ──────────────────────────── calendar.list ─────────────────────────── */

const ListInput = z.object({
  /** A day to look at. Omit for today. */
  date: z.string().max(40).optional(),
  /** How many days from that date. 1 is just that day. */
  days: z.number().int().min(1).max(60).default(1),
  timezone: z.string().min(1).max(64).default('UTC'),
});

const EventShape = z.object({
  id: z.string(),
  title: z.string(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  allDay: z.boolean(),
  timezone: z.string(),
  location: z.string().nullable(),
});

const ListOutput = z.object({ events: z.array(EventShape), from: z.number().int(), to: z.number().int() });

export function makeCalendarList(
  deps: CalendarToolDeps,
): Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> {
  return {
    name: 'calendar.list',
    version: '1',
    description:
      "What is in the user's calendar. Omit the date for today; use days to cover a range, " +
      'for example days=7 for the week ahead. Use this instead of assuming you know their plans.',
    input: ListInput,
    output: ListOutput,
    capabilities: ['calendar:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      let anchor: number;
      if (input.date === undefined) anchor = ctx.now();
      else {
        try {
          anchor = parseWhen(input.date, input.timezone).epochMs;
        } catch {
          return {
            ok: false,
            error: {
              kind: 'invalid_input',
              message: `'${input.date}' is not a date I can read`,
              retryable: false,
            },
          };
        }
      }

      const { from } = dayBounds(anchor, input.timezone);
      const to = from + input.days * 24 * 60 * 60 * 1000;
      const events = deps.store.list(ctx.principal, { from, to, limit: 200 });
      return {
        ok: true,
        value: {
          from,
          to,
          events: events.map((event) => ({
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            timezone: event.timezone,
            location: event.location,
          })),
        },
        trust: 'USER',
      };
    },

    renderForModel(result, budget) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.events.length === 0) {
        return { text: 'Nothing in the calendar for that period.', truncated: false };
      }
      const lines = result.value.events.map((event) =>
        describe({
          ...event,
          notes: null,
          createdAt: 0,
          cancelledAt: null,
        } as CalendarEvent),
      );
      const limit = budget * 4;
      const text = lines.join('\n');
      if (text.length <= limit) return { text, truncated: false };
      // Soonest first is already the order, so cutting the tail keeps
      // what matters most.
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length > limit) break;
        kept.push(line);
        used += line.length + 1;
      }
      return {
        text: `${kept.join('\n')}\n…and ${lines.length - kept.length} more`,
        truncated: true,
      };
    },
  };
}

/* ──────────────────────────── calendar.find ─────────────────────────── */

const FindInput = z.object({ query: z.string().min(1).max(200) });
const FindOutput = z.object({ events: z.array(EventShape) });

export function makeCalendarFind(
  deps: CalendarToolDeps,
): Tool<z.infer<typeof FindInput>, z.infer<typeof FindOutput>> {
  return {
    name: 'calendar.find',
    version: '1',
    description:
      'Searches the calendar by words in the title, location or notes — "dentist", "standup". ' +
      'Use this when the user refers to something without saying when it is.',
    input: FindInput,
    output: FindOutput,
    capabilities: ['calendar:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      const events = deps.store.find(ctx.principal, input.query);
      return {
        ok: true,
        value: {
          events: events.map((event) => ({
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            timezone: event.timezone,
            location: event.location,
          })),
        },
        trust: 'USER',
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.events.length === 0) {
        return { text: 'Nothing in the calendar matches that.', truncated: false };
      }
      return {
        text: result.value.events
          .map((event) => describe({ ...event, notes: null, createdAt: 0, cancelledAt: null } as CalendarEvent))
          .join('\n'),
        truncated: false,
      };
    },
  };
}

/* ─────────────────────────── calendar.cancel ────────────────────────── */

const CancelInput = z.object({ id: z.string().min(1).max(64) });
const CancelOutput = z.object({ id: z.string(), cancelled: z.boolean() });

export function makeCalendarCancel(
  deps: CalendarToolDeps,
): Tool<z.infer<typeof CancelInput>, z.infer<typeof CancelOutput>> {
  return {
    name: 'calendar.cancel',
    version: '1',
    description:
      'Cancels a calendar event by its id, which you get from calendar.list or calendar.find. ' +
      'Confirm with the user first — this removes something they put there.',
    input: CancelInput,
    output: CancelOutput,
    capabilities: ['calendar:write'],
    // Removing what a person put in their own calendar is not a thing a
    // model decides on its own (the reasoning of decision 035).
    minTrust: 'USER',
    risk: 'dangerous',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5_000,

    // The contract requires this of anything `dangerous`, and rightly:
    // "cancel C-01J8…" is not something a person can meaningfully approve.
    // The preview names the event and when it is.
    async dryRun(input, ctx) {
      const event = deps.store.get(ctx.principal, input.id);
      if (event === undefined) return `There is no calendar event with id '${input.id}'.`;
      return `Cancel: ${describe(event)}`;
    },

    async execute(input, ctx) {
      const cancelled = deps.store.cancel(ctx.principal, input.id);
      if (!cancelled) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: `There is no calendar event with id '${input.id}'.`,
            retryable: false,
            hint: 'Use calendar.list or calendar.find to get the id first.',
          },
        };
      }
      return { ok: true, value: { id: input.id, cancelled: true }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return { text: 'Cancelled.', truncated: false };
    },
  };
}

export function calendarTools(deps: CalendarToolDeps) {
  return [
    makeCalendarAdd(deps),
    makeCalendarList(deps),
    makeCalendarFind(deps),
    makeCalendarCancel(deps),
  ];
}
