/**
 * `GovernedProvider` — the gate every model call goes through (§25, L5).
 *
 * This is the file that turns the constitution from a paragraph in a prompt
 * into a property of the process. It wraps the `ModelProvider` port, so it
 * is provider-agnostic by construction: the offline provider, the
 * OpenAI-compatible one, and whatever M9 adds are all governed by the same
 * code, and §34.4's "swap the provider by config alone" cannot quietly swap
 * the behavioural contract along with it.
 *
 * It lives at L5 rather than next to the providers at L1 because it depends
 * on the constitution (L4), and dependencies point inward only.
 *
 * ## Pre-flight: no sentinel, no call
 *
 * `assembleContext` renders the constitution block with a sentinel line
 * carrying the document's version and hash. Before forwarding a request this
 * decorator scans the **system** messages for that exact line. Missing →
 * `UngovernedModelCallError`. Stale hash → `UngovernedModelCallError` naming
 * both versions.
 *
 * There is deliberately no fallback branch. A system that falls back to
 * calling the model anyway has not got a contract, it has got a preference,
 * and the failure would be invisible precisely when it mattered — a refactor
 * that routed around the assembler would ship an ungoverned agent and every
 * test would still pass. Loud is the point.
 *
 * Only `role: 'system'` messages are scanned, which also answers the obvious
 * attack: the model sees a real sentinel on every turn and could echo one
 * back. Echoed text lands in an `assistant` message and is never consulted.
 *
 * ## Post-flight: judge, then remedy
 *
 * Deltas stream straight through by default — §32 budgets first token at
 * 1.5s and buffering every response to screen it would spend that budget on
 * a check that passes almost always. At `finish` the completed text is
 * judged against the `checked` articles and `constitution.enforced` is
 * emitted with every verdict, including the `unverifiable` ones.
 *
 * When the document contains an article whose remedy is `revise` or `block`,
 * the stream for that request is **buffered** instead: you cannot un-say a
 * sentence that has already been streamed to a screen. That cost is real,
 * it is recorded on the event (`buffered: true`), and the trade is stated
 * out loud rather than hidden — an article that can stop an answer costs you
 * the stream, so the founding charter keeps that list to two.
 */
import {
  judge,
  annotationFor,
  blockMessageFor,
  blockingArticles,
  type Judgment,
} from '../cognition/constitution/enforce.js';
import { emptyEvidence, type RunEvidence } from '../cognition/constitution/checks.js';
import { sentinelFor, viewOf, type ConstitutionView } from '../cognition/constitution/render.js';
import { UngovernedModelCallError, type Constitution } from '../cognition/constitution/types.js';
import type { ModelCapabilities, ModelProvider } from '../substrate/ports.js';
import {
  accumulate,
  emptyTotals,
  parseChunk,
  type ModelChunk,
  type ModelRequest,
} from '../substrate/model/types.js';

export interface GovernedProviderDeps {
  inner: ModelProvider;
  /** Read fresh on every call: the document can change between two turns. */
  constitution: () => Constitution;
  /**
   * Where verdicts go. The composition root wires this to an event append;
   * tests pass a collector. Never throws into the stream — a governance
   * bookkeeping failure must not destroy a good answer.
   */
  onJudgment?: (judgment: Judgment, meta: JudgmentMeta) => void;
}

export interface JudgmentMeta {
  runId: string;
  stepId: string;
  version: number;
  hash: string;
  buffered: boolean;
  remedyApplied: 'none' | 'annotate' | 'revise' | 'block';
}

