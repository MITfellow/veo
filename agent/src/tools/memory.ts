/**
 * The `memory.*` tools (§22.8, L3).
 *
 * Tool names live in `src/tools/` and nowhere else (invariant 9), which is
 * why this file exists rather than the memory layer registering itself.
 *
 * §22.8 is a list of user rights, not features: list, search, edit, pin,
 * correct, forget, export, explain. Every one of them is here, and they are
 * tools rather than an HTTP-only admin surface so the *agent* can exercise
 * them too — "forget that" in conversation should do the same thing as a
 * button, through the same gate, leaving the same audit trail.
 *
 * Two deliberate asymmetries:
 *
 * - **Reading is `safe`; forgetting is `dangerous` and irreversible.**
 *   Crypto-shredding cannot be undone, so it goes through the approval gate
 *   like any other irreversible act (§19).
 * - **Writing a memory is not a tool the model may call freely.** Memory is
 *   written by the observe pipeline after a run, from gated extraction. A
 *   model that can write directly to long-term memory is a model that can be
 *   talked into writing to long-term memory.
 */
import { z } from 'zod';
import type { Tool } from '../capability/tool.js';
import { factLine, type MemoryStore } from '../cognition/memory/store.js';
import type { MemoryReader } from '../cognition/memory/read.js';
import type { Fact } from '../cognition/memory/types.js';

export interface MemoryToolDeps {
  store: MemoryStore;
  reader: MemoryReader;
  principal: string;
}

/* ───────────────────────────── memory.recall ──────────────────────────────── */

const RecallInput = z.object({
  query: z.string().min(1).max(500).describe('What you are trying to remember about the user.'),
  limit: z.number().int().min(1).max(20).default(6),
});
const RecallOutput = z.object({
  memories: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      confidence: z.number(),
      basis: z.string(),
      recordedAt: z.number(),
      status: z.string(),
    }),
  ),
  candidates: z.number().int(),
});

export function makeMemoryRecall(deps: MemoryToolDeps): Tool<z.infer<typeof RecallInput>, z.infer<typeof RecallOutput>> {
  return {
    name: 'memory.recall',
    version: '1',
    description:
      'Searches what you know about the user: facts they have told you, preferences you have ' +
      'observed, and things you noted earlier. Use it before guessing or asking something they ' +
      'have already answered. Returns each memory with how confident you are and where it came from.',
    input: RecallInput,
    output: RecallOutput,
    capabilities: ['memory:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      const result = await deps.reader.recall({
        principal: ctx.principal,
        text: input.query,
        limit: input.limit,
        now: ctx.now(),
      });
      return {
        ok: true,
        value: {
          memories: result.items.map((item) => ({
            id: item.fact.id,
            text: factLine(item.fact),
            confidence: Number(item.fact.confidence.toFixed(2)),
            basis: item.fact.basis,
            recordedAt: item.fact.recordedAt,
            status: item.fact.status,
          })),
          candidates: result.candidates,
        },
        // Recalled memories are only as trusted as what they came from, and
        // the aggregate is only as trusted as its weakest member.
        trust: weakest(result.items.map((item) => item.fact)),
      };
    },

    renderForModel(result, budget) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.memories.length === 0) {
        return { text: 'You have no memories matching that.', truncated: false };
      }
      const lines = result.value.memories.map(
        (memory) =>
          `- ${memory.text} (${Math.round(memory.confidence * 100)}% sure, ${memory.basis.replaceAll('_', ' ')}${memory.status === 'disputed' ? ', DISPUTED' : ''})`,
      );
      const text = lines.join('\n');
      const limit = budget * 4;
      if (text.length <= limit) return { text, truncated: false };
      // Cut from the bottom: the list is already in score order, so the
      // first lines are the ones worth the budget.
      const kept: string[] = [];
      let used = 0;
      for (const line of lines) {
        if (used + line.length > limit) break;
        kept.push(line);
        used += line.length + 1;
      }
      return { text: `${kept.join('\n')}\n…more memories not shown`, truncated: true };
    },
  };
}

/* ────────────────────────────── memory.list ───────────────────────────────── */

