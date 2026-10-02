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
