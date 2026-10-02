/**
 * The run loop (§26, L5).
 *
 * ```
 * trigger → run.started → loop:
 *     step.started            (persisted BEFORE anything happens)
 *       → assemble context    (pure)
 *       → model.requested → stream → model.responded | model.failed
 *       → parse: text | tool calls
 *     step.finished           (persisted AFTER)
 *   until a stop condition
 * → run.finished | run.failed | run.cancelled | run.suspended
 * ```
 *
 * Two properties drive every decision in this file.
 *
 * **The step is the unit of recovery (invariant 3).** `step.started` is
 * appended before the model is called and `step.finished` after it returns,
 * so a process killed at any instruction leaves a log that says precisely how
 * far it got. A `step.started` with no matching `step.finished` *is* the
 * definition of an interrupted step — no extra bookkeeping, no status column
 * to get out of sync.
 *
 * **The run is reconstructible from the log alone.** The runner holds no
 * state that is not an event. Everything in memory here is a cache of
 * something already appended; drop it, replay, and you are in the same place.
 * That is the M2 bar, and it is why there is no `runs` table of record — only
 * a projection (decision 008).
 */
import type { Event } from '../substrate/events/envelope.js';
import type { EventLog } from '../substrate/events/log.js';
import { STOP_REASONS } from '../substrate/events/types.js';
import type { TrustLevel } from '../substrate/events/types.js';
import type { Clock, Ids, Logger } from '../substrate/ports.js';
import { canonicalJson } from '../substrate/hash.js';
import {
  accumulate,
  emptyTotals,
  type ModelChunk,
  type ModelRequest,
  ModelProtocolError,
  type StreamTotals,
  type ToolCall,
} from '../substrate/model/types.js';
import {
  assembleContext,
  type AssembledContext,
  type Turn,
} from '../cognition/context/assemble.js';

export type StopReason = (typeof STOP_REASONS)[number];

/** A model provider, narrowed to the real chunk types M2 defines. */
export interface TypedModelProvider {
  id: string;
  generate(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
  countTokens(input: ModelRequest | string): Promise<number>;
}

export interface RunLimits {
  maxSteps: number;
  maxTokens: number;
  maxWallMs: number;
  maxCostMicros: number;
  /** Context budget handed to the assembler. */
  maxContextTokens: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 12,
  maxTokens: 100_000,
  maxWallMs: 300_000,
  maxCostMicros: 1_000_000, // $1.00
  maxContextTokens: 6_000,
};

export interface RunRequest {
  sessionId: string;
  principal: string;
  trigger: 'user' | 'schedule' | 'resume' | 'system';
  limits?: Partial<RunLimits>;
  /** Persona / constitution text. M5 builds this properly. */
  system?: string;
  /**
   * Caller-supplied run id.
   *
   * The HTTP layer must return a runId to the client *before* the run
   * starts, or the client cannot subscribe to a stream whose beginning it
   * would otherwise miss.
   */
  runId?: string;
}

export interface RunOutcome {
  runId: string;
  status: 'finished' | 'failed' | 'cancelled' | 'suspended';
  reason: StopReason | null;
  steps: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/** What a stop check returns: a reason, or null to keep going. */
interface CapState {
  steps: number;
  tokens: number;
  costMicros: number;
  startedAt: number;
}

const DEFAULT_SYSTEM =
  'You are a personal agent. You are careful, concrete and honest. ' +
  'When you do not know something, say so plainly rather than guessing.';

export interface RunnerDeps {
  events: EventLog;
  clock: Clock;
  ids: Ids;
  logger: Logger;
  model: TypedModelProvider;
  /** Degradation level to report in the Situation block (§27). */
  degradation?: () => string;
}

export class Runner {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {}

  /** Cancel a running run. Safe to call for an unknown or finished run. */
  cancel(runId: string, by = 'user'): boolean {
    const controller = this.controllers.get(runId);
    if (controller === undefined) return false;
    controller.abort(new CancelledError(by));
    return true;
  }

  isRunning(runId: string): boolean {
    return this.controllers.has(runId);
  }

