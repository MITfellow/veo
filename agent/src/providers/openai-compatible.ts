/**
 * An OpenAI-compatible streaming provider (L1 adapter).
 *
 * "Compatible" rather than "OpenAI" deliberately: the same wire format is
 * spoken by Groq, Together, Fireworks, OpenRouter, vLLM, llama.cpp's server
 * and Ollama. One adapter, one `baseUrl`, and the person who owns this agent
 * for ten years is never locked to a vendor who changes their mind about
 * pricing.
 *
 * Three rules this file exists to keep:
 *
 * 1. **The provider is an untrusted boundary.** Every chunk is validated with
 *    zod before it enters the system (§6), and a malformed one is reported as
 *    a `ModelProtocolError` naming the provider — "unexpected token" with no
 *    attribution at 3am is how you lose an evening.
 * 2. **Failure is data** (invariant 13). A stream that produced 400 good
 *    tokens and then died emits an `error` chunk and keeps the 400. It does
 *    not throw them away.
 * 3. **No globals.** `fetch` arrives as a port, so the suite tests this
 *    adapter offline against a scripted transport rather than the internet.
 */
import { z } from 'zod';
import type { ModelCapabilities, ModelProvider } from '../substrate/ports.js';
import {
  parseChunk,
  type ModelChunk,
  type ModelErrorKind,
  type ModelRequest,
} from '../substrate/model/types.js';

/** The slice of `fetch` this adapter uses, as a port (§8). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}>;

export interface OpenAiCompatibleOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: FetchLike;
  capabilities?: Partial<ModelCapabilities>;
  /** Dollars per million tokens, for the cost ledger. 0 for local models. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}

/* ───────────────────────── the wire format, as zod ──────────────────────── */

const Delta = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({ name: z.string().optional(), arguments: z.string().optional() }),
      }),
    )
    .optional(),
});

const StreamChunk = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative().default(0),
        delta: Delta.default({}),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .nullish(),
});

