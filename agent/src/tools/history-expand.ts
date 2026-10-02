/**
 * `history.expand` — read back the turns a summary stands in for (§23).
 *
 * This is the tool that makes compaction honest. A summary is a *view*: the
 * originals are still in the log, and the span pointers rendered in the
 * compacted-history block are a handle the model can pull. Without this
 * tool, compaction is indistinguishable from forgetting — the model would
 * have no way to check whether its summary of March is what March said.
 *
 * It reads the log and nothing else, so it needs no capability beyond
 * `history:read` and no trust above FOREIGN... except that it does: the
 * turns it returns are the user's own words, so the floor is DERIVED. A
 * FOREIGN step asking to dump the conversation history is exfiltration with
 * extra steps.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import type { Compactor } from '../cognition/compaction.js';

const Input = z.object({
  fromEventId: z.string().min(1),
  toEventId: z.string().min(1),
});

const Output = z.object({
  turns: z.array(
    z.object({
      eventId: z.string(),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      at: z.number().int(),
    }),
  ),
  truncatedAt: z.number().int().nonnegative().nullable(),
});

/** Hard cap: expanding "everything" is how a context budget dies. */
export const MAX_EXPANDED_TURNS = 40;

export function makeHistoryExpand(
  compactor: Compactor,
  sessionOf: (runId: string) => string | null,
): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: 'history.expand',
    version: '1',
    description:
      'Reads the original, verbatim turns behind a summarized span of this ' +
      'conversation. Give it the two event ids shown in a summary line.',
    input: Input,
    output: Output,
    capabilities: ['memory:read'],
    // The user's own words. A FOREIGN step does not get to page through them.
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      const sessionId = sessionOf(ctx.runId);
      if (sessionId === null) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message: 'This run is not attached to a session, so it has no history to expand.',
            retryable: false,
          },
        };
      }

      const all = compactor.expand(sessionId, input.fromEventId, input.toEventId);
      if (all.length === 0) {
        return {
          ok: false,
          error: {
            kind: 'not_found',
            message:
              `No turns found between ${input.fromEventId} and ${input.toEventId}. Use the ` +
              `exact event ids from a summary line in your context.`,
            retryable: false,
            hint: 'The ids are shown as [from..to] at the start of each summary.',
          },
        };
      }

      const turns = all.slice(0, MAX_EXPANDED_TURNS);
      return {
        ok: true,
        value: {
          turns,
          truncatedAt: all.length > MAX_EXPANDED_TURNS ? MAX_EXPANDED_TURNS : null,
        },
        // The turns carry whatever trust they had when they were spoken, and
        // the lowest of those governs — expanding history must not launder a
        // FOREIGN turn back into the conversation at DERIVED.
        trust: 'DERIVED',
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const lines = result.value.turns.map(
        (turn) => `${turn.role}: ${turn.text}`,
      );
      if (result.value.truncatedAt !== null) {
        lines.push(
          `(stopped after ${MAX_EXPANDED_TURNS} turns — ask for a narrower span if you need more)`,
        );
      }
      return { text: lines.join('\n'), truncated: result.value.truncatedAt !== null };
    },
  };
}
