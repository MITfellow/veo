/**
 * `time.convert` and `time.until` — date arithmetic the agent should
 * never do in prose (S1).
 *
 * Both read `ctx.now()` rather than `Date.now()`, for the reason
 * `clock.now` exists: a tool that reads the real clock makes every
 * replay of that run produce a different answer and quietly destroys
 * §30's replay guarantee.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import { zonedToUtc } from '../cognition/calendar/store.js';

const tzOk = (timezone: string): boolean => {
  try {
    new Date(0).toLocaleString('sv-SE', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const render = (epochMs: number, timezone: string): { iso: string; weekday: string } => ({
  iso: new Date(epochMs).toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T'),
  weekday: new Date(epochMs).toLocaleDateString('en-US', { timeZone: timezone, weekday: 'long' }),
});

/* ─────────────────────────── time.convert ───────────────────────────── */

const ConvertInput = z.object({
  /** `YYYY-MM-DD HH:mm` (or with `T`). Omit to convert the current moment. */
  when: z.string().max(40).optional(),
  from: z.string().min(1).max(64).default('UTC'),
  to: z.string().min(1).max(64),
});

const ConvertOutput = z.object({
  epochMs: z.number().int(),
  from: z.object({ timezone: z.string(), iso: z.string(), weekday: z.string() }),
  to: z.object({ timezone: z.string(), iso: z.string(), weekday: z.string() }),
});

export const timeConvert: Tool<z.infer<typeof ConvertInput>, z.infer<typeof ConvertOutput>> = {
  name: 'time.convert',
  version: '1',
  description:
    'Converts a date and time from one timezone to another, handling daylight saving ' +
    'correctly. Omit "when" to convert the current moment. Use this rather than adding ' +
    'or subtracting hours yourself.',
  input: ConvertInput,
  output: ConvertOutput,
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,

  async execute(input, ctx) {
    for (const zone of [input.from, input.to]) {
      if (!tzOk(zone)) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `'${zone}' is not a timezone this system recognizes`,
            retryable: false,
            hint: 'Use an IANA name such as Asia/Kolkata or Europe/Lisbon.',
          },
        };
      }
    }

    let epochMs: number;
    if (input.when === undefined) {
      epochMs = ctx.now();
    } else {
      // Accept a bare date by assuming midnight, which is what someone
      // writing "2026-03-29" means.
      const text = input.when.trim().replace('T', ' ');
      const full = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text} 00:00:00` : text;
      try {
        epochMs = zonedToUtc(full.length === 16 ? `${full}:00` : full, input.from);
      } catch {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: `'${input.when}' is not a date and time I can read`,
            retryable: false,
            hint: 'Write it as 2026-03-29 14:30.',
          },
        };
      }
    }

    return {
      ok: true,
      value: {
        epochMs,
        from: { timezone: input.from, ...render(epochMs, input.from) },
        to: { timezone: input.to, ...render(epochMs, input.to) },
      },
      trust: 'SYSTEM',
    };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    const { from, to } = result.value;
    return {
      text:
        `${from.weekday} ${from.iso} in ${from.timezone} is ` +
        `${to.weekday} ${to.iso} in ${to.timezone}.`,
      truncated: false,
    };
  },
};

/* ──────────────────────────── time.until ────────────────────────────── */

const UntilInput = z.object({
  when: z.string().min(1).max(40),
  timezone: z.string().min(1).max(64).default('UTC'),
});

const UntilOutput = z.object({
  epochMs: z.number().int(),
  deltaMs: z.number().int(),
  past: z.boolean(),
  phrase: z.string(),
  days: z.number().int(),
  hours: z.number().int(),
  minutes: z.number().int(),
});

/** "2 days, 3 hours" — the two largest units, which is how people say it. */
function phraseOf(deltaMs: number): { phrase: string; days: number; hours: number; minutes: number } {
  const total = Math.abs(deltaMs);
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor((total % 86_400_000) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return { phrase: parts.slice(0, 2).join(', ') || 'less than a minute', days, hours, minutes };
}

export const timeUntil: Tool<z.infer<typeof UntilInput>, z.infer<typeof UntilOutput>> = {
  name: 'time.until',
  version: '1',
  description:
    'How long until (or since) a date and time. Use this rather than counting days yourself, ' +
    'which you will get wrong across month ends and daylight saving.',
  input: UntilInput,
  output: UntilOutput,
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,

  async execute(input, ctx) {
    if (!tzOk(input.timezone)) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `'${input.timezone}' is not a timezone this system recognizes`,
          retryable: false,
        },
      };
    }
    const text = input.when.trim().replace('T', ' ');
    const full = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text} 00:00:00` : text;
    let epochMs: number;
    try {
      epochMs = zonedToUtc(full.length === 16 ? `${full}:00` : full, input.timezone);
    } catch {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `'${input.when}' is not a date and time I can read`,
          retryable: false,
          hint: 'Write it as 2026-03-29 14:30.',
        },
      };
    }

    const deltaMs = epochMs - ctx.now();
    const { phrase, days, hours, minutes } = phraseOf(deltaMs);
    return {
      ok: true,
      value: { epochMs, deltaMs, past: deltaMs < 0, phrase, days, hours, minutes },
      trust: 'SYSTEM',
    };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    const { phrase, past } = result.value;
    return { text: past ? `${phrase} ago` : `in ${phrase}`, truncated: false };
  },
};
