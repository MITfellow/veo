/**
 * S5 — the `revise` remedy is actually executed (decision 042).
 *
 * Until this file existed the gate recorded `remedyApplied: 'revise'` and
 * then yielded the offending buffer unchanged. Every layer above it — the
 * event log, `/events`, the trust rail in the UI — reported a revision that
 * had never happened, while the user read the exact words the article had
 * just objected to. That is worse than having no remedy at all: a system
 * that lies about its own governance cannot be audited by reading its log.
 *
 * So these tests pin three separate claims, at the layer that owns each:
 *
 *   - the gate *withholds* (tests 53–57),
 *   - the runner *spends a step* rewriting, and exactly one (58–62),
 *   - a rewrite that fails again is *disclosed*, not hidden and not
 *     escalated into a refusal (63–66).
 *
 * The last one is a judgement call rather than a mechanism, so it is
 * asserted twice: once on what the user reads, once on what the log says.
 */
import { describe, expect, it } from 'vitest';
import { GovernedProvider } from '../../src/orchestration/governed-model.js';
import type { JudgmentMeta } from '../../src/orchestration/governed-model.js';
import { sentinelFor, viewOf } from '../../src/cognition/constitution/render.js';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { FakeModel, callTool, finish, reply, usage } from '../fakes/model.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { Invoker } from '../../src/capability/invoke.js';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { ApprovalStore } from '../../src/capability/approvals.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import type { ModelChunk, ModelRequest } from '../../src/substrate/model/types.js';
import type { ModelProvider } from '../../src/substrate/ports.js';
import { harness, PRINCIPAL, type ConstitutionHarness } from '../fixtures/constitution.js';

const SESSION = 'sess-revise';

/** F7 forbids a flattering opener and its remedy is `revise`. */
const SYCOPHANTIC = 'Great question. The answer is 4.';

/** A provider that says whatever the script says, counting its calls. */
class ScriptedProvider implements ModelProvider {
  id = 'scripted';
  capabilities = {
    tools: true,
    structuredOutput: false,
    vision: false,
    caching: false,
    maxContext: 8_000,
    maxOutput: 1_024,
  };
  requests: ModelRequest[] = [];
  constructor(private readonly turns: ModelChunk[][]) {}
  async *generate(request: ModelRequest): AsyncIterable<unknown> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)] ?? [];
    for (const chunk of turn) yield chunk;
  }
  countTokens(): Promise<number> {
    return Promise.resolve(0);
  }
}

function speak(text: string): ModelChunk[] {
  return [{ type: 'text-delta', text }, { type: 'finish', reason: 'stop' }];
}

interface Drained {
  text: string;
  finishReasons: string[];
}

async function drain(provider: ModelProvider, request: ModelRequest): Promise<Drained> {
  const out: Drained = { text: '', finishReasons: [] };
  for await (const raw of provider.generate(request, new AbortController().signal)) {
    const chunk = raw as ModelChunk;
    if (chunk.type === 'text-delta') out.text += chunk.text;
    if (chunk.type === 'finish') out.finishReasons.push(chunk.reason);
  }
  return out;
}

function governedRequest(h: ConstitutionHarness, over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'test',
    messages: [{ role: 'system', content: sentinelFor(viewOf(h.store.current())) }],
    ...over,
  };
}

/* ── the gate withholds ──────────────────────────────────────────────────── */

