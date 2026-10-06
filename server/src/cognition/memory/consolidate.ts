import type { Fact, MemoryStore } from '../../capability/memory/store.js';
import { runJob, type RunOptions } from '../registry.js';

/**
 * Consolidation: tidying what is believed, without deciding anything that
 * is not ours to decide.
 *
 * The job proposes; this applies. The split is deliberate — a model will
 * one day produce the proposal, and the thing that writes to the log must
 * not be the thing a model controls. Two rules are enforced here, outside
 * the job, precisely because they must hold whichever strategy ran:
 *
 *   1. a **pinned** fact is never superseded. A human said it matters.
 *   2. a contradiction is **raised**, never resolved. Two different values
 *      for the same thing is either a change or an error, and nothing in
 *      the facts themselves can tell you which.
 */

export interface ConsolidationReport {
  superseded: Array<{ factId: string; supersededBy: string; why: string }>;
  conflicts: Array<{ subject: string; predicate: string; factIds: string[] }>;
  /** Proposals refused here, with the reason. */
  refused: Array<{ factId: string; why: string }>;
  strategy: string;
}

interface ConsolidateOut {
  keep: string[];
  supersede: Array<{ factId: string; supersededBy: string; why: string }>;
  conflicts: Array<{ subject: string; predicate: string; factIds: string[] }>;
}

export interface ConsolidateDeps {
  memory: MemoryStore;
  now: () => number;
  options: RunOptions;
}

/**
 * Why this proposal may not be applied, or null if it may.
 *
 * Separate from the loop so the two rules that must hold whichever
 * strategy produced the proposal are a short, readable list rather than
 * three `continue`s buried in a body.
 */
function refuse(
  proposal: { factId: string; supersededBy: string },
  byId: Map<string, { pinned: boolean }>,
): string | null {
  const fact = byId.get(proposal.factId);
  if (fact === undefined) return 'not a live fact';
  if (fact.pinned) return 'pinned by a human; consolidation does not overrule a pin';
  if (!byId.has(proposal.supersededBy)) return `replacement ${proposal.supersededBy} is not a live fact`;
  return null;
}

/** Ask the job what it would do. It proposes; the caller decides. */
function propose(live: Fact[], deps: ConsolidateDeps) {
  return runJob<ConsolidateOut>(
    'memory.consolidate',
    {
      facts: live.map((f) => ({
        factId: f.id,
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence,
        assertedAt: f.recordedAt,
      })),
    },
    { inputTrust: 'DERIVED', now: deps.now() },
    deps.options,
  );
}

export async function consolidate(
  deps: ConsolidateDeps,
  scope: { subject?: string | undefined } = {},
): Promise<ConsolidationReport> {
  const live = deps.memory.asOf({
    ...(scope.subject === undefined ? {} : { subject: scope.subject }),
    maxSensitivity: 'secret',
    limit: 2000,
  });

  const result = await propose(live, deps);

  const byId = new Map(live.map((f) => [f.id, f]));
  const superseded: ConsolidationReport['superseded'] = [];
  const refused: ConsolidationReport['refused'] = [];

  for (const proposal of result.output.supersede) {
    const objection = refuse(proposal, byId);
    if (objection !== null) {
      refused.push({ factId: proposal.factId, why: objection });
      continue;
    }
    // Recorded as a supersession of the *existing* winner rather than by
    // asserting a copy: duplicating the row would make the second run of
    // consolidation find new work, and idempotence is the property that
    // makes this safe to schedule later.
    deps.memory.supersedeBy(proposal.factId, proposal.supersededBy, proposal.why);
    superseded.push(proposal);
  }

  return {
    superseded,
    conflicts: result.output.conflicts,
    refused,
    strategy: result.strategy,
  };
}