  async run(request: RunRequest): Promise<RunOutcome> {
    const { events, clock, ids, logger, model } = this.deps;
    const limits: RunLimits = { ...DEFAULT_LIMITS, ...request.limits };

    const runId = request.runId ?? ids.ulid();
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    const startedAt = clock.now();
    const runStarted = events.append({
      type: 'run.started',
      payload: {
        trigger: request.trigger,
        sessionId: request.sessionId,
        budget: {
          steps: limits.maxSteps,
          tokens: limits.maxTokens,
          wallClockMs: limits.maxWallMs,
          costCents: limits.maxCostMicros / 10_000,
        },
      },
      principal: request.principal,
      trust: request.trigger === 'user' ? 'USER' : 'SYSTEM',
      sessionId: request.sessionId,
      runId,
      // Every event in this run shares the run's correlation id, so one query
      // returns the whole story (§30: correlation id on every line).
      correlationId: runId,
    });

    const caps: CapState = { steps: 0, tokens: 0, costMicros: 0, startedAt };
    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const recentCalls: string[] = [];
    /** The in-flight stream's totals, so a cancellation keeps its partial text. */
    let partial: StreamTotals | null = null;

    try {
      for (;;) {
        /* ── stop conditions, checked BEFORE a step ────────────────────── */
        // Deliberately before, never mid-stream: aborting a model call
        // halfway to save 200 tokens wastes the 2,000 already spent and
        // leaves a partial answer nobody can use.
        const capHit = this.checkCaps(caps, limits, clock);
        if (capHit !== null) {
          return this.finish(runId, request, capHit, caps, finalText, inputTokens, outputTokens);
        }

        const stepIndex = caps.steps;
        const stepId = ids.ulid();
        const stepStart = clock.now();

        /* ── step.started — persisted before anything happens ──────────── */
        const effectiveTrust: TrustLevel = 'USER';
        events.append({
          type: 'step.started',
          payload: { index: stepIndex, effectiveTrust },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          causationId: runStarted.id,
          correlationId: runId,
        });

        /* ── assemble (pure) ───────────────────────────────────────────── */
        const context = this.assemble(request, limits, clock);
        const modelRequest: ModelRequest = {
          model: model.id,
          messages: context.messages,
          maxOutputTokens: Math.min(limits.maxTokens - caps.tokens, 4096),
        };

        const contextDigest = canonicalJson({
          blocks: context.blocks,
          totalTokens: context.totalTokens,
        });
        events.append({
          type: 'model.requested',
          payload: {
            provider: model.id,
            model: model.id,
            // The digest, not the text: logging the full context on every
            // step would double the size of the log for no new information,
            // since the context is a pure function of events already in it.
            contextDigest,
            inputTokens: context.totalTokens,
          },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          correlationId: runId,
        });

        /* ── stream ────────────────────────────────────────────────────── */
        // The totals object is created HERE, not inside stream(), so that a
        // cancellation thrown mid-stream does not take the partial text down
        // with it. The user watched those tokens appear.
        const totals = emptyTotals();
        partial = totals;
        await this.stream(modelRequest, controller.signal, totals, (chunk) => {
          this.onChunk?.(runId, stepId, chunk);
        });
        partial = null;

        const latencyMs = clock.now() - stepStart;
        caps.tokens += totals.inputTokens + totals.outputTokens;
        caps.costMicros += totals.costMicros;
        inputTokens += totals.inputTokens;
        outputTokens += totals.outputTokens;

        if (totals.error !== null) {
          // Failure is data: the partial text is kept, because the user
          // watched it appear and must not see it silently vanish.
          finalText += totals.text;
          events.append({
            type: 'model.failed',
            payload: {
              provider: model.id,
              kind: mapErrorKind(totals.error.kind),
              message: totals.error.message,
            },
            principal: 'system',
            trust: 'SYSTEM',
            sessionId: request.sessionId,
            runId,
            stepId,
            correlationId: runId,
          });
          this.appendStepFinished(request, runId, stepId, stepIndex, 'error', latencyMs);
          caps.steps++;
          if (totals.text.length > 0) {
            this.appendAgentMessage(request, runId, stepId, totals.text, 'error');
          }
          events.append({
            type: 'run.failed',
            payload: { kind: totals.error.kind, message: totals.error.message, stepId },
            principal: 'system',
            trust: 'SYSTEM',
            sessionId: request.sessionId,
            runId,
            correlationId: runId,
          });
          return {
            runId,
            status: 'failed',
            reason: null,
            steps: caps.steps,
            text: finalText,
            inputTokens,
            outputTokens,
            costMicros: caps.costMicros,
          };
        }

        events.append({
          type: 'model.responded',
          payload: {
            provider: model.id,
            model: model.id,
            outputTokens: totals.outputTokens,
            finishReason: totals.finishReason ?? 'none',
            latencyMs,
            costCents: totals.costMicros / 10_000,
          },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          correlationId: runId,
        });

        finalText += totals.text;

        /* ── tool calls ────────────────────────────────────────────────── */
        if (totals.toolCalls.length > 0) {
          const loop = this.detectLoop(recentCalls, totals.toolCalls);
          for (const call of totals.toolCalls) {
            events.append({
              type: 'tool.requested',
              payload: {
                tool: call.name,
                version: '0',
                input: (call.input ?? {}) as Record<string, unknown>,
              },
              principal: 'system',
              trust: 'SYSTEM',
              sessionId: request.sessionId,
              runId,
              stepId,
              correlationId: runId,
            });
          }
          this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
          caps.steps++;

          if (loop === 'abort') {
            logger.warn('aborting run: the model is repeating a tool call', { runId });
            if (finalText.length > 0) {
              this.appendAgentMessage(request, runId, stepId, finalText, 'loop-detected');
            }
            return this.finish(
              runId,
              request,
              'loop-detected',
              caps,
              finalText,
              inputTokens,
              outputTokens,
              false,
            );
          }

          // M3 executes these. Until then the run stops here, honestly
          // labelled, rather than looping forever waiting for results that
          // will never come.
          if (finalText.length > 0) {
            this.appendAgentMessage(request, runId, stepId, finalText, 'tools-unavailable');
          }
          return this.finish(
            runId,
            request,
            'tools-unavailable',
            caps,
            finalText,
            inputTokens,
            outputTokens,
            false,
          );
        }

        /* ── plain text answer ─────────────────────────────────────────── */
        this.appendStepFinished(request, runId, stepId, stepIndex, 'text', latencyMs);
        caps.steps++;

        // A stream that ended without the provider ever saying `finish` did
        // not complete — the socket dropped, the provider stalled, something
        // went wrong. Treating that as a finished answer would silently hand
        // the user half a sentence and call it done, so the loop goes round
        // again and a cap catches it. A test caught this: with the old
        // behaviour none of the four caps in §26 were reachable at all.
        if (totals.finishReason === null) {
          continue;
        }

        if (totals.text.length > 0) {
          this.appendAgentMessage(
            request,
            runId,
            stepId,
            totals.text,
            totals.finishReason ?? 'stop',
          );
        }
        return this.finish(runId, request, 'stop', caps, finalText, inputTokens, outputTokens, false);
      }
    } catch (err) {
      if (controller.signal.aborted || err instanceof CancelledError) {
        // The partial text is kept and recorded for the same reason as
        // above: the user watched it stream in.
        if (partial !== null) finalText += partial.text;
        if (finalText.length > 0) {
          this.appendAgentMessage(request, runId, null, finalText, 'cancelled');
        }
        events.append({
          type: 'run.cancelled',
          payload: { by: cancelledBy(controller.signal, err), reason: 'cancelled by request' },
          principal: request.principal,
          trust: 'USER',
          sessionId: request.sessionId,
          runId,
          correlationId: runId,
        });
        return {
          runId,
          status: 'cancelled',
          reason: null,
          steps: caps.steps,
          text: finalText,
          inputTokens,
          outputTokens,
          costMicros: caps.costMicros,
        };
      }

      const error = err as Error;
      // A provider that throws instead of emitting an `error` chunk is
      // breaking the port contract. The run still has to end cleanly.
      events.append({
        type: 'run.failed',
        payload: {
          kind: error instanceof ModelProtocolError ? 'protocol' : 'internal',
          message: error.message,
          stepId: null,
        },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId: request.sessionId,
        runId,
        correlationId: runId,
      });
      return {
        runId,
        status: 'failed',
        reason: null,
        steps: caps.steps,
        text: finalText,
        inputTokens,
        outputTokens,
        costMicros: caps.costMicros,
      };
    } finally {
      this.controllers.delete(runId);
    }
  }

