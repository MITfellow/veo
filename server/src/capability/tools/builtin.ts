import { z } from 'zod';
import type { FileStore } from '../../substrate/files.js';
import type { MemoryStore } from '../memory/store.js';
import type { ItemStore } from '../memory/items.js';
import { recall } from '../memory/recall.js';
import type { AnyTool, ToolContract, ToolOutcome } from './contract.js';

/**
 * The built-in tools.
 *
 * Small, real and offline. Each one is a genuine capability of this build,
 * not a placeholder — §61 says a subsystem is finished or not started, and
 * that applies to a tool as much as to a milestone.
 *
 * The one apparent exception, `http.fetch`, is deliberate and is the most
 * honest thing in the file: it exists to prove the contract and to refuse
 * with `no_transport`. §2 ships no network call, and a tool that pretended
 * otherwise would be the one lie that actually matters.
 */

export interface BuiltinDeps {
  memory: MemoryStore;
  items: ItemStore;
  files: FileStore;
  /** Roots `file.read` may read within. Anything else is refused. */
  fileRoots: readonly string[];
}

const ok = <O>(output: O, summary: string): ToolOutcome<O> => ({ ok: true, output, summary });
const no = (code: string, message: string): ToolOutcome<never> => ({ ok: false, code, message });

/**
 * A tool reached with `dryRun` set is a routing bug, not a dry run.
 *
 * The executor answers a dry run from `preview` and never calls `run`, so
 * this branch is unreachable on the only path there is. It refuses rather
 * than returning a cheerful fake success, because the day it *is* reached
 * is the day something invoked a tool around the executor — and that is
 * worth an alarm, not a tidy-looking result.
 */
const misrouted = (name: string): ToolOutcome<never> =>
  no('dry_run_misrouted', `${name} was called with dryRun set; a dry run is answered by preview(), never by run().`);

// ───────────────────────────────────────────────────────────────── time.now

const timeNow: ToolContract<Record<string, never>, { iso: string; epochMs: number }> = {
  name: 'time.now',
  summary: 'The current time, from the injected clock rather than the wall clock.',
  input: z.object({}).strict(),
  output: z.object({ iso: z.string(), epochMs: z.number() }).strict(),
  sensitivity: 'none',
  effect: 'pure',
  tier: 'observe',
  capabilities: [],
  idempotent: true,
  preview: (_input, ctx) => `read the clock (currently ${new Date(ctx.now).toISOString()})`,
  run: (_input, ctx) =>
    Promise.resolve(ok({ iso: new Date(ctx.now).toISOString(), epochMs: ctx.now }, new Date(ctx.now).toISOString())),
};

// ─────────────────────────────────────────────────────────── memory.recall

function memoryRecall(deps: BuiltinDeps): ToolContract<
  { query: string; limit?: number | undefined },
  { facts: Array<{ id: string; subject: string; predicate: string; object: string; trust: string }> }
> {
  return {
    name: 'memory.recall',
    summary: 'Look up what is remembered about something, ranked and explained.',
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }).strict(),
    output: z.object({
      facts: z.array(z.object({
        id: z.string(), subject: z.string(), predicate: z.string(), object: z.string(), trust: z.string(),
      }).strict()),
    }).strict(),
    sensitivity: 'reads-private',
    effect: 'pure',
    tier: 'observe',
    capabilities: ['memory:read'],
    idempotent: true,
    preview: (input) => `look up what is remembered about '${input.query}'`,
    run: (input, ctx) => {
      const hits = recall(deps.memory, ctx.now, {
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        runId: ctx.runId,
        record: !ctx.dryRun,
      });
      return Promise.resolve(ok(
        { facts: hits.map((h) => ({
          id: h.fact.id, subject: h.fact.subject, predicate: h.fact.predicate,
          object: h.fact.object, trust: h.fact.trust,
        })) },
        `${hits.length} fact(s)`,
      ));
    },
  };
}

// ─────────────────────────────────────────────────────────── memory.assert

function memoryAssert(deps: BuiltinDeps): ToolContract<
  { subject: string; predicate: string; object: string; confidence?: number | undefined },
  { factId: string }
> {
  return {
    name: 'memory.assert',
    summary: 'Remember something stated plainly, with the source trust it deserves.',
    input: z.object({
      subject: z.string().min(1),
      predicate: z.string().min(1),
      object: z.string().min(1).max(200),
      confidence: z.number().min(0).max(1).optional(),
    }).strict(),
    output: z.object({ factId: z.string() }).strict(),
    sensitivity: 'writes-private',
    // 'local' and not 'external': it changes this machine's state, which is
    // recoverable from the log, not the world's, which is not.
    effect: 'local',
    tier: 'interact',
    capabilities: ['memory:write'],
    idempotent: false,
    preview: (input) => `remember that ${input.subject} ${input.predicate} = ${input.object}`,
    run: (input, ctx) => {
      if (ctx.dryRun) return Promise.resolve(misrouted('memory.assert'));
      const factId = deps.memory.assert({
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        basis: `tool memory.assert in run ${ctx.runId}`,
        confidence: input.confidence ?? 0.8,
        stability: 'slow',
        // The tool's output trust is the *input's* trust, never better.
        // A tool cannot launder FOREIGN content into a USER fact by
        // passing it through a function with a confident name (§20).
        sourceTrust: ctx.inputTrust,
        runId: ctx.runId,
      });
      return Promise.resolve(ok({ factId }, `remembered as ${factId.slice(-8)}`));
    },
  };
}