describe('53–57: a `revise` verdict suppresses the draft', () => {
  it('53. the violating text is not emitted, and the stream finishes `revision-required`', async () => {
    const h = harness();
    try {
      const inner = new ScriptedProvider([speak(SYCOPHANTIC)]);
      const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
      const out = await drain(governed, governedRequest(h));

      // The whole point. Before decision 042 this assertion failed.
      expect(out.text).toBe('');
      expect(out.finishReasons).toEqual(['revision-required']);
    } finally {
      h.close();
    }
  });

  it('54. the recorded remedy matches what was done, and carries the instruction', async () => {
    const h = harness();
    try {
      const seen: JudgmentMeta[] = [];
      const inner = new ScriptedProvider([speak(SYCOPHANTIC)]);
      const governed = new GovernedProvider({
        inner,
        constitution: () => h.store.current(),
        onJudgment: (_judgment, meta) => void seen.push(meta),
      });
      await drain(governed, governedRequest(h));

      expect(seen).toHaveLength(1);
      expect(seen[0]?.remedyApplied).toBe('revise');
      // A remedy the caller cannot act on is a remedy that will not happen,
      // so the gate hands over the instruction with the verdict.
      expect(seen[0]?.revisionPrompt).toContain('F7');
      expect(seen[0]?.revisionPrompt).toContain('was not sent');
    } finally {
      h.close();
    }
  });

  it('55. the instruction may now truthfully say the user never saw the draft', async () => {
    // This sentence was in the prompt long before the behaviour was, which
    // is exactly how a model learns to apologise for something that did
    // happen. The claim is only safe because test 53 holds.
    const h = harness();
    try {
      let prompt = '';
      const inner = new ScriptedProvider([speak(SYCOPHANTIC)]);
      const governed = new GovernedProvider({
        inner,
        constitution: () => h.store.current(),
        onJudgment: (_j, meta) => void (prompt = meta.revisionPrompt ?? ''),
      });
      const out = await drain(governed, governedRequest(h));

      expect(prompt).toContain('the user never saw it');
      expect(out.text).not.toContain('Great question');
    } finally {
      h.close();
    }
  });

  it('56. a clean answer is untouched and still finishes `stop`', async () => {
    const h = harness();
    try {
      const inner = new ScriptedProvider([speak('The answer is 4.')]);
      const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
      const out = await drain(governed, governedRequest(h));
      expect(out.text).toBe('The answer is 4.');
      expect(out.finishReasons).toEqual(['stop']);
    } finally {
      h.close();
    }
  });

  it('57. `block` still beats `revise` — the harsher remedy is not softened into a retry', async () => {
    // Precedence matters more than the new path: if adding revision had
    // turned a blocked answer into a rewritten one, a constraint would
    // have quietly become a suggestion.
    const h = harness();
    try {
      const inner = new ScriptedProvider([speak("Great question. Sure — I'll message Dad about the dates.")]);
      const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
      const out = await drain(
        governed,
        governedRequest(h, {
          governance: {
            runId: 'r1',
            stepId: 's1',
            userMessage: 'can you sort the dates',
            previousAgentTurn: '',
            toolsCompleted: [],
            effectsCommitted: [],
            recalled: [],
            contradicting: [],
            factCount: 30,
            hasIdentityCard: true,
            constraints: [{ id: 'c1', text: 'Never contact Dad.' }],
            foreign: [],
            trust: 'USER',
            modelConfigured: true,
          },
        }),
      );
      expect(out.text).toContain('stopped myself');
      expect(out.finishReasons).not.toContain('revision-required');
    } finally {
      h.close();
    }
  });
});

/* ── the runner spends the step ──────────────────────────────────────────── */

