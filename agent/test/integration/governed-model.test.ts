/**
 * Tests 41–48: the gate (§25).
 *
 * This file is the milestone's load-bearing test. If `GovernedProvider` can
 * be bypassed, the constitution is decoration — so the first thing asserted
 * is that there is no bypass, and the third is that the rule holds for
 * *every* provider the repo ships rather than for the one convenient to
 * test with.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GovernedProvider, assertGoverned } from '../../src/orchestration/governed-model.js';
import { sentinelFor, viewOf } from '../../src/cognition/constitution/render.js';
import { UngovernedModelCallError } from '../../src/cognition/constitution/types.js';
import type { Judgment } from '../../src/cognition/constitution/enforce.js';
import type { JudgmentMeta } from '../../src/orchestration/governed-model.js';
import { OfflineProvider } from '../../src/providers/offline.js';
import { OpenAiCompatibleProvider } from '../../src/providers/openai-compatible.js';
import type { ModelChunk, ModelRequest } from '../../src/substrate/model/types.js';
import type { ModelProvider } from '../../src/substrate/ports.js';
import { PRINCIPAL, harness, userArticle, type ConstitutionHarness } from '../fixtures/constitution.js';

let h: ConstitutionHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

/** A provider that says exactly what the test tells it to. */
class ScriptedProvider implements ModelProvider {
  id = 'scripted';
  capabilities = { tools: true, structuredOutput: false, vision: false, caching: false, maxContext: 8_000, maxOutput: 1_024 };
  calls = 0;
  constructor(private readonly chunks: ModelChunk[]) {}
  async *generate(): AsyncIterable<unknown> {
    this.calls += 1;
    for (const chunk of this.chunks) yield chunk;
  }
  countTokens(): Promise<number> {
    return Promise.resolve(0);
  }
}

function say(text: string): ModelChunk[] {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: 'stop' },
  ];
}

function governedRequest(over: Partial<ModelRequest> = {}): ModelRequest {
  const sentinel = sentinelFor(viewOf(h.store.current()));
  return {
    model: 'test',
    messages: [{ role: 'system', content: `${sentinel}\n- (F1, my charter) …` }],
    ...over,
  };
}

async function drain(provider: ModelProvider, request: ModelRequest): Promise<string> {
  let text = '';
  for await (const raw of provider.generate(request, new AbortController().signal)) {
    const chunk = raw as ModelChunk;
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return text;
}

describe('pre-flight: no constitution, no model call', () => {
  it('41. a request without the sentinel is refused before anything streams', async () => {
    const inner = new ScriptedProvider(say('hello'));
    const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });

    await expect(
      drain(governed, { model: 'test', messages: [{ role: 'system', content: 'be nice' }] }),
    ).rejects.toThrow(UngovernedModelCallError);
    // Nothing reached the provider: the refusal is before the call, not
    // after the damage.
    expect(inner.calls).toBe(0);
  });

  it('42. a stale sentinel is refused and the message names both versions', () => {
    const before = viewOf(h.store.current());
    h.store.adopt(PRINCIPAL, { ...userArticle('Be blunt.'), id: 'U-1' });
    const now = viewOf(h.store.current());

    try {
      assertGoverned('scripted', { model: 't', messages: [{ role: 'system', content: sentinelFor(before) }] }, now);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UngovernedModelCallError);
      expect((error as Error).message).toContain(`v${before.version}`);
      expect((error as Error).message).toContain(`v${now.version}`);
      expect((error as Error).message).toContain('reassemble');
    }
  });

  it('43. every provider this repo ships goes through the same gate', async () => {
    // Table-driven on purpose: adding a provider and forgetting to wrap it
    // fails here rather than in production.
    const providers: ModelProvider[] = [
      new OfflineProvider(),
      new OpenAiCompatibleProvider({ apiKey: 'test', model: 'x' }),
      new ScriptedProvider(say('hi')),
    ];
    for (const inner of providers) {
      const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
      await expect(
        drain(governed, { model: 'test', messages: [{ role: 'user', content: 'hello' }] }),
      ).rejects.toThrow(UngovernedModelCallError);
    }
  });

  it('61. the model echoing a sentinel in its own output does not satisfy the gate', () => {
    const view = viewOf(h.store.current());
    // The model sees a real sentinel every turn, so it can reproduce one.
    // Only system messages are scanned, and only the assembler writes those.
    expect(() =>
      assertGoverned(
        'scripted',
        { model: 't', messages: [{ role: 'assistant', content: sentinelFor(view) }] },
        view,
      ),
    ).toThrow(UngovernedModelCallError);
  });
});

