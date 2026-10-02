/**
 * `conversation.search` — the agent can finally read its own past (S2).
 *
 * Before this, everything older than the context window was in the log
 * and unreachable. `history.expand` reopens compacted blocks inside one
 * run; `memory.recall` returns *conclusions*. Neither answers "what did
 * I actually say about the Lisbon trip three weeks ago", which is the
 * most ordinary question a person asks an agent they talk to daily.
 *
 * This is a recall path, so §22's rules bind it: FOREIGN content is
 * never returned, and the result is labelled with the trust of its
 * weakest member rather than its strongest (see `trustOf`).
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import { trustOf, type MessageSearch } from '../cognition/search/messages.js';

export interface SearchToolDeps {
  search: MessageSearch;
}

const Input = z.object({
  query: z.string().min(1).max(200).describe('Words to look for, e.g. "lisbon hotel".'),
  /** Omit to search everything the agent has been told. */
  sessionId: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(25).default(10),
});

const Output = z.object({
  hits: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      role: z.string(),
      text: z.string(),
      ts: z.number().int(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
  total: z.number().int(),
});

export function makeConversationSearch(
  deps: SearchToolDeps,
): Tool<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    name: 'conversation.search',
    version: '1',
    description:
      'Searches everything the user has said to you and everything you have said back, ' +
      'including conversations far older than what you can currently see. Use this whenever ' +
      'they refer to something from before — "what did we decide about X", "you said Y" — ' +
      'instead of guessing or saying you do not remember.',
    input: Input,
    output: Output,
    capabilities: ['memory:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5000,

    async execute(input) {
      const query = input.query.trim();
      if (query === '') {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'a search needs something to search for',
            retryable: false,
          },
        };
      }

      const hits = deps.search.search(query, {
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        limit: input.limit,
      });

      return {
        ok: true,
        value: {
          total: hits.length,
          hits: hits.map((hit) => ({
            id: hit.id,
            sessionId: hit.sessionId,
            role: hit.role,
            text: hit.text,
            ts: hit.ts,
            before: hit.before === null ? null : `${hit.before.role}: ${hit.before.text}`,
            after: hit.after === null ? null : `${hit.after.role}: ${hit.after.text}`,
          })),
        },
        // Never more trusted than the weakest thing in the result.
        trust: trustOf(hits),
      };
    },

    renderForModel(result, budget) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.total === 0) {
        return { text: 'Nothing in our conversations matches that.', truncated: false };
      }

      const limit = budget * 4;
      const blocks: string[] = [];
      let used = 0;
      for (const hit of result.value.hits) {
        const when = new Date(hit.ts).toLocaleDateString('en-CA');
        // The hit plus its neighbour: a matching line on its own is
        // often unreadable out of context, and the next turn is
        // usually the answer to it.
        const block =
          `[${when}] ${hit.role}: ${hit.text}` +
          (hit.after === null ? '' : `\n  → ${hit.after}`);
        if (used + block.length > limit) {
          return {
            text: `${blocks.join('\n\n')}\n\n…and ${result.value.total - blocks.length} more`,
            truncated: true,
          };
        }
        blocks.push(block);
        used += block.length + 2;
      }
      return { text: blocks.join('\n\n'), truncated: false };
    },
  };
}
