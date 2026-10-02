import { describe, expect, it } from 'vitest';
import {
  ModelProtocolError,
  accumulate,
  emptyTotals,
  parseChunk,
  FINISH_REASONS,
} from '../../src/substrate/model/types.js';
import { FakeModel, estimateTokens, finish, reply, say, usage } from '../fakes/model.js';

describe('the model port validates at the boundary', () => {
  it('accepts every legitimate chunk shape', () => {
    expect(parseChunk('p', { type: 'text-delta', text: 'hi' }).type).toBe('text-delta');
    expect(parseChunk('p', { type: 'tool-call', id: '1', name: 'f', input: {} }).type).toBe('tool-call');
    expect(parseChunk('p', { type: 'usage', inputTokens: 1, outputTokens: 2 }).type).toBe('usage');
    expect(parseChunk('p', { type: 'finish', reason: 'stop' }).type).toBe('finish');
    expect(parseChunk('p', { type: 'error', kind: 'auth', message: 'no', retryable: false }).type).toBe('error');
  });

  it('rejects an unknown chunk type, naming the provider', () => {
    expect(() => parseChunk('openai', { type: 'surprise' })).toThrow(ModelProtocolError);
    try {
      parseChunk('openai', { type: 'surprise' });
    } catch (err) {
      // At 3am "unexpected token" with no attribution costs an evening.
      expect((err as Error).message).toContain('openai');
    }
  });

  it('rejects a finish reason outside the closed set', () => {
    expect(() => parseChunk('p', { type: 'finish', reason: 'vibes' })).toThrow(ModelProtocolError);
    expect(FINISH_REASONS).toContain('content-filter');
  });

  it('rejects negative or fractional token counts', () => {
    expect(() => parseChunk('p', { type: 'usage', inputTokens: -1, outputTokens: 0 })).toThrow();
    expect(() => parseChunk('p', { type: 'usage', inputTokens: 1.5, outputTokens: 0 })).toThrow();
  });

  it('defaults cost to zero rather than undefined', () => {
    const chunk = parseChunk('p', { type: 'usage', inputTokens: 1, outputTokens: 1 });
    expect(chunk).toMatchObject({ costMicros: 0 });
  });

  it('allows an empty text delta — providers do send them', () => {
    expect(parseChunk('p', { type: 'text-delta', text: '' }).type).toBe('text-delta');
  });
});

describe('accumulating a stream', () => {
  it('concatenates text in order', () => {
    const totals = emptyTotals();
    for (const chunk of say('hello there friend')) accumulate(totals, chunk);
    expect(totals.text).toBe('hello there friend');
  });

  it('ADDS usage rather than overwriting it', () => {
    const totals = emptyTotals();
    accumulate(totals, usage(10, 20, 100));
    accumulate(totals, usage(5, 5, 50));
    // Providers differ on whether usage is reported once or incrementally.
    // Overwriting would silently halve the bill for the incremental ones.
    expect(totals.inputTokens).toBe(15);
    expect(totals.outputTokens).toBe(25);
    expect(totals.costMicros).toBe(150);
  });

  it('records the finish reason and the error separately', () => {
    const totals = emptyTotals();
    accumulate(totals, finish('length'));
    expect(totals.finishReason).toBe('length');
    expect(totals.error).toBeNull();
  });

  it('collects tool calls in order', () => {
    const totals = emptyTotals();
    accumulate(totals, { type: 'tool-call', id: 'a', name: 'f', input: { x: 1 } });
    accumulate(totals, { type: 'tool-call', id: 'b', name: 'g', input: { y: 2 } });
    expect(totals.toolCalls.map((c) => c.name)).toEqual(['f', 'g']);
  });
});

describe('FakeModel is a usable stand-in', () => {
  it('replays its script deterministically', async () => {
    const run = async (): Promise<string> => {
      const model = new FakeModel([reply('the same answer')]);
      let text = '';
      for await (const chunk of model.generate(
        { model: 'fake-1', messages: [] },
        new AbortController().signal,
      )) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return text;
    };
    expect(await run()).toBe(await run());
  });

  it('stops emitting once the signal aborts', async () => {
    const model = new FakeModel([{ chunks: [...say('one two three four five')] }]);
    const controller = new AbortController();
    let count = 0;
    for await (const _ of model.generate({ model: 'fake-1', messages: [] }, controller.signal)) {
      count++;
      if (count === 2) controller.abort();
    }
    expect(count).toBe(2);
  });

  it('fails loudly when the loop runs more steps than the test scripted', async () => {
    const model = new FakeModel([reply('only one')]);
    const signal = new AbortController().signal;
    for await (const _ of model.generate({ model: 'fake-1', messages: [] }, signal)) { /* drain */ }
    await expect(async () => {
      for await (const _ of model.generate({ model: 'fake-1', messages: [] }, signal)) { /* drain */ }
    }).rejects.toThrow(/no scripted turn/);
  });

  it('counts tokens as a pure, stable function', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(
      estimateTokens({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }),
    ).toBeGreaterThan(0);
  });

  it('records the requests it was given, for assertions', async () => {
    const model = new FakeModel([reply('ok')]);
    const request = { model: 'fake-1', messages: [{ role: 'user' as const, content: 'hi' }] };
    for await (const _ of model.generate(request, new AbortController().signal)) { /* drain */ }
    expect(model.requests[0]).toEqual(request);
    expect(model.callCount).toBe(1);
  });
});