const ListInput = z.object({
  subject: z.string().default('self').describe("Entity id, or 'self' for the user."),
  includeInactive: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
const ListOutput = z.object({
  facts: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      basis: z.string(),
      confidence: z.number(),
      status: z.string(),
      pinned: z.boolean(),
      sensitivity: z.string(),
      recordedAt: z.number(),
      sourceCount: z.number().int(),
    }),
  ),
});

export function makeMemoryList(deps: MemoryToolDeps): Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> {
  return {
    name: 'memory.list',
    version: '1',
    description:
      'Lists everything you believe about a subject, with confidence, basis and status. Use this ' +
      'when the user asks what you know about them.',
    input: ListInput,
    output: ListOutput,
    capabilities: ['memory:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input) {
      const facts = deps.store
        .bySubject(input.subject, { includeInactive: input.includeInactive })
        .slice(0, input.limit);
      return {
        ok: true,
        value: { facts: facts.map(summarise) },
        trust: weakest(facts),
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      if (result.value.facts.length === 0) {
        return { text: 'You know nothing about that subject yet.', truncated: false };
      }
      return {
        text: result.value.facts
          .map((fact) => `- ${fact.text} [${fact.status}, ${Math.round(fact.confidence * 100)}%]`)
          .join('\n'),
        truncated: false,
      };
    },
  };
}

/* ───────────────────────────── memory.explain ─────────────────────────────── */

const ExplainInput = z.object({ factId: z.string().min(1) });
const ExplainOutput = z.object({
  text: z.string(),
  basis: z.string(),
  confidence: z.number(),
  sources: z.array(z.object({ eventId: z.string(), quote: z.string().optional() })),
  history: z.array(z.object({ text: z.string(), recordedAt: z.number(), status: z.string() })),
});

export function makeMemoryExplain(deps: MemoryToolDeps): Tool<z.infer<typeof ExplainInput>, z.infer<typeof ExplainOutput>> {
  return {
    name: 'memory.explain',
    version: '1',
    description:
      'Explains why you believe something: the exact words it came from, when, how confident you ' +
      'are, and every earlier version of the belief. Use it whenever the user challenges a memory.',
    input: ExplainInput,
    output: ExplainOutput,
    capabilities: ['memory:read'],
    minTrust: 'DERIVED',
    risk: 'safe',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input) {
      const fact = deps.store.get(input.factId);
      if (fact === undefined) {
        return {
          ok: false,
          error: { kind: 'not_found', message: `No memory with id ${input.factId}.`, retryable: false },
        };
      }
      const history = deps.store.history(input.factId);
      return {
        ok: true,
        value: {
          text: factLine(fact),
          basis: fact.basis,
          confidence: fact.confidence,
          sources: fact.sources.map((source) => ({
            eventId: source.eventId,
            ...(source.quote === undefined ? {} : { quote: source.quote }),
          })),
          history: history.map((version) => ({
            text: factLine(version),
            recordedAt: version.recordedAt,
            status: version.status,
          })),
        },
        trust: fact.trust,
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const value = result.value;
      const lines = [
        `"${value.text}" — ${Math.round(value.confidence * 100)}% sure, ${value.basis.replaceAll('_', ' ')}.`,
        ...value.sources.map((source) => `  from: ${source.quote ?? source.eventId}`),
      ];
      if (value.history.length > 1) {
        lines.push(`  ${value.history.length} earlier versions of this belief are on record.`);
      }
      return { text: lines.join('\n'), truncated: false };
    },
  };
}

/* ────────────────────────── memory.pin / correct ──────────────────────────── */

const PinInput = z.object({ factId: z.string().min(1), pinned: z.boolean().default(true) });
const PinOutput = z.object({ factId: z.string(), pinned: z.boolean() });

export function makeMemoryPin(deps: MemoryToolDeps): Tool<z.infer<typeof PinInput>, z.infer<typeof PinOutput>> {
  return {
    name: 'memory.pin',
    version: '1',
    description:
      'Pins a memory so it is always in context, or unpins it. Pin what the user says is important ' +
      'about them; never pin on your own initiative without saying so.',
    input: PinInput,
    output: PinOutput,
    capabilities: ['memory:write'],
    // A pin is a privilege escalation for one fact: it buys permanent space
    // in every future prompt. USER-trust content only.
    minTrust: 'USER',
    risk: 'caution',
    effect: 'local',
    idempotent: true,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      if (deps.store.get(input.factId) === undefined) {
        return {
          ok: false,
          error: { kind: 'not_found', message: `No memory with id ${input.factId}.`, retryable: false },
        };
      }
      deps.store.pin(input.factId, input.pinned, ctx.principal, 'USER');
      return { ok: true, value: { factId: input.factId, pinned: input.pinned }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      return {
        text: result.value.pinned ? 'Pinned.' : 'Unpinned.',
        truncated: false,
      };
    },
  };
}

const CorrectInput = z.object({
  factId: z.string().min(1),
  correction: z.string().min(1).max(500).describe('What is actually true.'),
});
const CorrectOutput = z.object({ factId: z.string(), corrected: z.boolean() });

export function makeMemoryCorrect(deps: MemoryToolDeps): Tool<z.infer<typeof CorrectInput>, z.infer<typeof CorrectOutput>> {
  return {
    name: 'memory.correct',
    version: '1',
    description:
      'Records that a memory was wrong and what the truth is. The old belief stays on record as a ' +
      'mistake rather than being quietly rewritten. Use this the moment the user corrects you.',
    input: CorrectInput,
    output: CorrectOutput,
    capabilities: ['memory:write'],
    minTrust: 'USER',
    risk: 'caution',
    effect: 'local',
    idempotent: false,
    timeoutMs: 5_000,

    async execute(input, ctx) {
      const fact = deps.store.get(input.factId);
      if (fact === undefined) {
        return {
          ok: false,
          error: { kind: 'not_found', message: `No memory with id ${input.factId}.`, retryable: false },
        };
      }
      deps.store.correct({
        factId: input.factId,
        principal: ctx.principal,
        trust: 'USER',
        was: fact.object,
        now: input.correction,
        by: 'user',
      });
      // The replacement is a new belief, asserted by the user, at high
      // confidence — a correction outranks an inference (invariant 12).
      deps.store.write({
        principal: ctx.principal,
        subject: fact.subject,
        predicate: fact.predicate,
        object: input.correction,
        basis: 'asserted_by_user',
        confidence: 0.9,
        sources: fact.sources,
        trust: 'USER',
        stability: fact.stability,
        sensitivity: fact.sensitivity,
      });
      return { ok: true, value: { factId: input.factId, corrected: true }, trust: 'USER' };
    },

    renderForModel() {
      return { text: 'Corrected, and the old version is kept on record.', truncated: false };
    },
  };
}

/* ───────────────────────────── memory.forget ──────────────────────────────── */

const ForgetInput = z.object({
  factId: z.string().min(1).optional(),
  subject: z.string().min(1).optional().describe("Forget everything about this entity, e.g. 'self' or an entity id."),
  reason: z.string().min(1).max(200).default('the user asked'),
});
const ForgetOutput = z.object({ forgotten: z.array(z.string()) });

export function makeMemoryForget(deps: MemoryToolDeps): Tool<z.infer<typeof ForgetInput>, z.infer<typeof ForgetOutput>> {
  return {
    name: 'memory.forget',
    version: '1',
    description:
      'Permanently forgets a memory, or everything about one person or thing. The content is ' +
      'destroyed by shredding its key — this cannot be undone. Only the fact that something was ' +
      'forgotten remains.',
    input: ForgetInput,
    output: ForgetOutput,
    capabilities: ['memory:write'],
    minTrust: 'USER',
    // Irreversible, so it meets the approval gate like every other
    // irreversible act (§19).
    risk: 'dangerous',
    effect: 'local',
    idempotent: false,
    timeoutMs: 10_000,

    /**
     * The preview is the whole point of the approval here: shredding is
     * irreversible, so the person approving must see the exact memories
     * that are about to stop existing, in their own words, before they say
     * yes. A count would not be enough.
     */
    async dryRun(input) {
      const targets = resolveTargets(deps, input);
      if (targets.length === 0) return 'Nothing matches; nothing would be forgotten.';
      const preview = targets
        .slice(0, 10)
        .map((fact) => `  • ${factLine(fact)}`)
        .join('\n');
      const more = targets.length > 10 ? `\n  …and ${targets.length - 10} more` : '';
      return (
        `Would permanently destroy ${targets.length} ` +
        `${targets.length === 1 ? 'memory' : 'memories'}:\n${preview}${more}\n` +
        'This shreds the encryption key. It cannot be undone.'
      );
    },

    async execute(input, ctx) {
      const targets = resolveTargets(deps, input).map((fact) => fact.id);

      if (targets.length === 0) {
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: 'Nothing to forget: give a factId or a subject.',
            retryable: false,
          },
        };
      }

      for (const id of targets) {
        deps.store.forget(id, input.reason, ctx.principal, 'USER');
      }
      return { ok: true, value: { forgotten: targets }, trust: 'USER' };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      const count = result.value.forgotten.length;
      return {
        text: `Forgotten ${count} ${count === 1 ? 'memory' : 'memories'}. The content is gone for good.`,
        truncated: false,
      };
    },
  };
}

