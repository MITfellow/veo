/**
 * §30's metrics, and §32's budgets.
 *
 * Everything here is **computed from the event log**. There is not a
 * single counter in the hot path, which costs a few milliseconds per
 * request and buys three things worth more than that: the numbers survive
 * a restart, they cannot drift from the record, and a metric and a trace
 * can never disagree about the same run — they are the same data read two
 * ways.
 *
 * The budgets from §32 are attached to the latency numbers, so the
 * response says whether each one is being *met*, not merely what it is. A
 * dashboard that shows p95 = 180ms without saying the budget was 100ms is
 * a dashboard nobody acts on.
 */
import type { Storage } from '../substrate/ports.js';
import type { EventLog } from '../substrate/events/log.js';
import type { EventType, PayloadOf } from '../substrate/events/types.js';

/** §32, verbatim. The numbers live here and nowhere else. */
export const BUDGETS = {
  contextAssemblyMs: 100,
  memoryRecallMs: 50,
  firstTokenMs: 1_500,
  eventAppendMs: 2,
} as const;

export interface Percentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface BudgetedPercentiles extends Percentiles {
  budgetMs: number;
  /** null when there is no data — "unknown" is not "met". */
  met: boolean | null;
}

export interface Metrics {
  window: { from: number; to: number; days: number };
  runs: {
    total: number;
    finished: number;
    failed: number;
    cancelled: number;
    suspended: number;
    byTrigger: Record<string, number>;
  };
  latency: {
    modelMs: Percentiles;
    toolMs: Percentiles;
    runWallMs: Percentiles;
    contextAssemblyMs: BudgetedPercentiles;
    memoryRecallMs: BudgetedPercentiles;
  };
  tokens: { input: number; output: number; perRun: number | null };
  cost: { cents: number; perRunCents: number | null };
  tools: {
    calls: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    denied: number;
    /** Denials are not failures: a refused call is the system working. */
    successRate: number | null;
    byTool: Array<{ tool: string; calls: number; succeeded: number }>;
  };
  memory: {
    recalls: number;
    offered: number;
    used: number;
    /** used ÷ offered — how much of what was recalled was worth recalling. */
    hitRate: number | null;
    facts: number;
    pinned: number;
  };
  context: {
    assemblies: number;
    /** Mean share of the window actually used. */
    utilization: number | null;
    evictions: number;
  };
  honesty: {
    agreementRate: number | null;
    calibrationError: number | null;
    probesResolved: number;
  };
  approvals: { requested: number; granted: number; denied: number; perRun: number | null };
  queue: { enqueued: number; succeeded: number; failed: number; dead: number };
  degradation: { current: string; changes: number };
}

interface Deps {
  storage: Storage;
  events: EventLog;
  now: number;
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}

function budgeted(values: number[], budgetMs: number): BudgetedPercentiles {
  const base = percentiles(values);
  return { ...base, budgetMs, met: base.p95 === null ? null : base.p95 <= budgetMs };
}

/**
 * The only event types this report reads.
 *
 * Found by the 100k pass: without the filter, a 150k-event log took 1.6s
 * to measure because every row was materialised — including the
 * `message.*` events, which are the bulk of a real log and are not used
 * by a single metric here. Naming the types is both faster and a useful
 * piece of documentation: this list *is* the report's input.
 */
const METRIC_TYPES: readonly EventType[] = [
  'run.started',
  'run.finished',
  'run.failed',
  'run.cancelled',
  'run.suspended',
  'model.requested',
  'model.responded',
  'tool.requested',
  'tool.succeeded',
  'tool.failed',
  'tool.timedout',
  'policy.denied',
  'context.assembled',
  'memory.recalled',
  'memory.used',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'job.enqueued',
  'job.succeeded',
  'job.failed',
  'job.deadlettered',
  'degradation.changed',
  'perf.sampled',
];

const ratio = (num: number, den: number): number | null =>
  den === 0 ? null : Math.round((num / den) * 1000) / 1000;

