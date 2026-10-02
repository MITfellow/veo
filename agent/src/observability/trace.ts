/**
 * §30's trace: why did it say that?
 *
 * Invariant 15 is "no unexplained output", and §34.13 turns that into a
 * testable claim: *for any sentence the agent ever produced, a stored
 * trace explains the exact context, memories, trust levels and tool
 * results behind it.* This file is that trace.
 *
 * Two things about how it is built.
 *
 * **It reads the log and nothing else.** No trace table, no sampling, no
 * retention window. A run from two years ago renders exactly as well as
 * one from two seconds ago, because the only input is the events that
 * were written while it happened. That is also why the renderer lives in
 * its own module rather than in the HTTP layer: the replay command and
 * the chaos suite both need the same view, and a second implementation
 * would eventually disagree with the first.
 *
 * **It renders for a person.** `?format=json` keeps the machine shape;
 * `?format=text` produces something a human can read at 2am without a
 * JSON viewer, because the question "why did it say that?" is usually
 * asked in a hurry by someone who is already annoyed.
 */
import type { Event } from '../substrate/events/envelope.js';
import type { PayloadOf } from '../substrate/events/types.js';

export interface TraceBlock {
  name: string;
  tokens: number;
  items: number;
}

export interface TraceModelCall {
  at: number;
  provider: string;
  model: string;
  contextDigest: string;
  inputTokens: number;
  outputTokens: number | null;
  latencyMs: number | null;
  costCents: number | null;
  finishReason: string | null;
  failed: string | null;
}

export interface TraceToolCall {
  at: number;
  tool: string;
  stepId: string | null;
  durationMs: number | null;
  resultTrust: string | null;
  outcome: 'succeeded' | 'failed' | 'timedout' | 'denied' | 'requested';
  detail: string;
}

export interface TraceRecall {
  at: number;
  query: string;
  candidates: number;
  selected: string[];
  /** The scoring components §22.5 blends, as they were on the day. */
  weights: Record<string, number>;
}

export interface Trace {
  runId: string;
  sessionId: string | null;
  principal: string;
  trigger: string | null;
  startedAt: number | null;
  endedAt: number | null;
  status: 'finished' | 'failed' | 'cancelled' | 'suspended' | 'running';
  reason: string | null;
  /** The context as assembled, per block, with the policy in force. */
  context: {
    digest: string;
    totalTokens: number;
    policyVersion: string;
    blocks: TraceBlock[];
    drops: Array<{ block: string; dropped: number; reason: string }>;
  } | null;
  modelCalls: TraceModelCall[];
  toolCalls: TraceToolCall[];
  recalls: TraceRecall[];
  approvals: Array<{ at: number; tool: string; risk: string; decision: string | null }>;
  effects: Array<{ at: number; key: string; state: string; summary: string }>;
  governance: Array<{ at: number; articleId: string; verdict: string; detail: string }>;
  degradation: Array<{ at: number; level: string; reason: string }>;
  totals: { steps: number; tokens: number; costCents: number; toolMs: number; wallMs: number };
}

/**
 * Build the trace for one run from its events.
 *
 * The caller passes the events; this function does no I/O, which is what
 * lets the replay command build a trace for a run it has reconstructed
 * rather than one it has read.
 */
