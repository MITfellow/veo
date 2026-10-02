/**
 * `clock.now` — the pure tool (§20).
 *
 * It looks trivial and it is not: it proves that a tool reads time from the
 * **injected clock in its context** rather than `Date.now()`. A tool that
 * reads the real clock makes every replay of that run produce a different
 * answer, which quietly destroys §30's replay guarantee.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';

const Input = z.object({
  timezone: z.string().default('UTC'),
});

const Output = z.object({
  iso: z.string(),
  epochMs: z.number().int(),
  timezone: z.string(),
  weekday: z.string(),
});

export const clockNow: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
  name: 'clock.now',
  version: '1',
  description:
    'Returns the current date and time. Use this instead of guessing the date; you have no ' +
    'other reliable way to know what day it is.',
  input: Input,
  output: Output,
  capabilities: [],
  minTrust: 'FOREIGN',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 1000,

  async execute(input, ctx) {
    const epochMs = ctx.now();
    const date = new Date(epochMs);
    let iso: string;
    let weekday: string;
    try {
      iso = date.toLocaleString('sv-SE', { timeZone: input.timezone }).replace(' ', 'T');
      weekday = date.toLocaleDateString('en-US', { timeZone: input.timezone, weekday: 'long' });
    } catch {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `'${input.timezone}' is not a timezone this system recognizes`,
          retryable: false,
          hint: 'Use an IANA name such as Europe/Lisbon.',
        },
      };
    }
    return {
      ok: true,
      value: { iso, epochMs, timezone: input.timezone, weekday },
      trust: 'SYSTEM',
    };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    return {
      text: `${result.value.weekday}, ${result.value.iso} (${result.value.timezone})`,
      truncated: false,
    };
  },
};