export class GovernedProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  constructor(private readonly deps: GovernedProviderDeps) {
    this.id = deps.inner.id;
    this.capabilities = deps.inner.capabilities;
  }

  countTokens(input: unknown): Promise<number> {
    return this.deps.inner.countTokens(input);
  }

  async *generate(req: unknown, signal: AbortSignal): AsyncIterable<unknown> {
    const request = req as ModelRequest;
    const doc = this.deps.constitution();
    const view = viewOf(doc);

    assertGoverned(this.deps.inner.id, request, view);

    const mustBuffer = blockingArticles(doc).length > 0;
    const totals = emptyTotals();
    const buffer: ModelChunk[] = [];
    let finished = false;

    for await (const raw of this.deps.inner.generate(request, signal)) {
      const chunk = parseChunk(this.deps.inner.id, raw);
      accumulate(totals, chunk);
      if (chunk.type === 'finish') finished = true;

      if (mustBuffer) {
        buffer.push(chunk);
        continue;
      }
      yield chunk;
    }

    // A cancelled or errored stream is not judged. Judging a half-written
    // answer would manufacture violations out of truncation, and §24's
    // metrics would then measure the network.
    if (signal.aborted || totals.error !== null || !finished) {
      for (const chunk of buffer) yield chunk;
      return;
    }

    const evidence = evidenceFrom(request, totals.text, totals.toolCalls);
    const judgment = judge(doc, evidence);
    const violations = judgment.violations;

    let remedyApplied: JudgmentMeta['remedyApplied'] = 'none';

    if (mustBuffer && violations.length > 0 && judgment.remedy === 'block') {
      remedyApplied = 'block';
      this.report(judgment, request, view, mustBuffer, remedyApplied);
      yield { type: 'text-delta', text: blockMessageFor(doc, violations) } satisfies ModelChunk;
      yield { type: 'finish', reason: 'content-filter' } satisfies ModelChunk;
      return;
    }

    if (mustBuffer) {
      // `revise` is a single regeneration and it happens in the runner, not
      // here: a provider that re-entered itself would bypass the step
      // budget, the token cap and the cancellation signal. The gate reports
      // the verdict; the runner decides whether to spend another step.
      if (violations.length > 0 && judgment.remedy === 'revise') remedyApplied = 'revise';
      for (const chunk of buffer) yield chunk;
    }

    if (violations.length > 0 && judgment.remedy === 'annotate') {
      remedyApplied = 'annotate';
      yield { type: 'text-delta', text: annotationFor(doc, violations) } satisfies ModelChunk;
    }

    this.report(judgment, request, view, mustBuffer, remedyApplied);
  }

  private report(
    judgment: Judgment,
    request: ModelRequest,
    view: ConstitutionView,
    buffered: boolean,
    remedyApplied: JudgmentMeta['remedyApplied'],
  ): void {
    try {
      this.deps.onJudgment?.(judgment, {
        runId: request.governance?.runId ?? '',
        stepId: request.governance?.stepId ?? '',
        version: view.version,
        hash: view.hash,
        buffered,
        remedyApplied,
      });
    } catch {
      // Bookkeeping must never take the answer down with it.
    }
  }
}

/** The pre-flight check, exported so a test can call it without a stream. */
export function assertGoverned(
  providerId: string,
  request: ModelRequest,
  view: ConstitutionView,
): void {
  const sentinel = sentinelFor(view);
  const systemText = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  if (systemText.includes(sentinel)) return;

  const stale = /\[constitution v(\d+) · sha ([0-9a-f]+)/.exec(systemText);
  if (stale) {
    throw new UngovernedModelCallError(
      providerId,
      `the context carries constitution v${stale[1] ?? '?'} (sha ${stale[2] ?? '?'}) but the ` +
        `live document is v${view.version} (sha ${view.hash}) — reassemble the context`,
    );
  }
  throw new UngovernedModelCallError(
    providerId,
    'no constitution sentinel in the system messages',
  );
}

/**
 * Build the evidence record from the request and the completed response.
 *
 * Everything structured comes from `request.governance`, which the runner
 * fills from the same snapshot the context was assembled from. The fallback
 * path — no hints at all — still produces usable evidence from the messages
 * themselves, so a caller that forgets the hints gets weaker checking rather
 * than a crash, and the weakness shows up as `unverifiable` verdicts instead
 * of as false confidence.
 */
export function evidenceFrom(
  request: ModelRequest,
  output: string,
  toolCalls: readonly { name: string; id: string }[],
): RunEvidence {
  const hints = request.governance;
  if (hints) {
    return { ...emptyEvidence(hints), output, toolCalls };
  }

  const userMessages = request.messages.filter((m) => m.role === 'user');
  const assistantMessages = request.messages.filter((m) => m.role === 'assistant');
  const toolMessages = request.messages.filter((m) => m.role === 'tool');
  const foreign = request.messages.filter((m) => m.trust === 'FOREIGN').map((m) => m.content);

  return emptyEvidence({
    output,
    toolCalls,
    userMessage: userMessages.at(-1)?.content ?? '',
    previousAgentTurn: assistantMessages.at(-1)?.content ?? '',
    toolsCompleted: toolMessages.map((m) => m.name ?? 'tool'),
    foreign,
  });
}