describe('post-flight: judge, then remedy', () => {
  it('44. a blocking article buffers the stream; without one, deltas pass straight through', async () => {
    // The distinction has to be observable, not assumed: a buffered stream
    // emits nothing to the caller until the provider has finished, while a
    // passthrough stream hands over the first delta while the provider is
    // still talking. So the test records what the provider had emitted at
    // the moment the caller received its first chunk.
    class Tracked implements ModelProvider {
      id = 'tracked';
      capabilities = { tools: true, structuredOutput: false, vision: false, caching: false, maxContext: 8_000, maxOutput: 1_024 };
      emitted: string[] = [];
      async *generate(): AsyncIterable<unknown> {
        for (const text of ['one ', 'two ', 'three']) {
          this.emitted.push(text.trim());
          yield { type: 'text-delta', text } satisfies ModelChunk;
        }
        yield { type: 'finish', reason: 'stop' } satisfies ModelChunk;
      }
      countTokens(): Promise<number> {
        return Promise.resolve(0);
      }
    }

    const measure = async (store: ConstitutionHarness['store']): Promise<number> => {
      const inner = new Tracked();
      const governed = new GovernedProvider({ inner, constitution: () => store.current() });
      const sentinel = sentinelFor(viewOf(store.current()));
      let emittedWhenFirstReceived = -1;
      for await (const raw of governed.generate(
        { model: 'test', messages: [{ role: 'system', content: sentinel }] },
        new AbortController().signal,
      )) {
        if ((raw as ModelChunk).type === 'text-delta' && emittedWhenFirstReceived === -1) {
          emittedWhenFirstReceived = inner.emitted.length;
        }
      }
      return emittedWhenFirstReceived;
    };

    // The founding charter has F7 (`revise`) and F12 (`block`): you cannot
    // un-say a streamed sentence, so an article that can stop one costs the
    // stream. The cost is real and is recorded on the event.
    expect(await measure(h.store)).toBe(3);

    const advisoryOnly = harness({ founding: false });
    try {
      advisoryOnly.store.adopt(PRINCIPAL, { ...userArticle('Be brief.'), id: 'A1' });
      expect(await measure(advisoryOnly.store)).toBe(1);
    } finally {
      advisoryOnly.close();
    }
  });

  it('45. annotate appends the note and leaves the model text intact', async () => {
    const bare = harness({ founding: false });
    try {
      bare.store.adopt(PRINCIPAL, {
        id: 'A1',
        text: 'Do not open with flattery.',
        origin: 'user',
        kind: 'style',
        enforcement: 'checked',
        check: 'no-sycophantic-opener',
        remedy: 'annotate',
        subject: 'tone',
        stance: 'forbid',
        cites: 'test',
      });
      const inner = new ScriptedProvider(say('Great question. The answer is 4.'));
      const governed = new GovernedProvider({ inner, constitution: () => bare.store.current() });
      const sentinel = sentinelFor(viewOf(bare.store.current()));
      const text = await drain(governed, {
        model: 'test',
        messages: [{ role: 'system', content: sentinel }],
      });
      expect(text).toContain('Great question. The answer is 4.');
      expect(text).toContain('I broke my own rules');
      expect(text).toContain('A1');
    } finally {
      bare.close();
    }
  });

  it('46. block replaces the answer and names the article', async () => {
    const inner = new ScriptedProvider(say("Sure — I'll message Dad about the dates."));
    const governed = new GovernedProvider({ inner, constitution: () => h.store.current() });
    const text = await drain(
      governed,
      governedRequest({
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
    expect(text).not.toContain("I'll message Dad");
    expect(text).toContain('F12');
    expect(text).toContain('stopped myself');
  });

  it('47. one enforcement event per response, carrying every verdict including the unverifiable ones', async () => {
    const seen: { judgment: Judgment; meta: JudgmentMeta }[] = [];
    const inner = new ScriptedProvider(say('The lease ends in March.'));
    const governed = new GovernedProvider({
      inner,
      constitution: () => h.store.current(),
      onJudgment: (judgment, meta) => seen.push({ judgment, meta }),
    });
    await drain(governed, governedRequest());

    expect(seen).toHaveLength(1);
    const checked = h.store.current().live.filter((a) => a.enforcement === 'checked');
    expect(seen[0]!.judgment.verdicts).toHaveLength(checked.length);
    // "Could not tell" is reported, not folded into "fine".
    expect(seen[0]!.judgment.verdicts.some((v) => v.verdict === 'unverifiable')).toBe(true);
    expect(seen[0]!.meta.buffered).toBe(true);
  });

  it('48. a cancelled or failed stream is never judged', async () => {
    const seen: unknown[] = [];
    const failing = new ScriptedProvider([
      { type: 'text-delta', text: 'I have emailed Sam.' },
      { type: 'error', kind: 'network', message: 'socket died', retryable: true },
    ]);
    const governed = new GovernedProvider({
      inner: failing,
      constitution: () => h.store.current(),
      onJudgment: (j) => seen.push(j),
    });
    await drain(governed, governedRequest());
    // Judging a truncated answer manufactures violations out of a dropped
    // socket, and the §24 metrics would then be measuring the network.
    expect(seen).toHaveLength(0);

    const controller = new AbortController();
    const cancelled = new ScriptedProvider(say('I have emailed Sam.'));
    const governed2 = new GovernedProvider({
      inner: cancelled,
      constitution: () => h.store.current(),
      onJudgment: (j) => seen.push(j),
    });
    controller.abort();
    for await (const _ of governed2.generate(governedRequest(), controller.signal)) {
      // drain
    }
    expect(seen).toHaveLength(0);
  });
});