const FINISH: Record<string, ModelChunk extends never ? never : string> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool-calls',
  function_call: 'tool-calls',
  content_filter: 'content-filter',
};

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.id = options.model;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.capabilities = {
      tools: true,
      structuredOutput: true,
      vision: false,
      caching: false,
      maxContext: 128_000,
      maxOutput: 4_096,
      ...options.capabilities,
    };
  }

  async *generate(request: unknown, signal: AbortSignal): AsyncIterable<ModelChunk> {
    const req = request as ModelRequest;
    let response: Awaited<ReturnType<FetchLike>>;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${this.options.apiKey}` }),
        },
        body: JSON.stringify(this.toWire(req)),
        signal,
      });
    } catch (error) {
      // A DNS failure is not an exception the run loop should unwind on; it
      // is a fact about the world, and the loop decides what to do with it.
      yield networkError(error);
      return;
    }

    if (!response.ok) {
      yield await httpError(response);
      return;
    }
    if (response.body === null) {
      yield { type: 'error', kind: 'server', message: 'the provider returned no body', retryable: true };
      return;
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let usage: { input: number; output: number } | null = null;

    for await (const event of sseEvents(response.body)) {
      if (event === '[DONE]') break;

      let parsed: z.infer<typeof StreamChunk>;
      try {
        parsed = StreamChunk.parse(JSON.parse(event));
      } catch {
        // One malformed frame does not poison the stream, but it is never
        // silently dropped either.
        yield {
          type: 'error',
          kind: 'unknown',
          message: `${this.id} sent a frame that is not a chat completion chunk`,
          retryable: false,
        };
        return;
      }

      if (parsed.usage != null) {
        usage = { input: parsed.usage.prompt_tokens, output: parsed.usage.completion_tokens };
      }

      for (const choice of parsed.choices) {
        const text = choice.delta.content;
        if (typeof text === 'string' && text.length > 0) {
          yield parseChunk(this.id, { type: 'text-delta', text });
        }

        for (const call of choice.delta.tool_calls ?? []) {
          // Tool calls arrive in fragments: the name in one frame, the
          // arguments spread across ten more. They are assembled here and
          // emitted whole, because a half-parsed argument object is the
          // worst possible thing to hand a capability gate.
          const slot = pending.get(call.index) ?? { id: '', name: '', args: '' };
          if (call.id !== undefined) slot.id = call.id;
          if (call.function.name !== undefined) slot.name += call.function.name;
          if (call.function.arguments !== undefined) slot.args += call.function.arguments;
          pending.set(call.index, slot);
        }

        if (choice.finish_reason != null) finish = choice.finish_reason;
      }
    }

    for (const [, call] of [...pending].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      if (call.args.trim() !== '') {
        try {
          input = JSON.parse(call.args);
        } catch {
          yield {
            type: 'error',
            kind: 'bad-request',
            message: `${this.id} produced tool arguments that are not valid JSON: ${call.args.slice(0, 200)}`,
            retryable: false,
          };
          return;
        }
      }
      yield parseChunk(this.id, { type: 'tool-call', id: call.id === '' ? `call-${call.name}` : call.id, name: call.name, input });
    }

    if (usage !== null) {
      yield parseChunk(this.id, {
          type: 'usage',
          inputTokens: usage.input,
          outputTokens: usage.output,
          costMicros: this.costMicros(usage.input, usage.output),
        });
    }

    yield parseChunk(this.id, { type: 'finish', reason: FINISH[finish ?? 'stop'] ?? 'stop' });
  }

  async countTokens(input: unknown): Promise<number> {
    // Characters ÷ 4, the same estimate the assembler budgets with
    // (decision 014). Asking the provider would cost a round trip per step
    // to refine a number that is only used to decide what to drop.
    const text =
      typeof input === 'string'
        ? input
        : ((input as ModelRequest).messages ?? []).map((message) => message.content).join('\n');
    return Math.ceil(text.length / 4);
  }

  private costMicros(inputTokens: number, outputTokens: number): number {
    const pricing = this.options.pricing;
    if (pricing === undefined) return 0;
    const dollars =
      (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000;
    return Math.round(dollars * 1_000_000);
  }

  private toWire(request: ModelRequest): unknown {
    return {
      model: this.options.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: request.messages.map((message) => ({
        // `trust` is ours, not the provider's: it is stripped here, which is
        // the one place in the system that is allowed to drop it.
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
      })),
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
    };
  }
}

/* ──────────────────────────────── plumbing ──────────────────────────────── */

/** Split an SSE byte stream into `data:` payloads. */
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data !== '') yield data;
      index = buffer.indexOf('\n\n');
    }
  }
}

function networkError(error: unknown): ModelChunk {
  const message = error instanceof Error ? error.message : String(error);
  const aborted = error instanceof Error && error.name === 'AbortError';
  return {
    type: 'error',
    kind: aborted ? 'timeout' : 'network',
    message: aborted ? 'the request was cancelled' : `could not reach the model provider: ${message}`,
    retryable: !aborted,
  };
}

async function httpError(response: {
  status: number;
  text(): Promise<string>;
}): Promise<ModelChunk> {
  const body = (await response.text().catch(() => '')).slice(0, 400);
  const kind: ModelErrorKind =
    response.status === 401 || response.status === 403
      ? 'auth'
      : response.status === 429
        ? 'rate-limit'
        : response.status === 400 && /context|too many tokens|maximum context/i.test(body)
          ? 'context-overflow'
          : response.status === 400
            ? 'bad-request'
            : response.status >= 500
              ? 'server'
              : 'unknown';
  return {
    type: 'error',
    kind,
    // The status and the provider's own words, both: a 400 whose body says
    // "max_tokens must be <= 4096" is actionable, and "bad request" is not.
    message: `provider returned ${response.status}: ${body === '' ? '(no body)' : body}`,
    retryable: kind === 'rate-limit' || kind === 'server',
  };
}