  /** Optional per-chunk hook, used by the SSE layer to stream deltas. */
  onChunk?: (runId: string, stepId: string, chunk: ModelChunk) => void;

  /* ──────────────────────────────── internals ───────────────────────────── */

  private checkCaps(caps: CapState, limits: RunLimits, clock: Clock): StopReason | null {
    if (caps.steps >= limits.maxSteps) return 'step-cap';
    if (caps.tokens >= limits.maxTokens) return 'token-cap';
    if (clock.now() - caps.startedAt >= limits.maxWallMs) return 'time-cap';
    if (caps.costMicros >= limits.maxCostMicros) return 'cost-cap';
    return null;
  }

  private assemble(request: RunRequest, limits: RunLimits, clock: Clock): AssembledContext {
    const history = this.historyFor(request.sessionId);
    const level = this.deps.degradation?.() ?? 'L0';
    const situation = [
      `Current time: ${new Date(clock.now()).toISOString()}`,
      `Degradation level: ${level}`,
    ];
    return assembleContext({
      system: request.system ?? DEFAULT_SYSTEM,
      situation,
      history,
      maxTokens: limits.maxContextTokens,
      // Characters/4 — stable, not exact. Decision 014.
      countTokens: (text: string) => Math.ceil(text.length / 4),
    });
  }