// ───────────────────────────────────────────────────────────── note.write

function noteWrite(deps: BuiltinDeps): ToolContract<{ label: string; body: string }, { itemId: string }> {
  return {
    name: 'note.write',
    summary: 'Save a note, sealed under its own key so it can later be forgotten.',
    input: z.object({ label: z.string().min(1).max(120), body: z.string().min(1) }).strict(),
    output: z.object({ itemId: z.string() }).strict(),
    sensitivity: 'writes-private',
    effect: 'local',
    tier: 'interact',
    capabilities: ['memory:write'],
    idempotent: false,
    preview: (input) => `save a ${input.body.length}-character note labelled '${input.label}'`,
    run: async (input, ctx) => {
      if (ctx.dryRun) return misrouted('note.write');
      try {
        const itemId = await deps.items.put('note', input.label, input.body, ctx.inputTrust);
        return ok({ itemId }, `saved as ${itemId.slice(-8)}`);
      } catch (error) {
        // A locked vault is a *state*, not a crash. Saying so lets the
        // caller ask the user to unlock instead of reporting a failure
        // they cannot act on.
        const message = error instanceof Error ? error.message : String(error);
        return /locked/i.test(message)
          ? no('vault_locked', 'The vault is locked, so a note cannot be sealed. Unlock it and try again.')
          : no('write_failed', message);
      }
    },
  };
}

// ───────────────────────────────────────────────────────────── file.read

function fileRead(deps: BuiltinDeps): ToolContract<{ path: string }, { bytes: number; text: string }> {
  return {
    name: 'file.read',
    summary: 'Read a text file from a folder you have allowed. Nothing is uploaded.',
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ bytes: z.number().int(), text: z.string() }).strict(),
    // What it reads is FOREIGN, but reading it is not an access to *your*
    // private data — the quarantine, not the triple, is what handles the
    // content.
    sensitivity: 'none',
    effect: 'pure',
    tier: 'observe',
    capabilities: [],
    idempotent: true,
    preview: (input) => `read '${input.path}' from inside the allowed folders`,
    run: (input) => {
      for (const root of deps.fileRoots) {
        const bytes = deps.files.readWithin(root, input.path);
        if (bytes !== undefined) {
          const text = new TextDecoder().decode(bytes);
          return Promise.resolve(ok({ bytes: bytes.byteLength, text }, `${bytes.byteLength} bytes`));
        }
      }
      // Missing and escaped are one answer on purpose: the difference is
      // itself information about the filesystem.
      return Promise.resolve(no('not_readable', `No readable file at '${input.path}' inside the allowed folders.`));
    },
  };
}

// ───────────────────────────────────────────────────────────── http.fetch

const httpFetch: ToolContract<
  { url: string; method?: 'GET' | 'POST' | undefined; body?: string | undefined },
  { status: number; body: string }
> = {
  name: 'http.fetch',
  summary: 'Make an HTTP request. Declared and contract-tested; this build has no transport.',
  input: z.object({
    url: z.string().min(1),
    method: z.enum(['GET', 'POST']).optional(),
    body: z.string().optional(),
  }).strict(),
  output: z.object({ status: z.number().int(), body: z.string() }).strict(),
  sensitivity: 'none',
  effect: 'external',
  tier: 'effect',
  capabilities: ['effect:external', 'egress:new-host'],
  idempotent: false,
  // There is no undo for a request that left the machine. Saying so is the
  // contract; pretending a compensating request exists would be worse.
  irreversible: true,
  preview: (input) => `${input.method ?? 'GET'} ${originOf(input.url)} (${(input.body ?? '').length} bytes of body)`,
  run: (input) =>
    Promise.resolve(no(
      'no_transport',
      `This build ships no network transport (§2), so ${input.method ?? 'GET'} ${originOf(input.url)} cannot be sent. ` +
        'The contract, the policy path and the audit trail for this call are real and were all exercised; only the bytes are missing.',
    )),
};

/** Origin only. A query string is where the interesting secrets live. */
function originOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(url);
  return match?.[1] ?? '(unparseable url)';
}

export function builtinTools(deps: BuiltinDeps): AnyTool[] {
  return [
    timeNow,
    memoryRecall(deps),
    memoryAssert(deps),
    noteWrite(deps),
    fileRead(deps),
    httpFetch,
  ] as unknown as AnyTool[];
}