/* ───────────────────────────── memory.export ──────────────────────────────── */

const ExportInput = z.object({ subject: z.string().default('self') });
const ExportOutput = z.object({ json: z.string(), count: z.number().int() });

export function makeMemoryExport(deps: MemoryToolDeps): Tool<z.infer<typeof ExportInput>, z.infer<typeof ExportOutput>> {
  return {
    name: 'memory.export',
    version: '1',
    description:
      'Exports everything you know about a subject as readable JSON, including sources, confidence ' +
      'and the full history of every belief. For when the user wants to see all of it at once.',
    input: ExportInput,
    output: ExportOutput,
    capabilities: ['memory:read'],
    minTrust: 'USER',
    risk: 'caution',
    effect: 'pure',
    idempotent: true,
    timeoutMs: 15_000,

    async execute(input) {
      const facts = deps.store.bySubject(input.subject, { includeInactive: true });
      const payload = facts.map((fact) => ({
        ...fact,
        text: factLine(fact),
        history: deps.store.history(fact.id).map((version) => ({
          text: factLine(version),
          recordedAt: version.recordedAt,
          status: version.status,
          confidence: version.confidence,
        })),
      }));
      return {
        ok: true,
        value: { json: JSON.stringify(payload, null, 2), count: facts.length },
        trust: weakest(facts),
      };
    },

    renderForModel(result) {
      if (!result.ok) return { text: result.error.message, truncated: false };
      // The export is for the user, not the model: hand the model the count
      // and keep the 200KB out of the context window.
      return {
        text: `Exported ${result.value.count} memories as JSON. Show the user the export rather than reading it aloud.`,
        truncated: true,
      };
    },
  };
}

