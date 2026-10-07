import type { EventLog } from '../substrate/events/log.js';
import type { TrustLevel } from '../substrate/events/types.js';
import type { Tier } from '../capability/tools/contract.js';
import type { BudgetBreach } from './budget.js';

/**
 * The run's audit trail.
 *
 * Decision 010 settled the shape: a run is a run and an action is a tool
 * call, whatever subsystem is acting. This class is that decision made
 * reusable — the executor decides *what* happened and this decides how it
 * is written down, which keeps the policy code readable and keeps every
 * event in one file where the §21 rule can be checked by eye:
 *
 * **nothing written here carries a tool's output prose.** The log replays
 * back into the privileged path, so a record is an input to it, and a
 * summary of FOREIGN content is FOREIGN (decision 007).
 */

const MAX_DETAIL = 200;
const MAX_REASON = 400;

export interface AuditDeps {
  events: EventLog;
  nextId: () => string;
}

export class RunAudit {
  constructor(
    private readonly deps: AuditDeps,
    private readonly runId: string,
    private readonly trust: TrustLevel,
  ) {}

  started(goal: string, sessionId?: string): void {
    this.deps.events.append({
      type: 'run.started', actor: 'agent', trust: this.trust, runId: this.runId,
      ...(sessionId === undefined ? {} : { sessionId }),
      payload: { goal },
    });
  }

  planned(payload: Record<string, unknown>): void {
    this.deps.events.append({
      type: 'run.planned', actor: 'agent', trust: this.trust, runId: this.runId, payload,
    });
  }

  stepStarted(stepIndex: number, tool: string, tier: Tier): void {
    this.deps.events.append({
      type: 'run.step.started', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { stepIndex, tool, tier },
    });
  }

  stepFinished(stepIndex: number, tool: string, tier: Tier, outcome: 'succeeded' | 'failed' | 'denied' | 'skipped'): void {
    this.deps.events.append({
      type: 'run.step.finished', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { stepIndex, tool, tier, outcome },
    });
  }

  invoked(callId: string, tool: string, action: string, tier: Tier): void {
    this.deps.events.append({
      type: 'tool.invoked', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { callId, tool, action: action.slice(0, MAX_DETAIL), target: null, tier },
    });
  }

  succeeded(callId: string, tool: string, detail: string): void {
    this.deps.events.append({
      type: 'tool.succeeded', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { callId, tool, detail: detail.slice(0, MAX_DETAIL) },
    });
  }

  failed(callId: string, tool: string, kind: string, detail: string): void {
    this.deps.events.append({
      type: 'tool.failed', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { callId, tool, kind, detail: detail.slice(0, MAX_DETAIL) },
    });
  }

  /**
   * A refusal still gets a call id and a pair of events.
   *
   * A denial that leaves no row is a denial nobody can audit — and that is
   * exactly the bug the 100-session browser sweep found last milestone.
   */
  denied(tool: string, tier: Tier, stepIndex: number, code: string, reason: string): string {
    const callId = this.deps.nextId();
    this.invoked(callId, tool, `step ${stepIndex}`, tier);
    this.deps.events.append({
      type: 'tool.denied', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { callId, tool, code, reason: reason.slice(0, MAX_REASON) },
    });
    this.stepFinished(stepIndex, tool, tier, 'denied');
    return callId;
  }

  dryRun(callId: string, tool: string, preview: string, tier: Tier): void {
    this.deps.events.append({
      type: 'tool.dryrun', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { callId, tool, preview: preview.slice(0, MAX_DETAIL), tier },
    });
  }

  policy(tool: string, decision: 'allowed' | 'supervised' | 'denied', code: string, rung: number): void {
    this.deps.events.append({
      type: 'policy.evaluated', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { tool, decision, code, rung },
    });
  }

  ruleOfTwoBlocked(triple: Record<string, boolean>, capabilities: readonly string[], reason: string): void {
    this.deps.events.append({
      type: 'policy.ruleoftwo-blocked', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { ...triple, capabilities: [...capabilities], reason: reason.slice(0, MAX_REASON) },
    });
  }

  /** Emitted *before* the run stops, so the log explains the stop. */
  budgetExceeded(breach: BudgetBreach): void {
    this.deps.events.append({
      type: 'budget.exceeded', actor: 'agent', trust: this.trust, runId: this.runId,
      payload: { budget: breach.budget, limit: breach.limit, reached: breach.reached },
    });
  }

  ended(kind: 'run.finished' | 'run.failed' | 'run.cancelled', reason: string, steps: number): void {
    this.deps.events.append({
      type: kind, actor: 'agent', trust: 'DERIVED', runId: this.runId,
      payload: kind === 'run.finished'
        ? { stopReason: reason.slice(0, 40), steps }
        : { reason: reason.slice(0, MAX_DETAIL), steps },
    });
  }
}