export function traceOf(runId: string, events: readonly Event[]): Trace | null {
  if (events.length === 0) return null;

  const trace: Trace = {
    runId,
    sessionId: null,
    principal: events[0]!.principal,
    trigger: null,
    startedAt: null,
    endedAt: null,
    status: 'running',
    reason: null,
    context: null,
    modelCalls: [],
    toolCalls: [],
    recalls: [],
    approvals: [],
    effects: [],
    governance: [],
    degradation: [],
    totals: { steps: 0, tokens: 0, costCents: 0, toolMs: 0, wallMs: 0 },
  };

  /** Pending model request, waiting for its response or failure. */
  let openCall: TraceModelCall | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        const p = event.payload as PayloadOf<'run.started'>;
        trace.startedAt = event.ts;
        trace.sessionId = event.sessionId ?? p.sessionId;
        trace.trigger = p.trigger;
        break;
      }
      case 'context.assembled': {
        const p = event.payload as PayloadOf<'context.assembled'>;
        // The *last* assembly wins: a run that overflowed, compacted and
        // retried assembled twice, and the second one is what the model
        // actually saw. The first is still in the events list below.
        trace.context = {
          digest: p.digest,
          totalTokens: p.totalTokens,
          policyVersion: p.policyVersion,
          blocks: p.blocks.map((b) => ({ name: b.name, tokens: b.tokens, items: b.items })),
          drops: p.drops.map((d) => ({ block: d.block, dropped: d.dropped, reason: d.reason })),
        };
        break;
      }
      case 'model.requested': {
        const p = event.payload as PayloadOf<'model.requested'>;
        openCall = {
          at: event.ts,
          provider: p.provider,
          model: p.model,
          contextDigest: p.contextDigest,
          inputTokens: p.inputTokens,
          outputTokens: null,
          latencyMs: null,
          costCents: null,
          finishReason: null,
          failed: null,
        };
        trace.modelCalls.push(openCall);
        trace.totals.tokens += p.inputTokens;
        break;
      }
      case 'model.responded': {
        const p = event.payload as PayloadOf<'model.responded'>;
        if (openCall !== null) {
          openCall.outputTokens = p.outputTokens;
          openCall.latencyMs = p.latencyMs;
          openCall.costCents = p.costCents ?? 0;
          openCall.finishReason = p.finishReason;
        }
        trace.totals.tokens += p.outputTokens;
        trace.totals.costCents += p.costCents ?? 0;
        openCall = null;
        break;
      }
      case 'model.failed': {
        const p = event.payload as PayloadOf<'model.failed'>;
        if (openCall !== null) openCall.failed = `${p.kind}: ${p.message}`;
        openCall = null;
        break;
      }
      case 'tool.requested': {
        const p = event.payload as PayloadOf<'tool.requested'>;
        trace.toolCalls.push({
          at: event.ts,
          tool: p.tool,
          stepId: event.stepId,
          durationMs: null,
          resultTrust: null,
          outcome: 'requested',
          detail: '',
        });
        break;
      }
      case 'tool.succeeded': {
        const p = event.payload as PayloadOf<'tool.succeeded'>;
        settle(trace, event.stepId, p.tool, {
          outcome: 'succeeded',
          durationMs: p.durationMs,
          resultTrust: p.resultTrust,
          detail: p.artifacts.length > 0 ? `${p.artifacts.length} artifact(s)` : '',
        });
        trace.totals.toolMs += p.durationMs;
        break;
      }
      case 'tool.failed': {
        const p = event.payload as PayloadOf<'tool.failed'>;
        settle(trace, event.stepId, p.tool, {
          outcome: 'failed',
          detail: `${p.kind}: ${p.message}`,
        });
        break;
      }
      case 'tool.timedout': {
        const p = event.payload as PayloadOf<'tool.timedout'>;
        settle(trace, event.stepId, p.tool, {
          outcome: 'timedout',
          detail: `after ${p.timeoutMs}ms`,
        });
        break;
      }
      case 'policy.denied': {
        const p = event.payload as { tool?: string; reason?: string };
        settle(trace, event.stepId, p.tool ?? 'unknown', {
          outcome: 'denied',
          detail: p.reason ?? 'refused by policy',
        });
        break;
      }
      case 'memory.recalled': {
        const p = event.payload as PayloadOf<'memory.recalled'>;
        trace.recalls.push({
          at: event.ts,
          query: p.query,
          candidates: p.candidates,
          selected: p.selected,
          weights: p.weights,
        });
        break;
      }
      case 'approval.requested': {
        const p = event.payload as PayloadOf<'approval.requested'>;
        trace.approvals.push({ at: event.ts, tool: p.tool, risk: p.risk, decision: null });
        break;
      }
      case 'approval.granted':
      case 'approval.denied': {
        const last = trace.approvals[trace.approvals.length - 1];
        if (last !== undefined) {
          last.decision = event.type === 'approval.granted' ? 'granted' : 'denied';
        }
        break;
      }
      case 'effect.intended': {
        const p = event.payload as PayloadOf<'effect.intended'>;
        trace.effects.push({
          at: event.ts,
          key: p.idempotencyKey,
          state: 'intended',
          summary: p.summary,
        });
        break;
      }
      case 'effect.committed': {
        const p = event.payload as PayloadOf<'effect.committed'>;
        const found = trace.effects.find((e) => e.key === p.idempotencyKey);
        if (found !== undefined) found.state = 'committed';
        break;
      }
      case 'constitution.enforced': {
        const p = event.payload as PayloadOf<'constitution.enforced'>;
        for (const verdict of p.verdicts) {
          trace.governance.push({
            at: event.ts,
            articleId: verdict.articleId,
            verdict: verdict.verdict,
            detail: verdict.detail,
          });
        }
        break;
      }
      case 'run.degraded': {
        const p = event.payload as PayloadOf<'run.degraded'>;
        trace.degradation.push({ at: event.ts, level: p.level, reason: p.reason });
        break;
      }
      case 'step.started': {
        trace.totals.steps += 1;
        break;
      }
      case 'run.finished': {
        const p = event.payload as PayloadOf<'run.finished'>;
        trace.status = 'finished';
        trace.reason = p.reason;
        trace.endedAt = event.ts;
        break;
      }
      case 'run.failed': {
        const p = event.payload as PayloadOf<'run.failed'>;
        trace.status = 'failed';
        trace.reason = `${p.kind}: ${p.message}`;
        trace.endedAt = event.ts;
        break;
      }
      case 'run.cancelled': {
        trace.status = 'cancelled';
        trace.reason = 'cancelled by the user';
        trace.endedAt = event.ts;
        break;
      }
      case 'run.suspended': {
        const p = event.payload as PayloadOf<'run.suspended'>;
        trace.status = 'suspended';
        trace.reason = `waiting on ${p.reason}`;
        trace.endedAt = event.ts;
        break;
      }
      case 'run.resumed': {
        // A resumed run is running again until something else says so.
        trace.status = 'running';
        trace.reason = null;
        trace.endedAt = null;
        break;
      }
      default:
        break;
    }
  }

  if (trace.startedAt !== null) {
    trace.totals.wallMs = (trace.endedAt ?? events[events.length - 1]!.ts) - trace.startedAt;
  }
  return trace;
}

