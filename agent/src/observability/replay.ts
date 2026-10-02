/**
 * §30's replay, and §34.5: *`replay <runId>` reproduces any historical run
 * with zero context diff.*
 *
 * The point is not to re-run the agent. It is to answer one question —
 * **has cognition drifted?** — by rebuilding the context a historical run
 * would assemble *today* and diffing it against the context that was
 * actually assembled at the time. A zero diff means a refactor of the
 * assembler, the templates, the memory ranker or the constitution
 * renderer changed nothing a model would have seen. A non-zero diff names
 * the block that moved.
 *
 * This is why the whole context pipeline is a pure function of a
 * snapshot: the snapshot is reconstructible from the log, so the replay
 * needs no model, no tools and no network. Nothing is re-executed and
 * nothing is written — a command that mutated the log it was auditing
 * would be a contradiction.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { PayloadOf } from '../substrate/events/types.js';
import { traceOf, type Trace } from './trace.js';

export interface BlockDiff {
  block: string;
  was: { tokens: number; items: number } | null;
  now: { tokens: number; items: number } | null;
  tokenDelta: number;
}

export interface ReplayResult {
  runId: string;
  found: boolean;
  /** The run as it happened. */
  trace: Trace | null;
  recorded: {
    digest: string;
    totalTokens: number;
    policyVersion: string;
    blocks: Array<{ name: string; tokens: number; items: number }>;
  } | null;
  /** What re-assembly produces today, when a re-assembler is supplied. */
  rebuilt: {
    digest: string;
    totalTokens: number;
    policyVersion: string;
    blocks: Array<{ name: string; tokens: number; items: number }>;
  } | null;
  /** Empty means "zero context diff" — §34.5's phrase, literally. */
  diffs: BlockDiff[];
  /** Policy or template version changes, which explain most real diffs. */
  versionChanged: boolean;
  notes: string[];
}

export interface Reassembler {
  /**
   * Rebuild the context for a step of a historical run, using today's
   * code. Returns null when the run's snapshot cannot be reconstructed —
   * for instance because the session's messages were shredded, which is
   * a correct outcome, not a failure.
   */
  (runId: string): ReplayResult['rebuilt'];
}

export function replayRun(
  events: EventLog,
  runId: string,
  reassemble?: Reassembler,
): ReplayResult {
  const all = events.read({ runId });
  if (all.length === 0) {
    return {
      runId,
      found: false,
      trace: null,
      recorded: null,
      rebuilt: null,
      diffs: [],
      versionChanged: false,
      notes: [`no run with id ${runId} — check the id, or the log it should be in`],
    };
  }

  const trace = traceOf(runId, all);
  const assemblies = all.filter((e) => e.type === 'context.assembled');
  // The **first** assembly, not the last. Replay rebuilds the state the
  // run started from; later steps in the same run have the run's own
  // tool calls and partial answers in their conversation block, and
  // comparing against those would report drift on every multi-step run
  // in the log. The later assemblies are still in the trace.
  const first = assemblies[0];
  const recorded =
    first === undefined
      ? null
      : (() => {
          const p = first.payload as PayloadOf<'context.assembled'>;
          return {
            digest: p.digest,
            totalTokens: p.totalTokens,
            policyVersion: p.policyVersion,
            blocks: p.blocks.map((b) => ({ name: b.name, tokens: b.tokens, items: b.items })),
          };
        })();

  const notes: string[] = [];
  if (assemblies.length > 1) {
    notes.push(
      `this run assembled ${assemblies.length} contexts (one per step); the diff is against ` +
        'the first, which is the only one that is a function of the state before the run',
    );
  }
  if (trace?.status === 'suspended') {
    notes.push('this run is suspended — replayed up to the suspension, which is all there is');
  }
  if (recorded === null) {
    notes.push('the run never assembled a context, so there is nothing to compare');
  }

  const rebuilt = reassemble?.(runId) ?? null;
  if (reassemble === undefined) {
    notes.push('no re-assembler supplied: showing the recorded context only');
  } else if (rebuilt === null) {
    notes.push(
      'the snapshot could not be rebuilt — expected when the session was ' +
        'forgotten or shredded, which is the system working',
    );
  }

  const diffs: BlockDiff[] = [];
  if (recorded !== null && rebuilt !== null) {
    const names = new Set([
      ...recorded.blocks.map((b) => b.name),
      ...rebuilt.blocks.map((b) => b.name),
    ]);
    for (const name of names) {
      const was = recorded.blocks.find((b) => b.name === name) ?? null;
      const now = rebuilt.blocks.find((b) => b.name === name) ?? null;
      if (was?.tokens === now?.tokens && was?.items === now?.items) continue;
      diffs.push({
        block: name,
        was: was === null ? null : { tokens: was.tokens, items: was.items },
        now: now === null ? null : { tokens: now.tokens, items: now.items },
        tokenDelta: (now?.tokens ?? 0) - (was?.tokens ?? 0),
      });
    }
  }

  const versionChanged =
    recorded !== null && rebuilt !== null && recorded.policyVersion !== rebuilt.policyVersion;
  if (versionChanged) {
    notes.push(
      `the policy/template version moved: ${recorded!.policyVersion} → ${rebuilt!.policyVersion}. ` +
        'A diff below is a deliberate behavioural change and should be reviewed as one.',
    );
  }
  if (recorded !== null && rebuilt !== null && diffs.length === 0) {
    notes.push('zero context diff — cognition has not drifted for this run');
  }

  return { runId, found: true, trace, recorded, rebuilt, diffs, versionChanged, notes };
}

/** The command's output, for a terminal. */
export function renderReplay(result: ReplayResult): string {
  const out: string[] = [];
  out.push(`replay ${result.runId}`);
  if (!result.found) {
    out.push(`  ${result.notes[0] ?? 'not found'}`);
    return out.join('\n');
  }

  out.push(
    `  ${result.trace?.status ?? 'unknown'} · ${result.trace?.totals.steps ?? 0} step(s) · ` +
      `${result.trace?.totals.tokens ?? 0} tokens`,
  );
  out.push('');

  if (result.recorded !== null) {
    out.push(`  recorded  ${result.recorded.digest}  ${result.recorded.policyVersion}`);
  }
  if (result.rebuilt !== null) {
    out.push(`  rebuilt   ${result.rebuilt.digest}  ${result.rebuilt.policyVersion}`);
  }

  if (result.diffs.length > 0) {
    out.push('');
    out.push('  context diff');
    for (const diff of result.diffs) {
      const was = diff.was === null ? 'absent' : `${diff.was.tokens}t/${diff.was.items}i`;
      const now = diff.now === null ? 'absent' : `${diff.now.tokens}t/${diff.now.items}i`;
      out.push(
        `    ${diff.block.padEnd(14)} ${was.padEnd(12)} → ${now.padEnd(12)} ` +
          `(${diff.tokenDelta >= 0 ? '+' : ''}${diff.tokenDelta} tokens)`,
      );
    }
  }

  out.push('');
  for (const note of result.notes) out.push(`  ${note}`);
  return out.join('\n');
}
