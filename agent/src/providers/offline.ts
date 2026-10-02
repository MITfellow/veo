/**
 * The offline provider (L1 adapter).
 *
 * The runtime has to start and be *honest* with no API key configured. The
 * tempting alternatives are both bad: crashing at boot means the app cannot
 * be tried at all, and a canned chatbot that pretends to think is a lie told
 * by the one component whose entire job is not lying.
 *
 * So this provider does three things and says what it is doing:
 *
 *   - it answers a small set of questions it can genuinely answer, by
 *     **calling a real tool** — asked for the time, it reaches for whichever
 *     offered tool describes itself that way, so the answer comes through
 *     the capability gate, the outbox and the trust lattice like any other,
 *   - it reflects the context back when asked, which makes the assembler
 *     visible without a provider,
 *   - and for anything else it says plainly that no model is configured and
 *     what to set.
 *
 * It is deterministic, offline and free, so the integration tests and the
 * shipped app run the same code path.
 */
import type { ModelCapabilities, ModelProvider } from '../substrate/ports.js';
import { parseChunk, type ModelChunk, type ModelRequest } from '../substrate/model/types.js';

const NO_MODEL =
  'I am running without a language model, so I cannot answer that one. ' +
  'Everything else here is real: the event log, the trust rules, the ' +
  'approval gate and the tools all work. Set ARISH_API_KEY (and optionally ' +
  'ARISH_BASE_URL and ARISH_MODEL) and restart the agent to give me words.';

export interface OfflineProviderOptions {
  id?: string;
  /** Tool names the provider is allowed to reach for. */
  tools?: readonly string[];
}

export class OfflineProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities = {
    tools: true,
    structuredOutput: false,
    vision: false,
    caching: false,
    maxContext: 8_000,
    maxOutput: 1_024,
  };

  constructor(options: OfflineProviderOptions = {}) {
    this.id = options.id ?? 'offline';
  }

  async *generate(request: unknown, signal: AbortSignal): AsyncIterable<ModelChunk> {
    const req = request as ModelRequest;
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    const asked = (lastUser?.content ?? '').toLowerCase();
    const toolResult = asked.startsWith('[result of ');

    // One step of "think", so the UI's streaming path is exercised rather
    // than bypassed by an instant answer.
    if (signal.aborted) return;

    // Which tool? Not by name — a provider that knows a tool's name has
    // put a hole in the capability boundary (invariant 9), and this file
    // sits below L5. It picks by *shape and description*, from whatever the
    // assembler chose to offer: a tool that needs no arguments (this
    // provider cannot invent arguments) whose words overlap the question.
    const candidate = toolResult ? undefined : bestTool(req, asked);
    if (candidate !== undefined) {
      yield parseChunk(this.id, { type: 'tool-call', id: 'offline-1', name: candidate, input: {} });
      yield parseChunk(this.id, { type: 'usage', inputTokens: tokens(req), outputTokens: 8, costMicros: 0 });
      yield parseChunk(this.id, { type: 'finish', reason: 'tool-calls' });
      return;
    }

    const text = toolResult
      ? `Here is what the tool returned:\n\n${lastUser!.content.replace(/^\[result of [^\]]+\]\n?/, '')}`
      : /\bcontext\b/.test(asked)
        ? describeContext(req)
        : NO_MODEL;

    for (const piece of chunked(text)) {
      if (signal.aborted) return;
      yield parseChunk(this.id, { type: 'text-delta', text: piece });
    }
    yield parseChunk(this.id, { type: 'usage', inputTokens: tokens(req), outputTokens: Math.ceil(text.length / 4), costMicros: 0 });
    yield parseChunk(this.id, { type: 'finish', reason: 'stop' });
  }

  async countTokens(input: unknown): Promise<number> {
    return typeof input === 'string' ? Math.ceil(input.length / 4) : tokens(input as ModelRequest);
  }
}

/**
 * The best zero-argument tool for the question, or nothing.
 *
 * Deliberately dumb: overlap of meaningful words between the question and
 * the tool's own description, with a floor so that an unrelated question
 * calls nothing. A real model does this far better; the point here is only
 * that the *path* — gate, outbox, observation, trust — is real.
 */
const FILLER = new Set([
  'the', 'and', 'for', 'you', 'your', 'can', 'what', 'who', 'how', 'why', 'does', 'this',
  'that', 'with', 'from', 'about', 'please', 'tell', 'give', 'any', 'are', 'was', 'use',
  'used', 'using', 'get', 'has', 'have', 'its', 'not', 'but', 'all', 'returns', 'return',
  'current', 'user', 'would', 'read', 'into', 'their', 'when', 'where',
]);

function meaningful(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !FILLER.has(w)));
}

function bestTool(request: ModelRequest, asked: string): string | undefined {
  const words = meaningful(asked);
  let best: { name: string; score: number } | undefined;

  for (const tool of request.tools ?? []) {
    const parameters = tool.parameters as { required?: unknown };
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    if (required.length > 0) continue;

    let score = 0;
    for (const word of meaningful(`${tool.name} ${tool.description}`)) {
      if (words.has(word)) score += 1;
    }
    if (score >= 1 && (best === undefined || score > best.score)) best = { name: tool.name, score };
  }

  return best?.name;
}

/**
 * Describe the context the assembler just built. Useful on its own, and it
 * is the one answer this provider can give that a real model cannot give
 * better — it is reporting, not reasoning.
 */
function describeContext(request: ModelRequest): string {
  const lines = [
    `I was given ${request.messages.length} message(s) in this context` +
      `${request.tools === undefined ? '' : ` and ${request.tools.length} tool(s)`}:`,
    '',
  ];
  for (const message of request.messages) {
    const first = message.content.split('\n')[0] ?? '';
    lines.push(`- ${message.role} (${message.trust ?? 'USER'}): ${first.slice(0, 90)}`);
  }
  lines.push('', 'Every block of that is reconstructible from the event log.');
  return lines.join('\n');
}

/** Emit in word-sized pieces so the stream looks like a stream. */
function chunked(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function tokens(request: ModelRequest): number {
  return Math.ceil(request.messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}