function settle(
  trace: Trace,
  stepId: string | null,
  tool: string,
  patch: Partial<TraceToolCall> & { outcome: TraceToolCall['outcome'] },
): void {
  // Match the most recent unsettled call for this tool — by step when
  // there is one, by name otherwise. Two parallel calls to the same tool
  // in the same step would be ambiguous; nothing issues them today, and
  // the step id is what disambiguates them when something does.
  for (let i = trace.toolCalls.length - 1; i >= 0; i -= 1) {
    const call = trace.toolCalls[i]!;
    if (call.outcome !== 'requested') continue;
    if (call.tool !== tool) continue;
    if (stepId !== null && call.stepId !== null && call.stepId !== stepId) continue;
    Object.assign(call, patch);
    return;
  }
  trace.toolCalls.push({
    at: 0,
    tool,
    stepId,
    durationMs: patch.durationMs ?? null,
    resultTrust: patch.resultTrust ?? null,
    outcome: patch.outcome,
    detail: patch.detail ?? '',
  });
}

/* ────────────────────────────── rendering ──────────────────────────────── */

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const ms = (n: number | null) => (n === null ? '—' : `${n}ms`);

/**
 * The trace as text. §30: "renderable as readable text."
 *
 * Deliberately not a log dump with indentation. The order is the order a
 * person asks the questions in: what was this run, what did it see, what
 * did it remember, what did it do, what did it cost.
 */
