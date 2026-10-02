/**
 * `FakeModel` — the deterministic model provider every test uses (§8: every
 * port has a deterministic fake; §6: the suite is offline and deterministic).
 *
 * This is not a stub that returns a canned string. It is a programmable
 * adversary: it can stall, die mid-stream, emit malformed chunks, ignore the
 * abort signal for a beat, never finish, or emit ten thousand tiny deltas.
 * A fake that only does the nice thing tests only the nice path.
 */
import type { AsyncLocalStorage } from 'node:async_hooks';
import {
  type FinishReason,
  type ModelChunk,
  type ModelErrorKind,
  type ModelRequest,
  parseChunk,
} from '../../src/substrate/model/types.js';
import type { ModelCapabilities, ModelProvider } from '../../src/substrate/ports.js';

export type Script = ModelChunk[];

export interface Turn {
  /** Chunks to emit for this call, in order. */
  chunks: ModelChunk[];
  /** Throw instead of emitting — a provider that breaks its own contract. */
  throws?: Error;
  /** Emit this many raw-invalid chunks to exercise boundary validation. */
  emitInvalid?: unknown[];
  /** Stop emitting after this many chunks and never finish (a hung provider). */
  hangAfter?: number;
  /**
   * Block after this many chunks until `gate` resolves.
   *
   * Without this a test cannot cancel a run mid-stream: the fake has no I/O,
   * so the whole run completes in one microtask and the cancel always
   * arrives too late. A real provider is slow; a fake that cannot be slow
   * cannot test the code paths that exist *because* providers are slow.
   */
  pauseAfter?: number;
  gate?: Promise<void>;
}

/** A promise plus the handle to resolve it, for gating a fake stream. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export interface FakeModelOptions {
  id?: string;
  capabilities?: Partial<ModelCapabilities>;
  /** Called before each turn is emitted — a seam for asserting on requests. */
  onRequest?: (req: ModelRequest, callIndex: number) => void;
}

/** Convenience builders so test bodies read as intent, not as chunk soup. */
export const say = (text: string): ModelChunk[] =>
  text.split(/(?<=\s)/).map((part) => ({ type: 'text-delta', text: part }));

export const usage = (inputTokens: number, outputTokens: number, costMicros = 0): ModelChunk => ({
  type: 'usage',
  inputTokens,
  outputTokens,
  costMicros,
});

export const finish = (reason: FinishReason = 'stop'): ModelChunk => ({ type: 'finish', reason });

export const callTool = (id: string, name: string, input: unknown): ModelChunk => ({
  type: 'tool-call',
  id,
  name,
  input,
});

export const fail = (kind: ModelErrorKind, message: string, retryable = false): ModelChunk => ({
  type: 'error',
  kind,
  message,
  retryable,
});

/** The ordinary case: say something and stop. */
export function reply(text: string, cost = 0): Turn {
  return { chunks: [...say(text), usage(10, Math.ceil(text.length / 4), cost), finish('stop')] };
}

export class FakeModel implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  /** Every request this fake has been given, for assertions. */
  readonly requests: ModelRequest[] = [];
  /** Signals seen, so a test can assert the runner actually wires abort. */
  readonly signals: AbortSignal[] = [];

  private readonly turns: Turn[];
  private callIndex = 0;
  private readonly options: FakeModelOptions;

  constructor(turns: Turn[] = [], options: FakeModelOptions = {}) {
    this.turns = turns;
    this.options = options;
    this.id = options.id ?? 'fake-1';
    this.capabilities = {
      tools: true,
      structuredOutput: true,
      vision: false,
      caching: false,
      maxContext: 8192,
      maxOutput: 1024,
      ...options.capabilities,
    };
  }

  /** Queue another turn after construction — multi-turn tests read better. */
  push(turn: Turn): this {
    this.turns.push(turn);
    return this;
  }

  get callCount(): number {
    return this.callIndex;
  }

  async *generate(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    const index = this.callIndex++;
    this.requests.push(req);
    this.signals.push(signal);
    this.options.onRequest?.(req, index);

    // Running past the script is a test bug, and a confusing one if it
    // silently returns nothing — so it is loud.
    const turn = this.turns[index];
    if (turn === undefined) {
      throw new Error(
        `FakeModel: call ${index + 1} has no scripted turn (${this.turns.length} scripted). ` +
          `The loop ran more steps than the test expected.`,
      );
    }

    if (turn.throws !== undefined) throw turn.throws;

    for (const raw of turn.emitInvalid ?? []) {
      yield parseChunk(this.id, raw); // deliberately throws ModelProtocolError
    }

    let emitted = 0;
    for (const chunk of turn.chunks) {
      // Checked before each chunk: a real provider cannot interrupt the
      // network packet in flight either, and the runner must cope with a
      // chunk arriving *after* it asked to stop.
      if (signal.aborted) return;
      if (turn.hangAfter !== undefined && emitted >= turn.hangAfter) {
        // A provider that stops talking without finishing. The loop must not
        // hang on this; a stop condition must catch it.
        return;
      }
      if (turn.pauseAfter !== undefined && emitted === turn.pauseAfter && turn.gate !== undefined) {
        await turn.gate;
        if (signal.aborted) return;
      }
      emitted++;
      yield chunk;
      // Yield to the event loop so an abort fired from a different task is
      // actually observed between chunks, as it would be over a socket.
      await Promise.resolve();
    }
  }

  /**
   * Characters / 4, deterministically.
   *
   * Real tokenizers are per-model multi-megabyte dependencies. §32's budgets
   * need an estimate that is *stable*, not exact — see decision 014.
   */
  async countTokens(input: ModelRequest | string): Promise<number> {
    return estimateTokens(input);
  }
}

export function estimateTokens(input: ModelRequest | string): number {
  if (typeof input === 'string') return Math.ceil(input.length / 4);
  let chars = 0;
  for (const message of input.messages) chars += message.content.length + message.role.length + 4;
  return Math.ceil(chars / 4);
}

/** A model that emits `count` tiny deltas — for memory/throughput tests. */
export function floodTurn(count: number): Turn {
  const chunks: ModelChunk[] = [];
  for (let i = 0; i < count; i++) chunks.push({ type: 'text-delta', text: 'x' });
  chunks.push(usage(5, count), finish('stop'));
  return { chunks };
}

export type { AsyncLocalStorage };
