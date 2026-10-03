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
import {
  parseChunk,
  type ModelChunk,
  type ModelRequest,
  type ModelToolSpec,
} from '../substrate/model/types.js';

const NO_MODEL =
  'I am running without a language model, so I cannot answer that one. ' +
  'Everything else here is real: the event log, the trust rules, the ' +
  'approval gate and the tools all work. Set ARISH_API_KEY (and optionally ' +
  'ARISH_BASE_URL and ARISH_MODEL) and restart the agent to give me words.';

export interface OfflineProviderOptions {
  id?: string;
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
    // sits below L5. It picks by *shape and description*, from whatever
    // the assembler chose to offer, and fills the arguments from the
    // JSON schema. Until S3 it could only call tools that took no
    // arguments at all, which left most of the toolbox unreachable on
    // the default configuration.
    const candidate = toolResult ? undefined : bestTool(req, asked);
    if (candidate !== undefined) {
      yield parseChunk(this.id, {
        type: 'tool-call',
        id: 'offline-1',
        name: candidate.name,
        input: candidate.input,
      });
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
 * The best tool for the question, with its arguments, or nothing.
 *
 * Deliberately dumb: overlap of meaningful words between the question
 * and the tool's own description, with a floor so that an unrelated
 * question calls nothing. A real model does this far better; the point
 * here is only that the *path* — gate, outbox, observation, trust — is
 * real, and that it is real for every tool rather than only for the
 * four that happen to take no arguments.
 *
 * **Name-blind, and it has to stay that way.** The moment this file
 * says `if (tool.name === ...)` the plugin contract is a lie and §20's
 * "adding a tool touches one file" stops being true. Everything below
 * is driven by the JSON schema the registry already supplies — which
 * §36 calls the single definition of a tool's arguments, and which this
 * provider used to ignore entirely.
 */
/**
 * Function words and pleasantries, which carry no intent.
 *
 * This list is load-bearing, not cosmetic. "hello there" once matched a
 * tool whose description ends "...this removes something they put
 * there" — a single function word, shared by accident, was the entire
 * evidence for a destructive call. Greetings are in here for the same
 * reason: they are the most common thing a person types that means
 * "nothing yet", and they must match nothing.
 */
const FILLER = new Set([
  'the', 'and', 'for', 'you', 'your', 'can', 'what', 'who', 'how', 'why', 'does', 'this',
  'that', 'with', 'from', 'about', 'please', 'tell', 'give', 'any', 'are', 'was', 'use',
  'used', 'using', 'get', 'has', 'have', 'its', 'not', 'but', 'all', 'returns', 'return',
  'current', 'user', 'would', 'read', 'into', 'their', 'when', 'where',
  // Function words.
  'there', 'here', 'they', 'them', 'then', 'than', 'some', 'such', 'each', 'other',
  'which', 'while', 'been', 'being', 'were', 'will', 'shall', 'should', 'could', 'may',
  'might', 'must', 'onto', 'over', 'under', 'between', 'also', 'just', 'only', 'very',
  'more', 'most', 'much', 'many', 'something', 'anything', 'everything', 'nothing',
  'someone', 'anyone', 'everyone', 'thing', 'things', 'stuff', 'one', 'two', 'both',
  // Pleasantries. A greeting is the commonest input that means nothing.
  // Times of day and 'now' are deliberately *absent*: they are
  // pleasantries in "good morning" but real signal in "what is on my
  // calendar this morning", and a read costs little when it is wrong.
  'hello', 'hallo', 'hey', 'hiya', 'good', 'thanks', 'thank', 'okay', 'yeah', 'yes',
  'sure', 'sorry', 'bye', 'cheers', 'hope', 'well', 'nice', 'great', 'cool',
]);

function meaningful(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !FILLER.has(w)));
}

/**
 * Only `safe` tools, and only `pure`/`local` ones.
 *
 * This provider guesses. It matched "hello there" to the tool that
 * cancels a calendar entry — because the word "there" appears in that
 * tool's description — and raised a dangerous approval against an
 * invented id. That is not a
 * scoring bug to be tuned away; it is the whole category. Something
 * that cannot understand the question must not be trusted to decide a
 * write, and no amount of threshold-fiddling makes a word-overlap
 * matcher safe to hand a delete.
 *
 * Reading is different: a wrong search wastes a call and the person
 * sees an unhelpful answer, which is recoverable. So the rule is a
 * property of the tool, read from the spec, rather than a list of
 * names this file is not allowed to know.
 */
const safeToGuess = (tool: ModelToolSpec): boolean =>
  (tool.risk ?? 'dangerous') === 'safe' && (tool.effect ?? 'external') !== 'external';

interface Slot {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
}

