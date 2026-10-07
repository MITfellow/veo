import type { TrustLevel } from '../substrate/events/types.js';
import type { Capability } from '../security/trust.js';
import type { BudgetLimits } from './budget.js';
import type { SealedPlan } from './plan.js';
import type { Rung } from './autonomy.js';

/** The executor's vocabulary, shared by the policy chain and the runner. */

export type StepStatus = 'succeeded' | 'failed' | 'denied' | 'skipped' | 'awaiting-approval' | 'proposed';

export interface StepResult {
  index: number;
  tool: string;
  status: StepStatus;
  /** Bounded. Never the tool's own prose (decision 010). */
  detail: string;
  code?: string | undefined;
  approvalId?: string | undefined;
  output?: unknown;
}

export interface RunResult {
  runId: string;
  plan: SealedPlan;
  status: 'finished' | 'failed' | 'cancelled' | 'awaiting-approval' | 'proposed';
  stopReason: string;
  /**
   * The rung the run actually operated at, which is not always the rung it
   * was given: untrusted content in scope caps it (§20.2). A caller that
   * cannot see this cannot tell a quiet capping from a configured L1.
   */
  effectiveRung: Rung;
  /** True when the trust floor lowered the rung below what was asked for. */
  autonomyCapped: boolean;
  steps: StepResult[];
}

export interface RunOptions {
  /** Trust of what seeded this run. Caps everything downstream (§20). */
  inputTrust: TrustLevel;
  granted: readonly Capability[];
  earnedAutonomy: number;
  budget?: Partial<BudgetLimits> | undefined;
  sessionId?: string | undefined;
  /** Report what would happen and change nothing. */
  dryRun?: boolean | undefined;
}
