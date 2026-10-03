/**
 * The provider adapters (L1).
 *
 * A provider is an untrusted boundary: its output shape can change without
 * warning and its content may contain anything. These tests run entirely
 * offline against a scripted transport, because a test that needs the
 * internet is a test that gets skipped.
 */
import { describe, expect, it } from 'vitest';
import {
  OpenAiCompatibleProvider,
  sseEvents,
  type FetchLike,
} from '../../src/providers/openai-compatible.js';
import { OfflineProvider } from '../../src/providers/offline.js';
import type { ModelChunk, ModelRequest } from '../../src/substrate/model/types.js';

const request: ModelRequest = {
  model: 'test',
  messages: [{ role: 'user', content: 'what time is it?' }],
};

function sse(...frames: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield encoder.encode(`data: ${frame}\n\n`);
    },
  };
}

function transport(frames: string[], status = 200, body = ''): FetchLike {
  return async () => ({
    ok: status < 400,
    status,
    text: async () => body,
    body: status < 400 ? sse(...frames) : null,
  });
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const delta = (text: string): string =>
  JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });

describe('the OpenAI-compatible provider', () => {
  it('streams text deltas and a finish reason', async () => {
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: transport([
        delta('Hello'),
        delta(' there'),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
        '[DONE]',
      ]),
    });

    const chunks = await collect(provider.generate(request, new AbortController().signal));
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)).toEqual([
      'Hello',
      ' there',
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('assembles a tool call split across frames before emitting it', async () => {
    // Providers send the name in one frame and the arguments across ten
    // more. A half-parsed argument object is the worst possible thing to
    // hand a capability gate, so the call is emitted whole or not at all.
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: transport([
        JSON.stringify({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'notes.' } }] } },
          ],
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'write' } }] } }],
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"name":"a' } }] } }],
        }),
        JSON.stringify({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '","text":"b"}' } }] } }],
        }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]),
    });

    const chunks = await collect(provider.generate(request, new AbortController().signal));
    const call = chunks.find((chunk) => chunk.type === 'tool-call');
    expect(call).toEqual({ type: 'tool-call', id: 'c1', name: 'notes.write', input: { name: 'a', text: 'b' } });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' });
  });

  it('reports malformed tool arguments instead of guessing', async () => {
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: transport([
        JSON.stringify({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{oops' } }] } },
          ],
        }),
        '[DONE]',
      ]),
    });
    const chunks = await collect(provider.generate(request, new AbortController().signal));
    expect(chunks.at(-1)).toMatchObject({ type: 'error', kind: 'bad-request' });
    expect((chunks.at(-1) as { message: string }).message).toContain('{oops');
  });

  it('turns failure into data, not an exception (invariant 13)', async () => {
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.example');
      },
    });
    const chunks = await collect(provider.generate(request, new AbortController().signal));
    expect(chunks).toEqual([
      {
        type: 'error',
        kind: 'network',
        message: 'could not reach the model provider: getaddrinfo ENOTFOUND api.example',
        retryable: true,
      },
    ]);
  });

  it('maps HTTP status onto the error kinds the loop knows how to answer', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'nope', 'auth'],
      [429, 'slow down', 'rate-limit'],
      [500, 'boom', 'server'],
      [400, 'maximum context length exceeded', 'context-overflow'],
      [400, 'bad field', 'bad-request'],
    ];
    for (const [status, body, kind] of cases) {
      const provider = new OpenAiCompatibleProvider({
        model: 'test',
        fetchImpl: transport([], status, body),
      });
      const chunks = await collect(provider.generate(request, new AbortController().signal));
      expect(chunks[0]).toMatchObject({ type: 'error', kind });
      // The provider's own words survive: "max_tokens must be <= 4096" is
      // actionable and "bad request" is not.
      expect((chunks[0] as { message: string }).message).toContain(body);
    }
  });

  it('refuses a frame that is not a chat completion chunk', async () => {
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: transport([JSON.stringify({ choices: 'not an array' }), '[DONE]']),
    });
    const chunks = await collect(provider.generate(request, new AbortController().signal));
    expect(chunks[0]).toMatchObject({ type: 'error' });
    expect((chunks[0] as { message: string }).message).toContain('test');
  });

  it('strips our trust annotations from the wire', async () => {
    let sent: unknown;
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => '', body: sse('[DONE]') };
      },
    });
    await collect(
      provider.generate(
        { model: 'test', messages: [{ role: 'user', content: 'hi', trust: 'FOREIGN' }] },
        new AbortController().signal,
      ),
    );
    expect(JSON.stringify(sent)).not.toContain('FOREIGN');
  });

  it('prices usage in integer micros', async () => {
    const provider = new OpenAiCompatibleProvider({
      model: 'test',
      pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      fetchImpl: transport([
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
        '[DONE]',
      ]),
    });
    const chunks = await collect(provider.generate(request, new AbortController().signal));
    // $0.15 is 150,000 micros. Floating-point money is a bug waiting to be filed.
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ costMicros: 150_000 });
  });
});