/* ──────────────────────────────── helpers ─────────────────────────────────── */

function resolveTargets(
  deps: MemoryToolDeps,
  input: { factId?: string | undefined; subject?: string | undefined },
): Fact[] {
  if (input.factId !== undefined) {
    const fact = deps.store.get(input.factId);
    return fact === undefined ? [] : [fact];
  }
  if (input.subject !== undefined) {
    return deps.store.bySubject(input.subject, { includeInactive: true });
  }
  return [];
}

const ORDER = ['SYSTEM', 'USER', 'DERIVED', 'TOOL', 'FOREIGN'] as const;

/** A set of memories is only as trusted as its least trusted member (§12). */
function weakest(facts: readonly Fact[]): Fact['trust'] {
  let worst: Fact['trust'] = 'USER';
  for (const fact of facts) {
    if (ORDER.indexOf(fact.trust) > ORDER.indexOf(worst)) worst = fact.trust;
  }
  return worst;
}

function summarise(fact: Fact) {
  return {
    id: fact.id,
    text: factLine(fact),
    basis: fact.basis,
    confidence: Number(fact.confidence.toFixed(2)),
    status: fact.status,
    pinned: fact.pinned,
    sensitivity: fact.sensitivity,
    recordedAt: fact.recordedAt,
    sourceCount: fact.sources.length,
  };
}

/** Everything in §22.8, in one call, for the composition root. */
export function memoryTools(deps: MemoryToolDeps): Array<Tool<never, never>> {
  return [
    makeMemoryRecall(deps),
    makeMemoryList(deps),
    makeMemoryExplain(deps),
    makeMemoryPin(deps),
    makeMemoryCorrect(deps),
    makeMemoryForget(deps),
    makeMemoryExport(deps),
  ] as unknown as Array<Tool<never, never>>;
}