const isType = (slot: Slot, want: string): boolean =>
  slot.type === want || (Array.isArray(slot.type) && slot.type.includes(want));

/**
 * One required argument, from the question, using only the schema.
 *
 * Returns `undefined` when it cannot tell — and the caller then
 * abandons the whole call. A half-filled call fails zod validation and
 * the person reads the resulting tool error as a crash, which is a
 * worse answer than "I cannot do that without a model".
 *
 * `taken` is the values already used by earlier slots on this same
 * call. Without it, "convert 42 kilometres into miles" fills both
 * `from` and `to` with whichever unit the enum happens to list first.
 */
function fillSlot(
  slot: Slot,
  asked: string,
  options: { taken: ReadonlySet<unknown>; soleStringSlot: boolean },
): unknown {
  if (Array.isArray(slot.enum) && slot.enum.length > 0) {
    // Whole words only. A substring test is catastrophic here: a unit
    // list contains "m", "in", "t" and "l", and `asked.includes('m')`
    // is true of almost every English sentence. Found by running the
    // app, not by a test — my fixture used long unit names.
    const mentions: Array<{ option: unknown; at: number }> = [];
    for (const option of slot.enum) {
      if (typeof option !== 'string') continue;
      const at = asked.search(new RegExp(`\\b${escapeRegex(option.toLowerCase())}\\b`));
      if (at >= 0) mentions.push({ option, at });
    }
    // Earliest mention first, so slots declared in order take the
    // units named in order: from = kilometres, to = miles.
    mentions.sort((a, b) => a.at - b.at);
    return mentions.find((mention) => !options.taken.has(mention.option))?.option;
  }

  if (isType(slot, 'number') || isType(slot, 'integer')) {
    const match = asked.match(/-?\d+(\.\d+)?/);
    return match === null ? undefined : Number(match[0]);
  }

  if (isType(slot, 'boolean')) return undefined;

  if (isType(slot, 'string')) {
    // A quoted span is the user being explicit about the value, so it
    // wins over anything inferred.
    const quoted = asked.match(/["\u201c']([^"\u201d']{2,})["\u201d']/);
    if (quoted?.[1] !== undefined) return quoted[1];

    // Otherwise the question's own content words — but only if this is
    // the *only* free-text argument. With two, there is no way to tell
    // which words belong to which, and filling both with the same blob
    // is never right: it is how the unit conversion tool was once
    // asked to convert "convert kilometres miles" into "convert
    // kilometres miles".
    if (!options.soleStringSlot) return undefined;
    const words = [...meaningful(asked)];
    return words.length === 0 ? undefined : words.join(' ');
  }

  return undefined;
}

/** Escape a schema-supplied string before it goes into a RegExp. */
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bestTool(
  request: ModelRequest,
  asked: string,
): { name: string; input: Record<string, unknown> } | undefined {
  const words = meaningful(asked);
  let best: { name: string; input: Record<string, unknown>; score: number } | undefined;

  for (const tool of request.tools ?? []) {
    if (!safeToGuess(tool)) continue;

    const parameters = tool.parameters as {
      required?: unknown;
      properties?: Record<string, Slot>;
    };
    const properties = parameters.properties ?? {};
    const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];

    const own = meaningful(`${tool.name} ${tool.description}`);
    let hits = 0;
    for (const word of own) if (words.has(word)) hits += 1;

    // One genuine content word in common is enough to try; the words
    // that are *not* genuine are excluded by FILLER above, which is
    // where that judgement belongs. A hit count threshold here instead
    // would have silently killed "what is the rainfall in Shillong",
    // whose only overlap with its tool is the word "rainfall".
    if (hits < 1) continue;

    // Normalised, so a tool with a long description does not win on
    // volume alone. Raw overlap made the wordiest tool the default
    // answer to everything.
    const score = hits / Math.sqrt(own.size || 1);

    // How many required arguments are free text? One can be inferred
    // from the question; two cannot be told apart.
    const freeTextSlots = required.filter((name) => {
      const slot = properties[name];
      return (
        slot !== undefined && isType(slot, 'string') && !Array.isArray(slot.enum)
      );
    }).length;

    const input: Record<string, unknown> = {};
    const taken = new Set<unknown>();
    let fillable = true;
    for (const name of required) {
      const slot = properties[name];
      const value =
        slot === undefined
          ? undefined
          : fillSlot(slot, asked, { taken, soleStringSlot: freeTextSlots === 1 });
      if (value === undefined) {
        fillable = false;
        break;
      }
      input[name] = value;
      taken.add(value);
    }
    if (!fillable) continue;

    if (best === undefined || score > best.score) best = { name: tool.name, input, score };
  }

  return best === undefined ? undefined : { name: best.name, input: best.input };
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
