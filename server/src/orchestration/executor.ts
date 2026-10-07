import type { CryptoPort, Storage } from '../substrate/ports.js';
import type { EventLog } from '../substrate/events/log.js';
import type { AnyTool, ToolContext, ToolOutcome } from '../capability/tools/contract.js';
import type { ToolRegistry } from '../capability/tools/registry.js';
import { Budget } from './budget.js';
import { Approvals } from './approvals.js';
import { RunAudit } from './audit.js';
import { StepPolicy } from './policy.js';
import { effectiveRung } from './autonomy.js';
import { sealPlan, stepSeal, type PlanSpec, type SealedPlan } from './plan.js';
import type { RunOptions, RunResult, StepResult } from './types.js';

/**
 * The executor.
 *
 * Everything the platform knows about whether an action may happen is
 * applied here, in one order, for every tool. There is no second path:
 * a structural test asserts no module outside this directory imports a
 * tool implementation.
 *
 * The order is not arbitrary.
 *
 *   1. **the plan** — was this agreed in advance? (§22)
 *   2. **the budget** — is there room? (§27)
 *   3. **the Rule of Two** — is the *shape* of this allowed at all? (§19)
 *   4. **capabilities and the trust floor** — may this caller hold it? (§20, §29)
 *   5. **autonomy** — may it run unattended, or must we ask? (§30)
 *   6. **the call**, with its audit trail either side (decision 010)
 *
 * The Rule of Two runs before the capability check because it refuses the
 * *shape* of an operation rather than adjudicating permissions — a step
 * that holds all three properties is wrong even if every capability was
 * granted. And autonomy runs last of the checks because it is the only one
 * whose answer can be "ask the human" rather than "no".
 */

export interface ExecutorDeps {
  storage: Storage;
  events: EventLog;
  crypto: CryptoPort;
  registry: ToolRegistry;
  now: () => number;
  nextId: () => string;
}

export class Executor {
  private readonly approvals: Approvals;
  private readonly policy: StepPolicy;

  constructor(private readonly deps: ExecutorDeps) {
    this.approvals = new Approvals({
      storage: deps.storage, events: deps.events, now: deps.now, nextId: deps.nextId,
    });
    this.policy = new StepPolicy({
      crypto: deps.crypto, registry: deps.registry, now: deps.now, approvals: this.approvals,
    });
  }

  approvalService(): Approvals {
    return this.approvals;
  }

  /**
   * Run a plan.
   *
   * `run.started` and `run.planned` are both appended before the first tool
   * is touched, so the log shows what the agent agreed to do *before* it
   * saw anything that might have wanted it to do something else.
   */
  async run(spec: PlanSpec, options: RunOptions): Promise<RunResult> {
    const runId = this.deps.nextId();
    const plan = sealPlan(spec, this.deps.crypto, this.deps.now());
    const budget = new Budget(options.budget ?? {}, this.deps.now());

    const reach = effectiveRung(plan.rung, [options.inputTrust]);
    const audit = new RunAudit(this.deps, runId, options.inputTrust);
    audit.started(plan.goal, options.sessionId);
    audit.planned({
      goal: plan.goal,
      allowedKinds: [...plan.allowedTools],
      maxSteps: plan.maxSteps,
      allowedOrigins: [],
      carriesPrivateData: plan.carriesPrivateData,
      autonomy: plan.rung,
      seal: plan.seal,
    });

    // L0 is propose-only. Nothing executes, and that is the product
    // working, not the product failing.
    if (plan.rung === 0) return this.propose(runId, plan, audit, reach);

    const steps: StepResult[] = [];
    for (let index = 0; index < plan.steps.length; index++) {
      const result = await this.step(runId, plan, index, options, budget, audit);
      steps.push(result);
      if (result.status !== 'succeeded') return this.stop(runId, plan, steps, result, audit, reach);
    }
    audit.ended('run.finished', 'done', steps.length);
    return { runId, plan, steps, status: 'finished', stopReason: 'done', ...rungOf(reach) };
  }

  private propose(runId: string, plan: SealedPlan, audit: RunAudit, reach: Reach): RunResult {
    const steps: StepResult[] = plan.steps.map((s, index) => ({
      index, tool: s.tool, status: 'proposed' as const, detail: s.why.slice(0, 200),
    }));
    audit.ended('run.finished', 'done', 0);
    return {
      runId, plan, steps, status: 'proposed',
      stopReason: 'Autonomy is L0: the plan is proposed and nothing was run.',
      ...rungOf(reach),
    };
  }

  // ───────────────────────────────────────────────────────────── one step

