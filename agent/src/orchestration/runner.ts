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
  type GovernanceHints,
  ModelProtocolError,
  type StreamTotals,
  type ToolCall,
} from '../substrate/model/types.js';
import { assembleContext, type AssembledContext } from '../cognition/context/assemble.js';
import { policyFor, type ContextPolicy } from '../cognition/context/policy.js';
import type { ForeignItem, StateSnapshot } from '../cognition/context/types.js';
import { Snapshotter, type Gathered } from './snapshot.js';
import { Compactor } from '../cognition/compaction.js';
import { TokenCache } from '../cognition/tokens.js';
import type { Invoker, Observation } from '../capability/invoke.js';
import type { ApprovalStore, SuspensionStore } from '../capability/approvals.js';
import { DEFAULT_DAILY_BUDGET, ZERO_SPEND, type Budget, type DailyLedger } from '../capability/budgets.js';

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
  /** M4 (§19): the sixth dimension. Egress bytes are bounded per run by the
   *  scoped Net, which is where the bytes actually are. */
  maxToolCalls: number;
  /** Context budget handed to the assembler. */
  maxContextTokens: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 12,
  maxTokens: 100_000,
  maxWallMs: 300_000,
  maxCostMicros: 1_000_000, // $1.00
  maxToolCalls: 40,
  maxContextTokens: 6_000,
};

export interface RunRequest {
  sessionId: string;
  principal: string;
  trigger: 'user' | 'schedule' | 'resume' | 'system';
  /** Human-readable "why now", e.g. a schedule's name (M8). */
  triggerDetail?: string;
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
  /** M4: a run can be cheap per step and still make four hundred calls. */
  toolCalls: number;
  startedAt: number;
}

/** How much of the budget a post-compaction retry is allowed (§23). */
const OVERFLOW_RETRY_SCALE = 0.6;

/**
 * Exported because replay needs it (§34.5): rebuilding a historical
 * context means rebuilding the same kernel text the run used, and a copy
 * of this string in the replay path would drift from this one and make
 * every old run look like it had changed.
 */
export const DEFAULT_SYSTEM =
  'You are a personal agent. You are careful, concrete and honest. ' +
  'When you do not know something, say so plainly rather than guessing.';

/** What M6 hangs off the end of a run. */
export interface RunObserver {
  afterRun(outcome: RunOutcome, request: RunRequest): void | Promise<void>;
}

export interface RunnerDeps {
  events: EventLog;
  clock: Clock;
  ids: Ids;
  logger: Logger;
  model: TypedModelProvider;
  /**
   * Tool execution (M3). Absent means no tools: the loop still records
   * `tool.requested` and stops honestly rather than pretending.
   */
  invoker?: Invoker;
  /** The per-day spend ledger (§19). Omitted means per-run limits only. */
  dailyLedger?: DailyLedger;
  dailyBudget?: Budget;
  /** Approvals (M4). Without it, a dangerous tool is simply refused. */
  approvals?: ApprovalStore;
  /** Where a run parks while it waits for a human (§19). */
  suspensions?: SuspensionStore;
  /**
   * Notified after every run, used by M6 to learn from the episode. Errors
   * here are logged and dropped — memory is not allowed to break answering.
   */
  observer?: RunObserver;
  /**
   * The rewrite instruction for a step the constitution withheld
   * (decision 042).
   *
   * A port, not a dependency on the constitution module: the runner
   * must not know how an article is checked, only that the governance
   * layer asked for one more attempt and what to say. The composition
   * root holds both ends and wires them.
   */
  revisionInstruction?: (runId: string, stepId: string) => string | null;

  /**
   * Whether a real language model is configured. Fed to the constitution's
   * checks (§24.4): "answered confidently with no grounding" is a finding
   * about a model, and the offline provider's canned refusal is not one.
   */
  modelConfigured?: boolean;
  /**
   * Turn the untrusted-content fence OFF. Adversarial testing only (§33).
   * Production leaves it on; the point of the switch is to prove nothing
   * depends on it.
   */
  fence?: boolean;
  /** Degradation level to report in the Situation block (§27). */
  degradation?: () => string;
  /**
   * The outbox read model (M9): which external effects this run has
   * actually *committed*, by summary. The action-claim check needs the
   * difference between "a tool ran" and "the email was sent".
   */
  committedEffects?: (runId: string) => string[];
  /**
   * Context assembly (M5). Defaults are built from the other deps, so a
   * caller that does not care about context gets a working one.
   */
  snapshotter?: Snapshotter;
  compactor?: Compactor;
  contextPolicy?: ContextPolicy;
}