export function renderTrace(trace: Trace): string {
  const out: string[] = [];
  const when = (at: number) => new Date(at).toISOString().slice(11, 23);

  out.push(`run ${trace.runId}`);
  out.push(
    `  ${trace.status}${trace.reason === null ? '' : ` — ${trace.reason}`} · ` +
      `trigger ${trace.trigger ?? '—'} · session ${trace.sessionId ?? '—'}`,
  );
  out.push(
    `  ${trace.totals.steps} step(s) · ${trace.totals.tokens} tokens · ` +
      `${trace.totals.costCents.toFixed(4)}¢ · ${trace.totals.wallMs}ms wall`,
  );

  out.push('');
  out.push('context');
  if (trace.context === null) {
    out.push('  (none assembled — the run failed before it got that far)');
  } else {
    out.push(
      `  digest ${trace.context.digest} · ${trace.context.totalTokens} tokens · ` +
        `policy ${trace.context.policyVersion}`,
    );
    for (const block of trace.context.blocks) {
      out.push(`    ${pad(block.name, 14)} ${pad(String(block.tokens), 6)} tokens  ${block.items} item(s)`);
    }
    for (const drop of trace.context.drops) {
      out.push(`    dropped from ${drop.block}: ${drop.dropped} (${drop.reason})`);
    }
  }

  out.push('');
  out.push('memories recalled');
  if (trace.recalls.length === 0) out.push('  (none)');
  for (const recall of trace.recalls) {
    out.push(`  "${recall.query}" → ${recall.selected.length} of ${recall.candidates} candidates`);
    const weights = Object.entries(recall.weights)
      .map(([k, v]) => `${k} ${v}`)
      .join('  ');
    if (weights !== '') out.push(`    scored by: ${weights}`);
    for (const id of recall.selected) out.push(`    · ${id}`);
  }

  out.push('');
  out.push('model calls');
  if (trace.modelCalls.length === 0) out.push('  (none)');
  for (const call of trace.modelCalls) {
    out.push(
      `  ${when(call.at)} ${call.provider}/${call.model} · in ${call.inputTokens} · ` +
        `out ${call.outputTokens ?? '—'} · ${ms(call.latencyMs)} · ` +
        `${call.costCents === null ? '—' : `${call.costCents.toFixed(4)}¢`}` +
        `${call.failed === null ? '' : ` · FAILED ${call.failed}`}`,
    );
    out.push(`    context ${call.contextDigest}`);
  }

  out.push('');
  out.push('tools');
  if (trace.toolCalls.length === 0) out.push('  (none)');
  for (const call of trace.toolCalls) {
    out.push(
      `  ${when(call.at)} ${pad(call.tool, 18)} ${pad(call.outcome, 10)} ` +
        `${pad(ms(call.durationMs), 8)} trust ${call.resultTrust ?? '—'}` +
        `${call.detail === '' ? '' : ` · ${call.detail}`}`,
    );
  }

  if (trace.approvals.length > 0) {
    out.push('');
    out.push('approvals');
    for (const approval of trace.approvals) {
      out.push(
        `  ${when(approval.at)} ${approval.tool} (${approval.risk}) → ${approval.decision ?? 'pending'}`,
      );
    }
  }

  if (trace.effects.length > 0) {
    out.push('');
    out.push('external effects');
    for (const effect of trace.effects) {
      out.push(`  ${when(effect.at)} ${pad(effect.state, 11)} ${effect.summary}  [${effect.key}]`);
    }
  }

  if (trace.governance.length > 0) {
    out.push('');
    out.push('constitution');
    for (const verdict of trace.governance) {
      out.push(`  ${pad(verdict.articleId, 5)} ${pad(verdict.verdict, 13)} ${verdict.detail}`);
    }
  }

  if (trace.degradation.length > 0) {
    out.push('');
    out.push('degradation');
    for (const entry of trace.degradation) {
      out.push(`  ${when(entry.at)} ${entry.level} — ${entry.reason}`);
    }
  }

  out.push('');
  return out.join('\n');
}