describe('sseEvents', () => {
  it('reassembles frames split across byte boundaries', async () => {
    const encoder = new TextEncoder();
    const body = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode('data: {"a":');
        yield encoder.encode('1}\n\ndata: [DO');
        yield encoder.encode('NE]\n\n');
      },
    };
    const frames: string[] = [];
    for await (const frame of sseEvents(body)) frames.push(frame);
    expect(frames).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('the offline provider', () => {
  it('says plainly that it has no model rather than pretending', async () => {
    const provider = new OfflineProvider();
    const chunks = await collect(
      provider.generate(
        { model: 'offline', messages: [{ role: 'user', content: 'what do you think of my plan?' }] },
        new AbortController().signal,
      ) as AsyncIterable<ModelChunk>,
    );
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('');
    expect(text).toContain('running without a language model');
    expect(text).toContain('ARISH_API_KEY');
    // And it does not quietly invent an opinion.
    expect(text).not.toContain('great plan');
  });

  it('answers what it genuinely can, by calling a real tool', async () => {
    const provider = new OfflineProvider();
    const chunks = await collect(
      provider.generate(
        {
          model: 'offline',
          messages: [{ role: 'user', content: 'what time is it?' }],
          // Described the way the registry describes it. The provider is
          // given no special knowledge of this name.
          tools: [
            {
              name: 'clock.now',
              description: 'The current time and date, as the user would read it.',
              parameters: { type: 'object', properties: {} },
              risk: 'safe',
              effect: 'pure',
            },
            {
              name: 'notes.write',
              description: 'Write a note to the notebook.',
              parameters: { type: 'object', properties: {}, required: ['name', 'text'] },
              risk: 'caution',
              effect: 'local',
            },
          ],
        },
        new AbortController().signal,
      ) as AsyncIterable<ModelChunk>,
    );
    expect(chunks[0]).toMatchObject({ type: 'tool-call', name: 'clock.now' });
  });

  it('will not call a tool whose arguments it cannot invent', async () => {
    // It has no model, so it cannot fill in `name` and `text`. Offering a
    // half-filled call to the capability gate would be worse than silence.
    const chunks = await collect(
      new OfflineProvider().generate(
        {
          model: 'offline',
          messages: [{ role: 'user', content: 'write a note about the note I wrote' }],
          tools: [
            {
              name: 'notes.write',
              description: 'Write a note to the notebook.',
              parameters: { type: 'object', properties: {}, required: ['name', 'text'] },
            },
          ],
        },
        new AbortController().signal,
      ) as AsyncIterable<ModelChunk>,
    );
    expect(chunks.some((chunk) => chunk.type === 'tool-call')).toBe(false);
  });

  it('does not offer to call a tool it was not given', async () => {
    const provider = new OfflineProvider();
    const chunks = await collect(
      provider.generate(
        { model: 'offline', messages: [{ role: 'user', content: 'what time is it?' }] },
        new AbortController().signal,
      ) as AsyncIterable<ModelChunk>,
    );
    expect(chunks.some((chunk) => chunk.type === 'tool-call')).toBe(false);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      new OfflineProvider().generate(
        { model: 'offline', messages: [{ role: 'user', content: 'hello' }] },
        controller.signal,
      ) as AsyncIterable<ModelChunk>,
    );
    expect(chunks).toHaveLength(0);
  });
});