  /**
   * History is read **from the event log**, not from a conversation object
   * held in memory. That is what makes a second turn see the first one after
   * a restart, and it is the same read the rebuild performs.
   */
  private historyFor(sessionId: string): Turn[] {
    const events = this.deps.events.read({
      sessionId,
      types: ['message.user', 'message.agent'],
    });
    return events.map((event: Event): Turn => {
      const payload = event.payload as { text: string };
      return {
        role: event.type === 'message.user' ? 'user' : 'assistant',
        content: payload.text,
        trust: event.trust,
        id: event.id,
      };
    });
  }

  private async stream(
    request: ModelRequest,
    signal: AbortSignal,
    totals: StreamTotals,
    onChunk: (chunk: ModelChunk) => void,
  ): Promise<void> {
    for await (const chunk of this.deps.model.generate(request, signal)) {
      if (signal.aborted) throw new CancelledError('user');
      onChunk(chunk);
      accumulate(totals, chunk);
    }
    if (signal.aborted) throw new CancelledError('user');
  }

  /**
   * Loop detection (§26): the same tool with the same canonical input three
   * times earns a corrective observation; a fourth aborts.
   *
   * Canonical JSON is the key, so `{a:1,b:2}` and `{b:2,a:1}` count as the
   * same call — which is exactly the loop a model actually gets stuck in.
   */
  private detectLoop(recent: string[], calls: ToolCall[]): 'ok' | 'correct' | 'abort' {
    let worst: 'ok' | 'correct' | 'abort' = 'ok';
    for (const call of calls) {
      const key = `${call.name}:${canonicalJson(call.input ?? null)}`;
      recent.push(key);
      const count = recent.filter((k) => k === key).length;
      if (count >= 4) worst = 'abort';
      else if (count === 3 && worst !== 'abort') worst = 'correct';
    }
    return worst;
  }

  private appendStepFinished(
    request: RunRequest,
    runId: string,
    stepId: string,
    index: number,
    outcome: 'text' | 'tools' | 'finish' | 'error',
    durationMs: number,
  ): void {
    this.deps.events.append({
      type: 'step.finished',
      payload: { index, outcome, durationMs },
      principal: 'system',
      trust: 'SYSTEM',
      sessionId: request.sessionId,
      runId,
      stepId,
      correlationId: runId,
    });
  }

  private appendAgentMessage(
    request: RunRequest,
    runId: string,
    stepId: string | null,
    text: string,
    finishReason: string,
  ): void {
    this.deps.events.append({
      type: 'message.agent',
      payload: { text, finishReason },
      principal: 'agent',
      // DERIVED, not USER: this is the model's output, inferred rather than
      // stated by the principal (§12).
      trust: 'DERIVED',
      sessionId: request.sessionId,
      runId,
      ...(stepId !== null ? { stepId } : {}),
      correlationId: runId,
    });
  }

  private finish(
    runId: string,
    request: RunRequest,
    reason: StopReason,
    caps: CapState,
    text: string,
    inputTokens: number,
    outputTokens: number,
    _unused?: boolean,
  ): RunOutcome {
    this.deps.events.append({
      type: 'run.finished',
      payload: {
        steps: caps.steps,
        tokens: caps.tokens,
        costCents: caps.costMicros / 10_000,
        reason,
      },
      principal: 'system',
      trust: 'SYSTEM',
      sessionId: request.sessionId,
      runId,
      correlationId: runId,
    });
    return {
      runId,
      status: 'finished',
      reason,
      steps: caps.steps,
      text,
      inputTokens,
      outputTokens,
      costMicros: caps.costMicros,
    };
  }
}

export class CancelledError extends Error {
  override readonly name = 'CancelledError';
  constructor(readonly by: string) {
    super('run cancelled');
  }
}

function cancelledBy(signal: AbortSignal, err: unknown): string {
  if (err instanceof CancelledError) return err.by;
  const reason: unknown = signal.reason;
  return reason instanceof CancelledError ? reason.by : 'user';
}

/** Map the port's error kinds onto the `model.failed` event's closed enum. */
function mapErrorKind(
  kind: string,
): 'transient' | 'invalid_request' | 'context_overflow' | 'content_filter' | 'auth' | 'quota' {
  switch (kind) {
    case 'auth':
      return 'auth';
    case 'rate-limit':
      return 'quota';
    case 'bad-request':
      return 'invalid_request';
    case 'timeout':
    case 'overloaded':
    case 'server':
    case 'network':
      return 'transient';
    default:
      return 'transient';
  }
}