/**
 * What a resumed run needs to pick up where it stopped.
 *
 * Reconstructed from rows, never from a serialized continuation: a
 * continuation would be a second source of truth about where the run was
 * (invariant 1) and would rot the first time the surrounding code changed.
 */
export interface ResumeState {
  stepIndex: number;
  spend: { steps: number; tokens: number; costMicros: number };
  /** The call the human authorised, to be executed first. */
  approval: { id: string; tool: string; input: unknown; stepId: string } | null;
  /** Set instead when the human said no — the model is told, in words. */
  denialText: string | null;
}

export class Runner {
  private readonly controllers = new Map<string, AbortController>();
  private readonly compactor: Compactor;
  private readonly snapshotter: Snapshotter;
  private readonly contextPolicy: ContextPolicy;
  /**
   * Token counts memoized by content. Lives on the runner rather than inside
   * the assembler because the assembler is pure and must stay that way: the
   * cache is an argument it threads through, and output is byte-identical
   * with it, without it, cold or warm (§33's 100ms bar, tested).
   */
  private readonly tokens = new TokenCache();

  constructor(private readonly deps: RunnerDeps) {
    this.compactor =
      deps.compactor ?? new Compactor({ events: deps.events, clock: deps.clock, ids: deps.ids });
    this.snapshotter =
      deps.snapshotter ??
      new Snapshotter({ events: deps.events, clock: deps.clock, compactor: this.compactor });
    this.contextPolicy = deps.contextPolicy ?? policyFor(deps.model.id);
  }

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

  /**
   * Continue a run that was parked waiting for a human (§19).
   *
   * Resumes **at the step that asked**, not from the beginning. Replaying
   * from the top would re-execute every tool call already made, which for
   * anything non-idempotent is the double-effect M3 exists to prevent.
   *
   * Everything needed comes out of the database: the suspension row says
   * where to continue, the approval row says what was authorised, and the
   * event log supplies the history. Nothing was held in memory, which is
   * why this works across a process restart.
   */
  async resume(approvalId: string): Promise<RunOutcome> {
    const approvals = this.deps.approvals;
    const suspensions = this.deps.suspensions;
    if (approvals === undefined || suspensions === undefined) {
      throw new Error('this runner has no approval store; nothing can be resumed');
    }

    const approval = approvals.get(approvalId);
    if (approval === undefined) throw new Error(`no approval '${approvalId}'`);
    if (approval.state === 'pending') {
      throw new Error(`approval '${approvalId}' has not been answered yet`);
    }

    const suspension = suspensions.waitingOn(approvalId);
    if (suspension === undefined) {
      throw new Error(`no run is waiting on approval '${approvalId}'`);
    }

    suspensions.markResumed(suspension.runId);

    return this.execute(
      {
        sessionId: suspension.sessionId,
        principal: suspension.principal,
        trigger: 'resume',
        runId: suspension.runId,
      },
      {
        stepIndex: suspension.stepIndex,
        spend: suspension.spend,
        approval:
          approval.state === 'granted'
            ? { id: approvalId, tool: approval.tool, input: approval.input, stepId: approval.stepId }
            : null,
        denialText:
          approval.state === 'granted'
            ? null
            : `The user declined to approve '${approval.tool}'. It was NOT run` +
              (approval.reason !== null ? `, because: ${approval.reason}` : '.') +
              ' Do not try it again; tell them what you were attempting and ask how to proceed.',
      },
    );
  }

  /**
   * Run, then tell the observer about it.
   *
   * The memory write path hangs off this hook (§22.5: learning happens
   * *after* the run, never on the user's critical path). The hook is
   * deliberately fire-and-forget and swallowing: a failure to remember must
   * never turn a successful answer into a failed one.
   */
  async run(request: RunRequest, resume?: ResumeState): Promise<RunOutcome> {
    const outcome = await this.execute(request, resume);
    const observer = this.deps.observer;
    if (observer !== undefined) {
      void Promise.resolve()
        .then(() => observer.afterRun(outcome, request))
        .catch((error: unknown) => {
          this.deps.logger.warn('memory observation failed', { error: String(error) });
        });
    }
    return outcome;
  }