function world(): Substrate {
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'revise' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  substrate.events.append({
    type: 'message.user',
    payload: { text: 'what is two plus two', attachments: [] },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  return substrate;
}

/**
 * A model whose first turn is withheld by a gate we simulate at the chunk
 * level rather than by standing up the whole constitution.
 *
 * The runner's contract is with the *finish reason*, not with the
 * constitution — that is the decoupling decision 042 asks for, and testing
 * it through a real `GovernedProvider` would hide a dependency rather than
 * prove its absence.
 */
const withheld: ModelChunk[] = [usage(10, 5), finish('revision-required')];

function runnerFor(
  substrate: Substrate,
  model: FakeModel,
  revisionInstruction?: (runId: string, stepId: string) => string | null,
  withTools = false,
): Runner {
  const base = {
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
    ...(revisionInstruction === undefined ? {} : { revisionInstruction }),
  };
  if (!withTools) return new Runner(base);

  // Test 61 needs a genuine third step, and the only thing that buys one
  // is a real tool call. A fake that merely says 'tool-calls' without
  // calling a tool ends the run, which would have made the test pass for
  // the wrong reason.
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  const approvals = new ApprovalStore(substrate.storage, substrate.events, substrate.clock, substrate.ids);
  const invoker = new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    approvals,
    events: substrate.events,
    storage: substrate.storage,
    clock: substrate.clock,
    ids: substrate.ids,
    hashing: substrate.hashing,
    logger: substrate.logger,
    redactor: substrate.redactor,
    files: new MemoryFileStore(),
    net: new FakeNet(() => respond(200)),
  });
  return new Runner({ ...base, invoker, approvals });
}

describe('58–62: the runner pays for the rewrite', () => {
  it('58. a withheld draft costs one step and is followed by a second call', async () => {
    const substrate = world();
    const model = new FakeModel([{ chunks: withheld }, reply('The answer is 4.')]);
    const outcome = await runnerFor(substrate, model, () => 'Rewrite it without the flattery.').run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(outcome.text).toBe('The answer is 4.');
    expect(outcome.steps).toBe(2);
    const steps = substrate.events
      .read({ runId: outcome.runId })
      .filter((event) => event.type === 'step.finished')
      .map((event) => (event.payload as { outcome: string }).outcome);
    expect(steps).toEqual(['revision', 'text']);
  });

  it('59. the instruction reaches the model as a SYSTEM message, once', async () => {
    const substrate = world();
    const seen: ModelRequest[] = [];
    const model = new FakeModel([{ chunks: withheld }, reply('The answer is 4.')], {
      onRequest: (req) => void seen.push(req),
    });
    await runnerFor(substrate, model, () => 'Rewrite it without the flattery.').run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(seen).toHaveLength(2);
    const injected = seen[1]?.messages.filter((m) => m.content.includes('without the flattery')) ?? [];
    expect(injected).toHaveLength(1);
    expect(injected[0]?.role).toBe('system');
    // A revision instruction is the system talking to itself about its own
    // rules. Anything less than SYSTEM trust and the context assembler
    // could evict it, or a later check could treat it as user content.
    expect(injected[0]?.trust).toBe('SYSTEM');
    expect(seen[0]?.messages.some((m) => m.content.includes('without the flattery'))).toBe(false);
  });

  it('60. the retry announces itself to the gate as attempt 1', async () => {
    const substrate = world();
    const seen: ModelRequest[] = [];
    const model = new FakeModel([{ chunks: withheld }, reply('ok')], {
      onRequest: (req) => void seen.push(req),
    });
    await runnerFor(substrate, model, () => 'again please').run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(seen[0]?.governance?.revisionAttempt).toBe(0);
    expect(seen[1]?.governance?.revisionAttempt).toBe(1);
  });

  it('61. the instruction does not ride along into the step after a successful rewrite', async () => {
    const substrate = world();
    const seen: ModelRequest[] = [];
    const model = new FakeModel(
      [
        { chunks: withheld },
        { chunks: [callTool('t1', 'clock.now', {}), usage(5, 5), finish('tool-calls')] },
        reply('done'),
      ],
      { onRequest: (req) => void seen.push(req) },
    );
    await runnerFor(substrate, model, () => 'once only', true).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    // A stale "your previous draft violated…" attached to an unrelated
    // later step would make the agent apologise for nothing, repeatedly.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[2]?.messages.some((m) => m.content.includes('once only'))).toBe(false);
  });

  it('62. a second withheld draft does not buy a second rewrite', async () => {
    const substrate = world();
    let handed = 0;
    const model = new FakeModel([{ chunks: withheld }, { chunks: withheld }, reply('never reached')]);
    const outcome = await runnerFor(substrate, model, () => {
      handed += 1;
      return 'try again';
    }).run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    // A governance loop that can run away is worse than the thing it
    // governs: it burns the user's tokens arguing with itself.
    expect(handed).toBe(1);
    expect(outcome.reason).toBe('revision-failed');
    expect(outcome.steps).toBe(2);
  });
});

