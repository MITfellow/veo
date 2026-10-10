/**
 * §19 — completion gates.
 *
 * "Nothing is done because the agent says so." A run is complete when
 * evidence outside the agent says it is, and the evidence is checked by
 * code that has no opinion about how hard the agent tried.
 *
 * Two rules give this its teeth.
 *
 * **A gate defaults to FAIL.** An unevaluated gate, a gate whose check
 * threw, a gate nobody registered — all fail. The alternative, where a
 * missing check means "fine", converts every bug in the checking code
 * into a false claim of success, which is the exact failure this
 * mechanism exists to prevent.
 *
 * **A failure is named.** `FAILURE_MODES` is the closed list from §19;
 * a gate must report which one it hit. "It didn't work" is not a result
 * a person can act on, and an unnameable failure is usually an
 * unexamined one.
 */

/** The sixteen named ways a run fails. Closed; a seventeenth is a decision. */
export const FAILURE_MODES = [
  'no_evidence',              // the agent asserted success and produced nothing
  'evidence_unverifiable',    // it produced something nobody can check
  'wrong_artifact',           // it produced the wrong kind of thing
  'partial_completion',       // some steps done, the goal not met
  'silent_truncation',        // output was cut and the cut was not reported
  'stale_data',               // answered from material older than the question allows
  'unresolved_ambiguity',     // proceeded on a guess it should have raised
  'hallucinated_fact',        // asserted something no source supports
  'unapproved_effect',        // changed the world without the approval it needed
  'duplicate_effect',         // did the same external thing twice
  'budget_exhausted',         // ran out of steps, time, or tool calls
  'tool_unavailable',         // a required capability was not there
  'permission_denied',        // policy refused and the run could not route around it
  'loop_detected',            // repeated the same state without progress
  'contradiction',            // the result contradicts something already known
  'abandoned',                // stopped without concluding either way
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export interface GateResult {
  name: string;
  passed: boolean;
  /** Required when `passed` is false. */
  failure?: FailureMode | undefined;
  detail: string;
}

/**
 * A gate is a question about evidence, not about intent.
 *
 * It receives only what can be observed after the fact. It is given no
 * access to the plan's own notion of success, because the plan is the
 * thing on trial.
 */
export interface Gate {
  name: string;
  /** What this gate is checking, in a sentence shown on failure. */
  asks: string;
  check(evidence: Evidence): GateResult;
}

/**
 * Everything a gate is allowed to look at.
 *
 * Deliberately external: events that were appended, effects that were
 * committed, artifacts that exist. No field here can be set by the
 * agent asserting something about itself.
 */
export interface Evidence {
  /** Event types appended during the run, in order. */
  events: readonly string[];
  /** Outbox entries this run created, with their settled state. */
  effects: ReadonlyArray<{ key: string; status: string; tool: string }>;
  /** Artifacts the run claims to have produced, and whether they exist. */
  artifacts: ReadonlyArray<{ id: string; exists: boolean; bytes: number }>;
  /** Approvals granted, by step seal. */
  approvals: readonly string[];
  /** Steps that required an approval, by step seal. */
  requiredApprovals: readonly string[];
  /** Budget consumed against what was allowed. */
  budget: { steps: number; maxSteps: number; wallClockMs: number; maxWallClockMs: number };
  /** Did the run reach a conclusion it is willing to state? */
  concluded: boolean;
  /** Was any output truncated, and was that reported? */
  truncated: boolean;
  truncationReported: boolean;
}

function fail(name: string, failure: FailureMode, detail: string): GateResult {
  return { name, passed: false, failure, detail };
}

function pass(name: string, detail: string): GateResult {
  return { name, passed: true, detail };
}

/** The standard gates. Every run is held to all of them. */
export const STANDARD_GATES: readonly Gate[] = [
  {
    name: 'produced-something',
    asks: 'Is there any evidence outside the agent that work happened?',
    check: (e) =>
      e.events.length === 0 && e.effects.length === 0 && e.artifacts.length === 0
        ? fail('produced-something', 'no_evidence', 'The run appended no events, committed no effects and produced no artifacts.')
        : pass('produced-something', `${e.events.length} events, ${e.effects.length} effects, ${e.artifacts.length} artifacts.`),
  },
  {
    name: 'artifacts-exist',
    asks: 'Does every artifact the run claims actually exist?',
    check: (e) => {
      const missing = e.artifacts.filter((a) => !a.exists || a.bytes === 0);
      return missing.length === 0
        ? pass('artifacts-exist', `${e.artifacts.length} artifacts verified.`)
        : fail('artifacts-exist', 'evidence_unverifiable', `Claimed but absent or empty: ${missing.map((a) => a.id).join(', ')}.`);
    },
  },
  {
    name: 'effects-settled',
    asks: 'Is every external effect accounted for?',
    check: (e) => {
      const open = e.effects.filter((f) => f.status === 'intended' || f.status === 'needs_attention');
      return open.length === 0
        ? pass('effects-settled', 'Every effect is settled.')
        : fail('effects-settled', 'partial_completion', `${open.length} effect(s) unsettled: ${open.map((f) => f.tool).join(', ')}.`);
    },
  },
  {
    name: 'no-duplicate-effects',
    asks: 'Did anything happen twice?',
    check: (e) => {
      const seen = new Set<string>();
      const dupes = e.effects.filter((f) => (seen.has(f.key) ? true : (seen.add(f.key), false)));
      return dupes.length === 0
        ? pass('no-duplicate-effects', 'No effect key appears twice.')
        : fail('no-duplicate-effects', 'duplicate_effect', `Repeated: ${dupes.map((f) => f.tool).join(', ')}.`);
    },
  },
  {
    name: 'approvals-honoured',
    asks: 'Did everything that needed approval get it, before it ran?',
    check: (e) => {
      const missing = e.requiredApprovals.filter((seal) => !e.approvals.includes(seal));
      return missing.length === 0
        ? pass('approvals-honoured', `${e.requiredApprovals.length} required, all granted.`)
        : fail('approvals-honoured', 'unapproved_effect', `${missing.length} step(s) ran without the approval they required.`);
    },
  },
  {
    name: 'within-budget',
    asks: 'Did the run finish inside what it was allowed?',
    check: (e) =>
      e.budget.steps > e.budget.maxSteps || e.budget.wallClockMs > e.budget.maxWallClockMs
        ? fail('within-budget', 'budget_exhausted', `${e.budget.steps}/${e.budget.maxSteps} steps, ${e.budget.wallClockMs}/${e.budget.maxWallClockMs} ms.`)
        : pass('within-budget', `${e.budget.steps}/${e.budget.maxSteps} steps.`),
  },
  {
    name: 'truncation-reported',
    asks: 'If anything was cut short, was that said out loud?',
    check: (e) =>
      e.truncated && !e.truncationReported
        ? fail('truncation-reported', 'silent_truncation', 'Output was truncated and the truncation was not reported.')
        : pass('truncation-reported', e.truncated ? 'Truncated, and reported.' : 'Nothing was truncated.'),
  },
  {
    name: 'concluded',
    asks: 'Did the run reach a conclusion, either way?',
    check: (e) =>
      e.concluded ? pass('concluded', 'The run concluded.') : fail('concluded', 'abandoned', 'The run stopped without stating an outcome.'),
  },
];

export interface GateReport {
  passed: boolean;
  results: readonly GateResult[];
  failures: readonly FailureMode[];
  /** One line for a person. */
  summary: string;
}

/**
 * Run every gate. A thrown check is a failed gate, never a skipped one.
 *
 * `gates` is a parameter so a caller can add gates, never remove them:
 * the standard set is the default and a caller that passes its own is
 * doing so on top of, not instead of — which the executor enforces by
 * concatenating rather than replacing.
 */
export function evaluateGates(evidence: Evidence, gates: readonly Gate[] = STANDARD_GATES): GateReport {
  const results = gates.map((gate) => {
    try {
      return gate.check(evidence);
    } catch (error) {
      // A gate that cannot decide has decided: fail.
      return fail(gate.name, 'evidence_unverifiable', `The check itself failed: ${error instanceof Error ? error.message : 'unknown'}.`);
    }
  });

  const failed = results.filter((r) => !r.passed);
  const failures = failed.flatMap((r) => (r.failure === undefined ? [] : [r.failure]));
  return {
    passed: failed.length === 0,
    results,
    failures,
    summary: failed.length === 0
      ? `All ${results.length} gates passed.`
      : `${failed.length} of ${results.length} gates failed: ${failed.map((r) => `${r.name} (${r.failure ?? 'unnamed'})`).join(', ')}.`,
  };
}

/** The evidence of a run that did nothing. Every gate must reject it. */
export const NO_EVIDENCE: Evidence = {
  events: [], effects: [], artifacts: [], approvals: [], requiredApprovals: [],
  budget: { steps: 0, maxSteps: 20, wallClockMs: 0, maxWallClockMs: 120_000 },
  concluded: false, truncated: false, truncationReported: false,
};