  private async execute(request: RunRequest, resume?: ResumeState): Promise<RunOutcome> {
    const { events, clock, ids, logger, model } = this.deps;
    const limits: RunLimits = { ...DEFAULT_LIMITS, ...request.limits };

    const runId = request.runId ?? ids.ulid();
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    const startedAt = clock.now();
    const runStarted = resume !== undefined ? null : events.append({
      type: 'run.started',
      payload: {
        trigger: request.trigger,
      ...(request.triggerDetail === undefined ? {} : { triggerDetail: request.triggerDetail }),
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

    // A resumed run continues under the budget it had already spent. A run
    // that suspends is not a run that reset — otherwise "ask for approval"
    // becomes a way to get a fresh allowance.
    const caps: CapState = {
      toolCalls: 0,
      steps: resume?.stepIndex ?? 0,
      tokens: resume?.spend.tokens ?? 0,
      costMicros: resume?.spend.costMicros ?? 0,
      startedAt,
    };
    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const recentCalls: string[] = [];
    /** The in-flight stream's totals, so a cancellation keeps its partial text. */
    let partial: StreamTotals | null = null;
    /** Tool results from the previous step, fed back as the next input. */
    const observations: Observation[] = [];
    /** §23 allows one compaction retry per run, and exactly one. */
    let overflowRetried = false;
    /**
     * Decision 042: the constitution gets exactly one rewrite per run.
     *
     * `pendingRevision` is the instruction to inject into the next
     * step; `revisionsSpent` makes sure a model that cannot satisfy an
     * article twice does not get a third go — a governance loop that
     * can run away is worse than the thing it is checking.
     */
    let pendingRevision: string | null = null;
    let revisionsSpent = 0;
    let contextScale = 1;

    // The approved call runs FIRST, at the step that asked for it, so its
    // idempotency key is unchanged and an effect already committed is
    // recognised rather than repeated.
    if (resume?.approval != null && this.deps.invoker !== undefined) {
      const approved = resume.approval;
      observations.push(
        await this.deps.invoker.invoke({
          callId: `resume-${approved.id}`,
          tool: approved.tool,
          input: approved.input,
          runId,
          stepId: approved.stepId,
          sessionId: request.sessionId,
          principal: request.principal,
          effectiveTrust: 'USER',
          approvalId: approved.id,
          signal: controller.signal,
        }),
      );
    }
    if (resume?.denialText != null) {
      observations.push({
        tool: 'system',
        callId: 'approval-denied',
        ok: false,
        text: resume.denialText,
        truncated: false,
        artifacts: [],
        trust: 'USER',
      });
    }

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
        // Computed, never assumed. This is the value the whole capability
        // gate hangs off, so it is derived from the log every step rather
        // than carried forward in a variable someone can forget to lower.
        const gathered = this.gather(request, runId, observations);
        const effectiveTrust = gathered.effectiveTrust;
        events.append({
          type: 'step.started',
          payload: { index: stepIndex, effectiveTrust },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          // A resumed run's steps are caused by the resumption, which the
          // log already records; there is no new run.started to point at.
          ...(runStarted !== null ? { causationId: runStarted.id } : {}),
          correlationId: runId,
        });

        /* ── assemble (pure) ───────────────────────────────────────────── */
        const assemblyStarted = performance.now();
        const context = this.assembleFrom(
          request,
          gathered.snapshot,
          effectiveTrust,
          observations,
          limits,
          contextScale,
        );
        // Observations are NOT cleared here: an overflow retry re-assembles
        // this same step, and clearing early would drop the tool results the
        // step exists to react to. They are cleared once the model replies.

        // §21: logged every single turn. Months later this is how "why did
        // it say that?" gets answered — the digest identifies the exact
        // context, the blocks say what was in it, the drops say what was not.
        events.append({
          type: 'context.assembled',
          payload: {
            digest: context.digest,
            totalTokens: context.totalTokens,
            blocks: context.blocks,
            drops: context.evictions.map((eviction) => ({
              block: eviction.block,
              dropped: 1,
              reason: `${eviction.reason}:${eviction.id}`,
            })),
            policyVersion: context.policyVersion,
            window: this.windowFor(limits, contextScale),
          },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          correlationId: runId,
        });

        // §32's budget for this stage, measured rather than assumed (M9).
        // A timing is state: it is how the system behaved at an instant,
        // and the honest place for it is the same log as everything else.
        events.append({
          type: 'perf.sampled',
          payload: {
            stage: 'context.assembly',
            ms: Math.round((performance.now() - assemblyStarted) * 1000) / 1000,
            detail: `${context.totalTokens} tokens`,
          },
          principal: 'system',
          trust: 'SYSTEM',
          sessionId: request.sessionId,
          runId,
          stepId,
          correlationId: runId,
        });

        // Which recalled facts actually reached the model (M9). The recall
        // event says what was *found*; this says what was *used*, and the
        // hit rate is the ratio of the two. Counting only the first is how
        // a retrieval system convinces itself it is working.
        if (gathered.snapshot.memories.length > 0) {
          events.append({
            type: 'memory.used',
            payload: {
              factIds: gathered.snapshot.memories.map((m) => m.id),
              offered: gathered.snapshot.memories.length,
            },
            principal: request.principal,
            trust: 'SYSTEM',
            sessionId: request.sessionId,
            runId,
            stepId,
            correlationId: runId,
          });
        }

        // §25: what the constitution's checks are allowed to know about this
        // step. Assembled here, from the same snapshot the context came
        // from, and carried *on the request* — the governance gate wraps the
        // provider, so the request is the only thing it can see, and an
        // out-of-band channel would be a second way to reach a model
        // ungoverned.
        const snapshot = gathered.snapshot;
        const governance: GovernanceHints = {
          runId,
          stepId,
          userMessage: [...snapshot.conversation].reverse().find((t) => t.role === 'user')?.content ?? '',
          previousAgentTurn:
            [...snapshot.conversation].reverse().find((t) => t.role === 'assistant')?.content ?? '',
          toolsCompleted: observations.filter((o) => o.ok).map((o) => o.tool),
          // The outbox read model M7 and M8 owed (M9). The action-claim
          // check can now distinguish "a tool ran" from "an effect was
          // actually committed", which is the difference between the agent
          // having tried to send the email and having sent it.
          effectsCommitted: this.deps.committedEffects?.(runId) ?? [],
          recalled: snapshot.memories.map((m) => ({
            id: m.id,
            label: m.text,
            confidence: m.confidence,
          })),
          // Filled since M9. A recalled fact that disagrees with the turn
          // is the single most valuable thing a long memory produces, and
          // a check that can never see one is decoration.
          contradicting: snapshot.memories
            .filter((m) => (m.contradiction ?? 0) > 0 || m.status === 'disputed')
            .map((m) => ({ id: m.id, label: m.text, confidence: m.confidence })),
          factCount: snapshot.profile.factCount,
          hasIdentityCard: snapshot.identity !== null,
          constraints: snapshot.constraints.map((c) => ({ id: c.id, text: c.text })),
          foreign: snapshot.foreign.map((f) => f.text),
          trust: effectiveTrust,
          modelConfigured: this.deps.modelConfigured ?? true,
        };

        const modelRequest: ModelRequest = {
          model: model.id,
          messages:
            pendingRevision === null
              ? context.messages
              : [
                  ...context.messages,
                  { role: 'system' as const, content: pendingRevision, trust: 'SYSTEM' as const },
                ],
          governance: { ...governance, revisionAttempt: revisionsSpent },
          ...(context.tools.length > 0 ? { tools: context.tools } : {}),
          maxOutputTokens: Math.min(limits.maxTokens - caps.tokens, 4096),
        };

        const contextDigest = context.digest;
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
          /* ── overflow → compact → exactly one retry (§23) ───────────── */
          //
          // Exactly one, and at a smaller budget. An overflow that survives
          // a compaction pass is a bug in the budget, and retrying a bug in
          // a loop is how a provider bill reaches four hundred dollars
          // overnight. The second one fails as data.
          if (totals.error.kind === 'context-overflow' && !overflowRetried) {
            overflowRetried = true;
            contextScale = OVERFLOW_RETRY_SCALE;
            const compacted = this.compactor.compact(request.sessionId, true);
            this.snapshotter.invalidate(request.sessionId);
            logger.warn('context overflow: compacted and retrying once', {
              runId,
              compacted: compacted !== null,
              scale: contextScale,
            });
            events.append({
              type: 'model.failed',
              payload: {
                provider: model.id,
                kind: 'context_overflow',
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
            continue;
          }

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

        /* ── the constitution asked for a rewrite (decision 042) ───────── */
        //
        // The gate withheld the draft and said so. Spending the step
        // here rather than inside the gate is the whole point: this
        // retry costs steps, tokens and wall-clock from the same caps
        // as any other, and it honours the cancellation signal. A
        // provider that re-entered itself would escape all three.
        if (totals.finishReason === 'revision-required') {
          this.appendStepFinished(request, runId, stepId, stepIndex, 'revision', latencyMs);
          caps.steps++;

          // The budget check comes before the fetch, not after it. Reading
          // the port consumes the stashed instruction, so asking for one we
          // have already decided not to use throws it away — and on a
          // shared map that is somebody else's rewrite.
          const instruction = revisionsSpent === 0
            ? this.deps.revisionInstruction?.(runId, stepId) ?? null
            : null;
          if (instruction !== null) {
            pendingRevision = instruction;
            revisionsSpent += 1;
            observations.length = 0;
            continue;
          }

          // No instruction to work from, or the one rewrite is already
          // spent. Withholding silently would leave the user staring
          // at nothing, which is the failure this decision exists to
          // avoid, so say what happened.
          const stuck =
            'I stopped myself from sending that, because it conflicted with my ' +
            'constitution, and I was not able to rewrite it in the attempt I allow ' +
            'myself. Tell me how you want to proceed.';
          this.appendAgentMessage(request, runId, stepId, stuck, 'revision-failed');
          return this.finish(
            runId, request, 'revision-failed', caps, stuck, inputTokens, outputTokens,
          );
        }

        // A rewrite that got through clears the slate: the instruction
        // must not ride along into an unrelated later step.
        pendingRevision = null;

        finalText += totals.text;
        observations.length = 0;

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

          if (loop === 'abort') {
            logger.warn('aborting run: the model is repeating a tool call', { runId });
            this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
            caps.steps++;
            if (finalText.length > 0) {
              this.appendAgentMessage(request, runId, stepId, finalText, 'loop-detected');
            }
            return this.finish(
              runId, request, 'loop-detected', caps, finalText, inputTokens, outputTokens,
            );
          }

          // Without an invoker there is nothing to execute, and saying so is
          // better than looping forever waiting for results that will never
          // come. With one, the calls run and the loop continues.
          if (this.deps.invoker === undefined) {
            this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
            caps.steps++;
            if (finalText.length > 0) {
              this.appendAgentMessage(request, runId, stepId, finalText, 'tools-unavailable');
            }
            return this.finish(
              runId, request, 'tools-unavailable', caps, finalText, inputTokens, outputTokens,
            );
          }

          for (const call of totals.toolCalls) {
            // Effective trust is recomputed per call over the causal
            // closure, so a FOREIGN result from the previous step drags this
            // one down whatever the model claims.
            const observation = await this.deps.invoker.invoke({
              callId: call.id,
              tool: call.name,
              input: call.input,
              runId,
              stepId,
              principal: request.principal,
              effectiveTrust,
              signal: controller.signal,
            });
            caps.toolCalls++;
            observations.push(observation);

            /* ── a human is needed: park the run and let go (§19) ──────── */
            if (observation.awaitingApproval !== undefined) {
              const suspensions = this.deps.suspensions;
              if (suspensions === undefined) {
                // No parking space configured. Stopping honestly beats
                // spinning on a call that can never proceed.
                this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
                caps.steps++;
                return this.finish(
                  runId, request, 'denied', caps, finalText, inputTokens, outputTokens,
                );
              }

              this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
              caps.steps++;

              suspensions.suspend({
                runId,
                sessionId: request.sessionId,
                principal: request.principal,
                // The step that ASKED, so the resumed run re-enters here and
                // the approved call keeps its idempotency key.
                stepId,
                stepIndex: caps.steps,
                reason: 'approval',
                resumeOn: observation.awaitingApproval.approvalId,
                spend: {
                  ...ZERO_SPEND(),
                  steps: caps.steps,
                  tokens: caps.tokens,
                  costMicros: caps.costMicros,
                  wallMs: clock.now() - caps.startedAt,
                },
              });

              // Returning here is the point. No timer, no open promise, no
              // in-memory continuation: a process killed now loses nothing,
              // because it is holding nothing.
              this.controllers.delete(runId);
              return {
                runId,
                status: 'suspended',
                reason: 'stop',
                steps: caps.steps,
                text: finalText,
                inputTokens,
                outputTokens,
                costMicros: caps.costMicros,
              };
            }
          }

          if (loop === 'correct') {
            // §26: a corrective observation before aborting. The model gets
            // one chance to notice it is going in circles.
            observations.push({
              tool: 'system',
              callId: 'loop-warning',
              ok: false,
              truncated: false,
              artifacts: [],
              trust: 'SYSTEM',
              text:
                'You have now made the same tool call three times with identical arguments. ' +
                'Repeating it will not produce a different answer. Either use the results you ' +
                'already have, try a materially different approach, or tell the user what is ' +
                'blocking you.',
            });
          }

          this.appendStepFinished(request, runId, stepId, stepIndex, 'tools', latencyMs);
          caps.steps++;
          continue;
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
    if (caps.toolCalls >= limits.maxToolCalls) return 'tool-cap';

    // The daily ledger (§19): a run can be inside every per-run limit and
    // still be the four-hundredth retry of a $2 mistake. Checked between
    // steps, where stopping is clean.
    const ledger = this.deps.dailyLedger;
    if (ledger !== undefined) {
      const breach = ledger.admits(this.deps.dailyBudget ?? DEFAULT_DAILY_BUDGET);
      if (breach !== null) return 'daily-cap';
    }
    return null;
  }

  private gather(request: RunRequest, runId: string, observations: readonly Observation[]): Gathered {
    const foreign: ForeignItem[] = observations
      .filter((observation) => observation.trust === 'FOREIGN')
      .map((observation) => ({
        id: observation.callId,
        source: observation.tool,
        text: observation.text,
        trust: observation.trust,
      }));

    return this.snapshotter.gather({
      principal: request.principal,
      sessionId: request.sessionId,
      runId,
      trigger: request.trigger,
      ...(request.triggerDetail === undefined ? {} : { triggerDetail: request.triggerDetail }),
      degradation: (this.deps.degradation?.() ?? 'L0') as 'L0' | 'L1' | 'L2' | 'L3',
      observations: foreign,
      fallbackTrust: request.trigger === 'user' ? 'USER' : 'SYSTEM',
    });
  }

  private assembleFrom(
    request: RunRequest,
    snapshot: StateSnapshot,
    trust: TrustLevel,
    observations: readonly Observation[],
    limits: RunLimits,
    scale: number,
  ): AssembledContext {
    // Tool results that are *not* FOREIGN belong in the conversation, not in
    // the untrusted-material block: a note the agent wrote to itself is not
    // hearsay, and fencing it would teach the model to distrust its own work.
    const conversation = [...snapshot.conversation];
    for (const observation of observations) {
      if (observation.trust === 'FOREIGN') continue;
      conversation.push({
        role: 'user',
        content: `[result of ${observation.tool}]\n${observation.text}`,
        trust: observation.trust,
        id: observation.callId,
      });
    }

    const window = this.windowFor(limits, scale);
    const policy = {
      ...this.contextPolicy,
      window,
      reserveForOutput: 0,
      fence: this.deps.fence ?? true,
      ...(scale < 1 ? { version: `${this.contextPolicy.version}-reduced` } : {}),
    };

    const system = request.system ?? DEFAULT_SYSTEM;
    return assembleContext({
      principal: request.principal,
      sessionId: request.sessionId,
      trust,
      now: this.deps.clock.now(),
      policy,
      countTokens: (text: string) => this.tokens.count(text),
      snapshot: {
        ...snapshot,
        // A caller-supplied system prompt is kernel text for this run.
        kernel: snapshot.kernel === '' ? system : snapshot.kernel,
        conversation,
      },
    });
  }

  /** One definition of the window, used by the assembler and the log. */
  private windowFor(limits: { maxContextTokens: number }, scale: number): number {
    return Math.max(512, Math.floor(limits.maxContextTokens * scale));
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
    outcome: 'text' | 'tools' | 'finish' | 'error' | 'revision',
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
    case 'context-overflow':
      return 'context_overflow';
    case 'timeout':
    case 'overloaded':
    case 'server':
    case 'network':
      return 'transient';
    default:
      return 'transient';
  }
}
