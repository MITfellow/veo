/**
 * `notes.read` / `notes.write` — the local tools (§20).
 *
 * They exist to prove the **scoped FileStore**: a tool reads and writes
 * inside its own sandbox and has no way to express a path outside it. The
 * scoping lives in the invoker, not here, which is exactly the point — a tool
 * cannot opt out of a restriction it does not implement.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';

const NAME = z
  .string()
  .min(1)
  .max(128)
  // Not the sandbox check — that is the invoker's job — but a tool should
  // reject nonsense at its own boundary rather than pass it along.
  .regex(/^[\w .-]+$/, 'a note name may contain letters, numbers, spaces, dots and dashes');

const ReadInput = z.object({ name: NAME });
const ReadOutput = z.object({ name: z.string(), content: z.string(), bytes: z.number().int() });

export const notesRead: Tool<z.infer<typeof ReadInput>, z.infer<typeof ReadOutput>> = {
  name: 'notes.read',
  version: '1',
  description: 'Reads a note you previously saved with notes.write. Returns its full text.',
  input: ReadInput,
  output: ReadOutput,
  capabilities: ['fs:read'],
  minTrust: 'DERIVED',
  risk: 'safe',
  effect: 'local',
  idempotent: true,
  timeoutMs: 5000,

  async execute(input, ctx) {
    const bytes = await ctx.files.read(input.name);
    if (bytes === undefined) {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `There is no note called '${input.name}'.`,
          retryable: false,
          hint: 'Use notes.write to create it first.',
        },
      };
    }
    const content = new TextDecoder().decode(bytes);
    return {
      ok: true,
      value: { name: input.name, content, bytes: bytes.byteLength },
      trust: 'USER',
    };
  },

  renderForModel(result, budget) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    const limit = budget * 4; // budget is tokens; roughly 4 chars each
    const content = result.value.content;
    if (content.length <= limit) {
      return { text: `note '${result.value.name}':\n${content}`, truncated: false };
    }
    // The TOOL decides what to cut. For a note the beginning is what the
    // user wrote first and usually what matters.
    return {
      text:
        `note '${result.value.name}' (${result.value.bytes} bytes, showing the first ${limit}):\n` +
        `${content.slice(0, limit)}\n…[truncated]`,
      truncated: true,
    };
  },
};

const WriteInput = z.object({
  name: NAME,
  content: z.string().max(1_000_000),
});
const WriteOutput = z.object({ name: z.string(), bytes: z.number().int() });

export const notesWrite: Tool<z.infer<typeof WriteInput>, z.infer<typeof WriteOutput>> = {
  name: 'notes.write',
  version: '1',
  description:
    'Saves a note under a name, replacing any previous note with that name. Use this to keep ' +
    'something you will need in a later conversation.',
  input: WriteInput,
  output: WriteOutput,
  capabilities: ['fs:write:sandbox'],
  minTrust: 'DERIVED',
  risk: 'caution',
  effect: 'local',
  idempotent: true,
  timeoutMs: 5000,

  async execute(input, ctx) {
    const bytes = new TextEncoder().encode(input.content);
    await ctx.files.write(input.name, bytes);
    return { ok: true, value: { name: input.name, bytes: bytes.byteLength }, trust: 'USER' };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    return {
      text: `Saved note '${result.value.name}' (${result.value.bytes} bytes).`,
      truncated: false,
    };
  },
};

/* ──────────────────── discovery: list and search ─────────────────────── */

/**
 * `notes.read` and `notes.write` shipped in M2 with no way to find out
 * what a note is called. A store you can only read by guessing the key
 * is a store nobody can use — and the model, which has no memory of
 * writing the note three sessions ago, is exactly the caller that
 * cannot guess.
 */

const ListInput = z.object({ prefix: z.string().max(128).default('') });
const ListOutput = z.object({ names: z.array(z.string()), total: z.number().int() });

export const notesList: Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> = {
  name: 'notes.list',
  version: '1',
  description:
    'Lists the names of saved notes, optionally filtered by a prefix. Use this before ' +
    'notes.read when you do not already know the exact name.',
  input: ListInput,
  output: ListOutput,
  capabilities: ['fs:read'],
  minTrust: 'DERIVED',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 5000,

  async execute(input, ctx) {
    const names = await ctx.files.list(input.prefix);
    return { ok: true, value: { names, total: names.length }, trust: 'USER' };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    if (result.value.total === 0) return { text: 'There are no saved notes.', truncated: false };
    return { text: `notes: ${result.value.names.join(', ')}`, truncated: false };
  },
};

const SearchInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(10),
});
const SearchOutput = z.object({
  hits: z.array(z.object({ name: z.string(), snippet: z.string() })),
});

/** Enough context to recognise the hit, not enough to blow the budget. */
const SNIPPET_RADIUS = 80;

export const notesSearch: Tool<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>> = {
  name: 'notes.search',
  version: '1',
  description:
    'Searches the text inside saved notes and returns the matching names with a snippet ' +
    'around each hit. Use this when you remember what a note said but not what it was called.',
  input: SearchInput,
  output: SearchOutput,
  capabilities: ['fs:read'],
  minTrust: 'DERIVED',
  risk: 'safe',
  effect: 'pure',
  idempotent: true,
  timeoutMs: 10_000,

  async execute(input, ctx) {
    const needle = input.query.toLowerCase();
    const hits: Array<{ name: string; snippet: string }> = [];

    for (const name of await ctx.files.list('')) {
      if (hits.length >= input.limit) break;
      const bytes = await ctx.files.read(name);
      if (bytes === undefined) continue;
      const content = new TextDecoder().decode(bytes);
      const at = content.toLowerCase().indexOf(needle);
      if (at === -1) continue;

      // The snippet is cut around the hit rather than from the top: the
      // top of a long note usually says nothing about why it matched.
      const from = Math.max(0, at - SNIPPET_RADIUS);
      const to = Math.min(content.length, at + needle.length + SNIPPET_RADIUS);
      hits.push({
        name,
        snippet:
          (from > 0 ? '…' : '') +
          content.slice(from, to).replace(/\s+/g, ' ').trim() +
          (to < content.length ? '…' : ''),
      });
    }

    return { ok: true, value: { hits }, trust: 'USER' };
  },

  renderForModel(result) {
    if (!result.ok) return { text: result.error.message, truncated: false };
    if (result.value.hits.length === 0) return { text: 'No note matches that.', truncated: false };
    return {
      text: result.value.hits.map((hit) => `${hit.name}: ${hit.snippet}`).join('\n'),
      truncated: false,
    };
  },
};