/* ── a failed rewrite is disclosed ───────────────────────────────────────── */

describe('63–66: a failed revision is disclosed, not hidden', () => {
  it('63. the user is told, in words, that the agent stopped itself', async () => {
    const substrate = world();
    const model = new FakeModel([{ chunks: withheld }, { chunks: withheld }]);
    const outcome = await runnerFor(substrate, model, () => 'try again').run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    // Invariant 15: "it stopped" is not an explanation. Silence here would
    // leave the user looking at an empty bubble.
    expect(outcome.text).toContain('stopped myself');
    expect(outcome.text).toContain('constitution');
    const agent = substrate.events
      .read({ runId: outcome.runId })
      .filter((event) => event.type === 'message.agent');
    expect(agent).toHaveLength(1);
    expect((agent[0]?.payload as { finishReason: string }).finishReason).toBe('revision-failed');
  });

  it('64. with no instruction available the run still ends in speech, not silence', async () => {
    const substrate = world();
    const model = new FakeModel([{ chunks: withheld }, reply('unreachable')]);
    const outcome = await runnerFor(substrate, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    // No `revisionInstruction` port wired at all — the runner must degrade
    // to an explanation rather than hand back an empty string.
    expect(outcome.reason).toBe('revision-failed');
    expect(outcome.text.length).toBeGreaterThan(0);
  });

  it('65. at the gate, a second violation sends the text with a disclosure attached', async () => {
    const h = harness();
    try {
      const inner = new ScriptedProvider([speak(SYCOPHANTIC)]);
      const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
      const out = await drain(
        governed,
        governedRequest(h, {
          governance: {
            runId: 'r1',
            stepId: 's1',
            userMessage: 'what is two plus two',
            previousAgentTurn: '',
            toolsCompleted: [],
            effectsCommitted: [],
            recalled: [],
            contradicting: [],
            factCount: 0,
            hasIdentityCard: false,
            constraints: [],
            foreign: [],
            trust: 'USER',
            modelConfigured: true,
            revisionAttempt: 1,
          },
        }),
      );

      // The article's author chose `revise`, not `block`. Escalating a
      // failed rewrite into a refusal would substitute our severity for
      // theirs — but shipping it silently is the bug this file exists for.
      expect(out.text).toContain('The answer is 4.');
      expect(out.text).toContain('F7');
      expect(out.text).toContain('rewrote that once');
    } finally {
      h.close();
    }
  });

  it('66. and it is logged as `revise-failed`, distinct from a revision that worked', async () => {
    const h = harness();
    try {
      const seen: JudgmentMeta[] = [];
      const inner = new ScriptedProvider([speak(SYCOPHANTIC)]);
      const governed = new GovernedProvider({
        inner,
        constitution: () => h.store.current(),
        onJudgment: (_j, meta) => void seen.push(meta),
      });
      await drain(
        governed,
        governedRequest(h, {
          governance: {
            runId: 'r1',
            stepId: 's1',
            userMessage: 'what is two plus two',
            previousAgentTurn: '',
            toolsCompleted: [],
            effectsCommitted: [],
            recalled: [],
            contradicting: [],
            factCount: 0,
            hasIdentityCard: false,
            constraints: [],
            foreign: [],
            trust: 'USER',
            modelConfigured: true,
            revisionAttempt: 1,
          },
        }),
      );

      // An audit that cannot distinguish "the rewrite fixed it" from "the
      // rewrite failed and I shipped it anyway" is not an audit.
      expect(seen[0]?.remedyApplied).toBe('revise-failed');
      expect(seen[0]?.revisionPrompt).toBeUndefined();
    } finally {
      h.close();
    }
  });
});