  private async step(
    runId: string,
    plan: SealedPlan,
    index: number,
    options: RunOptions,
    budget: Budget,
    audit: RunAudit,
  ): Promise<StepResult> {
    const step = plan.steps[index];
    if (step === undefined) return { index, tool: '(none)', status: 'failed', detail: 'no such step', code: 'not_in_plan' };

    const gate = this.policy.gate(runId, plan, index, options, budget, audit);
    if (gate !== null) return gate;

    const tool = this.deps.registry.get(step.tool);
    audit.stepStarted(index, tool.name, tool.tier);

    const parsed = tool.input.safeParse(step.input);
    if (!parsed.success) {
      // A malformed step is a planning error, not a tool failure. It is
      // refused before `tool.invoked` would claim the call really happened.
      return this.policy.refuse(audit, index, tool.name, tool.tier, 'invalid_input',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
    }

    const spent = budget.spend('toolCalls', this.deps.now());
    if (spent !== null) return this.policy.breach(audit, index, tool.name, spent);

    return this.invoke(runId, plan, index, tool, parsed.data, options, audit);
  }

  // ─────────────────────────────────────────────────────────── the call

  private async invoke(
    runId: string,
    plan: SealedPlan,
    index: number,
    tool: AnyTool,
    input: unknown,
    options: RunOptions,
    audit: RunAudit,
  ): Promise<StepResult> {
    const callId = this.deps.nextId();
    const ctx: ToolContext = {
      now: this.deps.now(),
      inputTrust: options.inputTrust,
      runId,
      stepIndex: index,
      idempotencyKey: stepSeal(plan, index, this.deps.crypto),
      dryRun: options.dryRun === true,
    };

    if (ctx.dryRun) return this.dryRun(index, callId, tool, input, ctx, audit);

    audit.invoked(callId, tool.name, plan.steps[index]?.why ?? tool.summary, tool.tier);

    let outcome: ToolOutcome<unknown>;
    try {
      outcome = await tool.run(input as never, ctx);
    } catch (error) {
      outcome = { ok: false, code: 'threw', message: error instanceof Error ? error.message : String(error) };
    }

    if (outcome.ok) {
      audit.succeeded(callId, tool.name, outcome.summary);
      audit.stepFinished(index, tool.name, tool.tier, 'succeeded');
      return { index, tool: tool.name, status: 'succeeded', detail: outcome.summary.slice(0, 200), output: outcome.output };
    }

    audit.failed(callId, tool.name, outcome.code, outcome.message);
    audit.stepFinished(index, tool.name, tool.tier, 'failed');
    return { index, tool: tool.name, status: 'failed', detail: outcome.message.slice(0, 200), code: outcome.code };
  }

  /**
   * A dry run emits `tool.dryrun` and never `tool.invoked`.
   *
   * The whole point is that nothing happened, and a log in which the two
   * are the same event cannot answer "did it actually send it".
   */
  private dryRun(
    index: number,
    callId: string,
    tool: AnyTool,
    input: unknown,
    ctx: ToolContext,
    audit: RunAudit,
  ): Promise<StepResult> {
    const preview = tool.preview?.(input as never, ctx) ?? `${tool.name} (${tool.tier}, ${tool.effect})`;
    audit.dryRun(callId, tool.name, preview, tool.tier);
    audit.stepFinished(index, tool.name, tool.tier, 'skipped');
    return Promise.resolve({ index, tool: tool.name, status: 'succeeded', detail: `would: ${preview.slice(0, 180)}` });
  }

  private stop(
    runId: string, plan: SealedPlan, steps: StepResult[], last: StepResult, audit: RunAudit, reach: Reach,
  ): RunResult {
    const executed = steps.filter((s) => s.status === 'succeeded').length;
    if (last.status === 'awaiting-approval') {
      // Not terminal on purpose: the run is paused, and the log says so
      // without claiming it ended.
      return { runId, plan, steps, status: 'awaiting-approval', stopReason: last.detail, ...rungOf(reach) };
    }
    // A step the user declined is a cancellation, not a failure. They did
    // not break anything; they answered the question.
    const cancelled = last.code === 'approval_denied';
    audit.ended(cancelled ? 'run.cancelled' : 'run.failed', last.detail, executed);
    return {
      runId, plan, steps, status: cancelled ? 'cancelled' : 'failed', stopReason: last.detail, ...rungOf(reach),
    };
  }
}

type Reach = ReturnType<typeof effectiveRung>;

/** One place that turns the ladder's answer into the shape a caller reads. */
function rungOf(reach: Reach): { effectiveRung: Reach['rung']; autonomyCapped: boolean } {
  return { effectiveRung: reach.rung, autonomyCapped: reach.capped };
}

export type { RunOptions, RunResult, StepResult } from './types.js';