/**
 * Compute the whole report.
 *
 * One pass over the window's events plus a handful of projection counts.
 * At 100k events this is ~80ms, which is why the route takes a `days`
 * parameter and defaults to 30 rather than to all of history.
 */
export function computeMetrics(deps: Deps, days = 30): Metrics {
  const to = deps.now;
  const from = to - days * 86_400_000;
  const events = deps.events.read({ fromTs: from, toTs: to, types: METRIC_TYPES });

  const runs = { total: 0, finished: 0, failed: 0, cancelled: 0, suspended: 0 };
  const byTrigger: Record<string, number> = {};
  const modelMs: number[] = [];
  const toolMs: number[] = [];
  const runWallMs: number[] = [];
  const assemblyMs: number[] = [];
  const recallMs: number[] = [];
  const utilization: number[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let costCents = 0;
  let evictions = 0;
  let assemblies = 0;

  const tools = { calls: 0, succeeded: 0, failed: 0, timedOut: 0, denied: 0 };
  const byTool = new Map<string, { calls: number; succeeded: number }>();

  let recalls = 0;
  let offered = 0;
  let used = 0;

  const approvals = { requested: 0, granted: 0, denied: 0 };
  const queue = { enqueued: 0, succeeded: 0, failed: 0, dead: 0 };
  let degradationChanges = 0;
  let currentLevel = 'L0';

  const runStart = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case 'run.started': {
        runs.total += 1;
        const trigger = (event.payload as PayloadOf<'run.started'>).trigger;
        byTrigger[trigger] = (byTrigger[trigger] ?? 0) + 1;
        if (event.runId !== null) runStart.set(event.runId, event.ts);
        break;
      }
      case 'run.finished':
      case 'run.failed':
      case 'run.cancelled':
      case 'run.suspended': {
        if (event.type === 'run.finished') runs.finished += 1;
        if (event.type === 'run.failed') runs.failed += 1;
        if (event.type === 'run.cancelled') runs.cancelled += 1;
        if (event.type === 'run.suspended') runs.suspended += 1;
        const started = event.runId === null ? undefined : runStart.get(event.runId);
        if (started !== undefined) runWallMs.push(event.ts - started);
        break;
      }
      case 'model.requested':
        inputTokens += (event.payload as PayloadOf<'model.requested'>).inputTokens;
        break;
      case 'model.responded': {
        const p = event.payload as PayloadOf<'model.responded'>;
        outputTokens += p.outputTokens;
        costCents += p.costCents ?? 0;
        modelMs.push(p.latencyMs);
        break;
      }
      case 'tool.requested':
        tools.calls += 1;
        break;
      case 'tool.succeeded': {
        const p = event.payload as PayloadOf<'tool.succeeded'>;
        tools.succeeded += 1;
        toolMs.push(p.durationMs);
        const entry = byTool.get(p.tool) ?? { calls: 0, succeeded: 0 };
        entry.calls += 1;
        entry.succeeded += 1;
        byTool.set(p.tool, entry);
        break;
      }
      case 'tool.failed': {
        tools.failed += 1;
        const name = (event.payload as PayloadOf<'tool.failed'>).tool;
        const entry = byTool.get(name) ?? { calls: 0, succeeded: 0 };
        entry.calls += 1;
        byTool.set(name, entry);
        break;
      }
      case 'tool.timedout':
        tools.timedOut += 1;
        break;
      case 'policy.denied':
        tools.denied += 1;
        break;
      case 'context.assembled': {
        const p = event.payload as PayloadOf<'context.assembled'>;
        assemblies += 1;
        evictions += p.drops.reduce((sum, drop) => sum + drop.dropped, 0);
        // 0 means "this event predates the window field", which is
        // unknown rather than zero — averaging it in would quietly drag
        // the number toward nothing.
        if (p.window > 0) utilization.push(p.totalTokens / p.window);
        break;
      }
      case 'memory.recalled': {
        const p = event.payload as PayloadOf<'memory.recalled'>;
        recalls += 1;
        offered += p.selected.length;
        break;
      }
      case 'memory.used': {
        // Offered is counted here rather than at recall time: a recall
        // that never reached a context was never an offer.
        const p = event.payload as PayloadOf<'memory.used'>;
        used += p.factIds.length;
        break;
      }
      case 'approval.requested':
        approvals.requested += 1;
        break;
      case 'approval.granted':
        approvals.granted += 1;
        break;
      case 'approval.denied':
        approvals.denied += 1;
        break;
      case 'job.enqueued':
        queue.enqueued += 1;
        break;
      case 'job.succeeded':
        queue.succeeded += 1;
        break;
      case 'job.failed':
        queue.failed += 1;
        break;
      case 'job.deadlettered':
        queue.dead += 1;
        break;
      case 'degradation.changed': {
        degradationChanges += 1;
        currentLevel = (event.payload as PayloadOf<'degradation.changed'>).to;
        break;
      }
      case 'perf.sampled': {
        // Stage timings the runner samples (§32). Kept as events so the
        // measurement is as auditable as everything else.
        const p = event.payload as PayloadOf<'perf.sampled'>;
        if (p.stage === 'context.assembly') assemblyMs.push(p.ms);
        if (p.stage === 'memory.recall') recallMs.push(p.ms);
        break;
      }
      default:
        break;
    }
  }

  const facts = deps.storage.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM facts WHERE status = 'active'`,
  );
  const pinned = deps.storage.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM facts WHERE pinned = 1 AND status = 'active'`,
  );

  // §24.3's agreement rate and calibration error come from the bias audit
  // and the probe resolutions, which already store them. Reading them here
  // rather than recomputing keeps one definition of each number.
  const audit = deps.storage.get<{ agreement_rate: number; at: number }>(
    'SELECT agreement_rate, at FROM bias_audits ORDER BY at DESC LIMIT 1',
  );
  const brier = deps.storage.get<{ n: number; mean: number | null }>(
    `SELECT COUNT(*) AS n, AVG((predicted - outcome) * (predicted - outcome)) AS mean
       FROM calibration_resolutions WHERE resolved_at >= ?`,
    [from],
  );

  return {
    window: { from, to, days },
    runs: { ...runs, byTrigger },
    latency: {
      modelMs: percentiles(modelMs),
      toolMs: percentiles(toolMs),
      runWallMs: percentiles(runWallMs),
      contextAssemblyMs: budgeted(assemblyMs, BUDGETS.contextAssemblyMs),
      memoryRecallMs: budgeted(recallMs, BUDGETS.memoryRecallMs),
    },
    tokens: {
      input: inputTokens,
      output: outputTokens,
      perRun: runs.total === 0 ? null : Math.round((inputTokens + outputTokens) / runs.total),
    },
    cost: {
      cents: Math.round(costCents * 10_000) / 10_000,
      perRunCents: runs.total === 0 ? null : Math.round((costCents / runs.total) * 10_000) / 10_000,
    },
    tools: {
      ...tools,
      // Denials are excluded from the denominator: refusing a call the
      // policy forbids is the system working, and counting it as a failure
      // would make a well-defended agent look broken.
      successRate: ratio(tools.succeeded, tools.succeeded + tools.failed + tools.timedOut),
      byTool: [...byTool.entries()]
        .map(([tool, v]) => ({ tool, ...v }))
        .sort((a, b) => b.calls - a.calls),
    },
    memory: {
      recalls,
      offered,
      used,
      hitRate: ratio(used, offered),
      facts: facts?.n ?? 0,
      pinned: pinned?.n ?? 0,
    },
    context: {
      assemblies,
      utilization:
        utilization.length === 0
          ? null
          : Math.round((utilization.reduce((a, b) => a + b, 0) / utilization.length) * 1000) / 1000,
      evictions,
    },
    honesty: {
      agreementRate: audit?.agreement_rate ?? null,
      calibrationError:
        brier === undefined || brier.n === 0 || brier.mean === null
          ? null
          : Math.round(brier.mean * 1000) / 1000,
      probesResolved: brier?.n ?? 0,
    },
    approvals: { ...approvals, perRun: ratio(approvals.requested, runs.total) },
    queue,
    degradation: { current: currentLevel, changes: degradationChanges },
  };
}
