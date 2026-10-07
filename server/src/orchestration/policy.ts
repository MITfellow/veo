import type { CryptoPort } from '../substrate/ports.js';
import type { TrustLevel } from '../substrate/events/types.js';
import { evaluateRuleOfTwo, type HumanApproval } from '../capability/ruleoftwo.js';
import { ToolError, type AnyTool } from '../capability/tools/contract.js';
import { checkCapabilities, type ToolRegistry } from '../capability/tools/registry.js';
import { evaluateAutonomy, type Rung } from './autonomy.js';
import type { Budget, BudgetBreach } from './budget.js';
import type { Approvals } from './approvals.js';
import type { RunAudit } from './audit.js';
import { planPermits, stepSeal, type SealedPlan } from './plan.js';
import type { RunOptions, StepResult } from './types.js';

/**
 * May this step happen, and on whose say-so?
 *
 * Split out of the executor deliberately: this file answers *whether*, and
 * the executor answers *how*. Keeping them apart means the entire policy
 * chain can be read top to bottom without the machinery of invoking a
 * tool in between — and the order of that chain is the most important
 * thing in the milestone.
 *
 *   1. the plan (§22) · 2. the budget (§27) · 3. the Rule of Two (§19)
 *   4. capabilities and the trust floor (§20, §29) · 5. autonomy (§30)
 *
 * The Rule of Two runs before the capability check because it refuses the
 * *shape* of an operation rather than adjudicating permissions: a step
 * holding all three properties is wrong even if every capability was
 * granted. Autonomy runs last of the five because it is the only one whose
 * answer can be "ask the human" rather than "no".
 */

export interface PolicyDeps {
  crypto: CryptoPort;
  registry: ToolRegistry;
  now: () => number;
  approvals: Approvals;
}

export class StepPolicy {
  constructor(private readonly deps: PolicyDeps) {}

  /**
   * Every policy, in order. Returns null when the step may proceed.
   *
   * One function rather than five call sites, because a check that can be
   * forgotten at one of five call sites will be.
   */
  gate(
    runId: string,
    plan: SealedPlan,
    index: number,
    options: RunOptions,
    budget: Budget,
    audit: RunAudit,
  ): StepResult | null {
    const step = plan.steps[index];
    if (step === undefined) return { index, tool: '(none)', status: 'failed', detail: 'no such step' };

    const allowed = planPermits(plan, index, this.deps.crypto);
    if (!allowed.ok) return this.refuse(audit, index, step.tool, 'observe', allowed.code, allowed.message);

    const stepBudget = budget.spend('steps', this.deps.now());
    if (stepBudget !== null) return this.breach(audit, index, step.tool, stepBudget);

    let tool: AnyTool;
    try {
      tool = this.deps.registry.get(step.tool);
    } catch (error) {
      const message = error instanceof ToolError ? error.message : String(error);
      return this.refuse(audit, index, step.tool, 'observe', 'unknown_tool', message);
    }

    const trustInScope: TrustLevel[] = [options.inputTrust];
    const descriptor = {
      trustInScope,
      capabilities: tool.capabilities,
      sensitivity: tool.sensitivity,
      effect: tool.effect,
      ...(this.approvalFor(plan, index) ?? {}),
    };

    const ruleOfTwo = evaluateRuleOfTwo(descriptor);
    if (!ruleOfTwo.allowed) {
      audit.ruleOfTwoBlocked({ ...ruleOfTwo.triple }, tool.capabilities, ruleOfTwo.reason);
      return this.refuse(audit, index, tool.name, tool.tier, 'rule_of_two', ruleOfTwo.reason);
    }

    const capability = checkCapabilities(tool, options.inputTrust, options.granted, options.earnedAutonomy);
    if (!capability.allowed) return this.refuse(audit, index, tool.name, tool.tier, 'capability', capability.reason);

    return this.autonomyGate(runId, plan, index, tool, options, budget, capability.autonomyCap, audit);
  }

  private autonomyGate(
    runId: string,
    plan: SealedPlan,
    index: number,
    tool: AnyTool,
    options: RunOptions,
    budget: Budget,
    autonomyCap: number,
    audit: RunAudit,
  ): StepResult | null {
    const rung = Math.min(plan.rung, autonomyCap) as Rung;
    const verdict = evaluateAutonomy({
      rung,
      tier: tool.tier,
      irreversible: tool.irreversible === true,
      trustInScope: [options.inputTrust],
    });
    audit.policy(
      tool.name,
      verdict.permitted ? 'allowed' : 'supervised',
      verdict.permitted ? 'autonomy_ok' : 'needs_approval',
      rung,
    );
    if (verdict.permitted) return null;

    const seal = stepSeal(plan, index, this.deps.crypto);
    const settled = this.settledApproval(seal);
    if (settled === 'granted') return null;
    if (settled === 'denied') {
      audit.stepFinished(index, tool.name, tool.tier, 'denied');
      return { index, tool: tool.name, status: 'denied', detail: 'you declined this step', code: 'approval_denied' };
    }

    const breach = budget.spend('approvals', this.deps.now());
    if (breach !== null) return this.breach(audit, index, tool.name, breach);

    return this.ask(runId, plan, index, tool, options, seal, verdict.needs, verdict.reason);
  }

  /** What has already been decided about this exact step, if anything. */
  private settledApproval(seal: string): 'granted' | 'denied' | null {
    const existing = this.deps.approvals.all().find((a) => a.step_seal === seal);
    if (existing === undefined) return null;
    if (this.deps.approvals.authorises(existing.id, seal)) return 'granted';
    return existing.status === 'denied' ? 'denied' : null;
  }

  /**
   * Stop and ask.
   *
   * Not a failure: a question. This is the difference between a system you
   * turn off and one you learn to trust.
   */
  private ask(
    runId: string,
    plan: SealedPlan,
    index: number,
    tool: AnyTool,
    options: RunOptions,
    seal: string,
    needs: Rung,
    reason: string,
  ): StepResult {
    const request = this.deps.approvals.request({
      runId,
      stepSeal: seal,
      tool: tool.name,
      action: plan.steps[index]?.why ?? tool.summary,
      needs,
      triple: {
        untrustedInput: options.inputTrust === 'FOREIGN',
        sensitiveAccess: tool.sensitivity !== 'none',
        externalChange: tool.effect === 'external',
      },
    });
    return {
      index, tool: tool.name, status: 'awaiting-approval',
      detail: reason, code: 'needs_approval', approvalId: request.approvalId,
    };
  }

  /** A granted approval, in the shape the Rule of Two gate wants. */
  private approvalFor(plan: SealedPlan, index: number): { humanApproval: HumanApproval } | null {
    const seal = stepSeal(plan, index, this.deps.crypto);
    const row = this.deps.approvals.all().find((a) => a.step_seal === seal && a.status === 'granted');
    if (row === undefined || !this.deps.approvals.authorises(row.id, seal)) return null;
    return {
      humanApproval: {
        approvalId: row.id,
        // The row stores the triple that was *shown*; granting it is
        // acknowledging it. A partial acknowledgement is impossible
        // because the prompt is not partial.
        acknowledged: { untrustedInput: true, sensitiveAccess: true, externalChange: true },
      },
    };
  }

  // ─────────────────────────────────────────────────────── bookkeeping

  refuse(
    audit: RunAudit,
    index: number,
    tool: string,
    tier: 'observe' | 'interact' | 'effect',
    code: string,
    message: string,
  ): StepResult {
    audit.denied(tool, tier, index, code, message);
    return { index, tool, status: 'denied', detail: message.slice(0, 200), code };
  }

  breach(audit: RunAudit, index: number, tool: string, breach: BudgetBreach): StepResult {
    audit.budgetExceeded(breach);
    return { index, tool, status: 'failed', detail: breach.message, code: 'budget' };
  }
}
