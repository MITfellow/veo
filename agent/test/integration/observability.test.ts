/**
 * Tests 9–18 and 25–30: the trace and the metrics (§30, §34.13).
 *
 * Invariant 15 — "no unexplained output" — is only true if something can
 * be asked for the explanation. These tests ask, against the composed
 * app, for a run that really happened.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { BUDGETS } from '../../src/observability/metrics.js';

let app: StartedAgent;
let dir: string;
let base: string;
let runId: string;
let sessionId: string;

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${app.token}`,
  'content-type': 'application/json',
});

const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${base}${path}`, { headers: auth() });
  return { status: response.status, body: (await response.json()) as T };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-obs-'));
  app = await start({ port: 0, dbPath: join(dir, 'obs.db'), token: 'obs-token' });
  base = `http://127.0.0.1:${app.port}`;

  const session = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ title: 'Tracing' }),
  });
  sessionId = ((await session.json()) as { id: string }).id;

  // A real turn, including a tool call: "what time is it" reaches the
  // clock tool through the capability gate even on the offline provider.
  const sent = await fetch(`${base}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ text: 'what time is it?' }),
  });
  runId = ((await sent.json()) as { runId: string }).runId;

  // Wait for the run to finish rather than sleeping a fixed amount.
  for (let i = 0; i < 100; i += 1) {
    const { body } = await get<{ trace: { status: string } }>(`/runs/${runId}/trace`);
    if (body.trace.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the trace', () => {
  it('9. keeps its JSON shape, and gains a structured trace beside it', async () => {
    const { status, body } = await get<{
      runId: string;
      events: Array<{ type: string }>;
      steps: unknown[];
      trace: { status: string; totals: { steps: number } };
    }>(`/runs/${runId}/trace`);

    expect(status).toBe(200);
    // Nothing downstream breaks: the raw events and steps are still there.
    expect(body.runId).toBe(runId);
    expect(body.events.length).toBeGreaterThan(0);
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.trace.status).toBe('finished');
    expect(body.trace.totals.steps).toBeGreaterThan(0);
  });

  it('10–13. the text form renders the context, the model, the tools and the recalls', async () => {
    const response = await fetch(`${base}/runs/${runId}/trace?format=text`, { headers: auth() });
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();

    // 10: blocks with token counts.
    expect(text).toContain('context');
    expect(text).toMatch(/kernel\s+\d+\s+tokens/);
    expect(text).toMatch(/constitution\s+\d+\s+tokens/);
    expect(text).toMatch(/digest [0-9a-f]+ · \d+ tokens · policy /);

    // 11: model calls with tokens and cost.
    expect(text).toContain('model calls');
    expect(text).toMatch(/in \d+ · out \d+/);

    // 12: tool calls with duration and trust.
    expect(text).toContain('tools');
    expect(text).toMatch(/clock\.now\s+succeeded\s+\d+ms\s+trust \w+/);

    // 13: recalls (none on a cold install — said so, not omitted).
    expect(text).toContain('memories recalled');
  });

  it('14–15. a trace renders for a run nobody streamed, from the log alone', async () => {
    // This run was never attached to over SSE in this test, and the trace
    // is complete anyway: it is built from events, not from a buffer that
    // a listener happened to be holding.
    const { body } = await get<{ trace: { modelCalls: unknown[]; context: unknown } }>(
      `/runs/${runId}/trace`,
    );
    expect(body.trace.modelCalls.length).toBeGreaterThan(0);
    expect(body.trace.context).not.toBeNull();
  });

  it('16. an unknown run is a 404 that gives nothing away', async () => {
    const { status, body } = await get<Record<string, unknown>>('/runs/01NOPE/trace');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'no_such_run' });
  });

  it('18. §34.13: the trace explains the sentence the agent produced', async () => {
    const { body } = await get<{
      trace: {
        context: { blocks: Array<{ name: string; tokens: number }>; digest: string };
        modelCalls: Array<{ contextDigest: string; inputTokens: number }>;
        toolCalls: Array<{ tool: string; resultTrust: string | null; outcome: string }>;
        recalls: unknown[];
        governance: Array<{ articleId: string; verdict: string }>;
      };
    }>(`/runs/${runId}/trace`);

    const trace = body.trace;
    // The exact context: identified by digest, and the model call says it
    // used that digest. That link is what makes the explanation binding
    // rather than a plausible reconstruction.
    expect(trace.context.blocks.length).toBeGreaterThan(3);
    // The context block list is the *last* assembly — the one the final
    // sentence came out of — and the last model call used exactly that
    // digest. A two-step run assembles twice; the earlier digest belongs
    // to the earlier call, and both are in the log.
    expect(trace.modelCalls[trace.modelCalls.length - 1]!.contextDigest).toBe(trace.context.digest);
    for (const call of trace.modelCalls) expect(call.contextDigest).toMatch(/^[0-9a-f]{8,}$/);
    // The trust levels and tool results behind it.
    expect(
      trace.toolCalls.some((c) => c.outcome === 'succeeded' && c.resultTrust !== null),
    ).toBe(true);
    // And what the constitution made of the answer.
    expect(trace.governance.length).toBeGreaterThan(0);
  });
});

describe('the metrics', () => {
  it('25–27. every §30 metric is present, and §32 budgets say met or not', async () => {
    const { status, body } = await get<{
      runs: { total: number; byTrigger: Record<string, number> };
      latency: {
        modelMs: { count: number; p50: number | null };
        contextAssemblyMs: { budgetMs: number; met: boolean | null; p95: number | null };
        memoryRecallMs: { budgetMs: number };
      };
      tokens: { input: number; output: number };
      cost: { cents: number };
      tools: { successRate: number | null; byTool: Array<{ tool: string }> };
      memory: { hitRate: number | null; facts: number };
      context: { utilization: number | null; assemblies: number };
      honesty: { agreementRate: number | null; calibrationError: number | null };
      approvals: { requested: number };
      queue: { enqueued: number };
      degradation: { current: string };
    }>('/metrics');

    expect(status).toBe(200);
    expect(body.runs.total).toBeGreaterThan(0);
    expect(body.runs.byTrigger.user).toBeGreaterThan(0);
    expect(body.latency.modelMs.count).toBeGreaterThan(0);
    expect(body.tokens.input).toBeGreaterThan(0);
    expect(body.tools.byTool.some((t) => t.tool === 'clock.now')).toBe(true);
    expect(body.context.assemblies).toBeGreaterThan(0);

    // 27: the budget travels with the number, and it is §32's number.
    expect(body.latency.contextAssemblyMs.budgetMs).toBe(BUDGETS.contextAssemblyMs);
    expect(body.latency.memoryRecallMs.budgetMs).toBe(BUDGETS.memoryRecallMs);
    expect(body.latency.contextAssemblyMs.met).toBe(true);
    expect(body.latency.contextAssemblyMs.p95!).toBeLessThan(BUDGETS.contextAssemblyMs);
  });

  it('28. an empty window is zeros and nulls, never NaN', async () => {
    // One day's window on an install whose only run was… today. Use a
    // window that definitely contains nothing by asking for the metrics of
    // a fresh second install instead.
    const emptyDir = mkdtempSync(join(tmpdir(), 'arish-obs-empty-'));
    const empty = await start({ port: 0, dbPath: join(emptyDir, 'e.db'), token: 't' });
    const response = await fetch(`http://127.0.0.1:${empty.port}/metrics`, {
      headers: { authorization: 'Bearer t' },
    });
    const body = (await response.json()) as {
      runs: { total: number };
      tokens: { perRun: number | null };
      tools: { successRate: number | null };
      memory: { hitRate: number | null };
      honesty: { calibrationError: number | null };
    };

    expect(body.runs.total).toBe(0);
    expect(body.tokens.perRun).toBeNull();
    expect(body.tools.successRate).toBeNull();
    expect(body.memory.hitRate).toBeNull();
    expect(body.honesty.calibrationError).toBeNull();
    // Nothing is NaN — a dashboard full of NaN is how people learn to
    // ignore a dashboard.
    expect(JSON.stringify(body)).not.toContain('null,"NaN"');
    expect(JSON.stringify(body)).not.toContain('NaN');

    await empty.close();
    rmSync(emptyDir, { recursive: true, force: true });
  }, 20_000);

  it('29–30. denials are not failures, and the hit rate says what it divides', async () => {
    const { body } = await get<{
      tools: { calls: number; succeeded: number; failed: number; denied: number; successRate: number | null };
      memory: { recalls: number; offered: number; used: number; hitRate: number | null };
    }>('/metrics');

    // 29: the rate is successes over (successes + failures + timeouts).
    // A refused call is the system working; counting it as a failure would
    // make a well-defended agent look broken.
    const attempted = body.tools.succeeded + body.tools.failed;
    expect(body.tools.successRate).toBeCloseTo(body.tools.succeeded / attempted, 3);

    // 30: used ÷ offered, both reported so the ratio can be checked.
    if (body.memory.hitRate !== null) {
      expect(body.memory.hitRate).toBeCloseTo(body.memory.used / body.memory.offered, 3);
    } else {
      expect(body.memory.offered).toBe(0);
    }
  });
});

/**
 * `GET /events` with a cursor.
 *
 * The route used to read every matching row and slice the array, which
 * made it both slow and unfollowable: with no way to say "since", a
 * client that wanted to watch the log had to re-fetch the whole window
 * and diff it. The cursor is `sinceSeq`, exclusive, and the server hands
 * the next one back so no client has to derive `max(seq)` of a possibly
 * empty page.
 */
describe('reading the log', () => {
  interface Page {
    total: number;
    events: Array<{ seq: number; type: string }>;
    nextSeq: number;
    hasMore: boolean;
  }

  it('without a cursor returns the newest page, in log order', async () => {
    const { body } = await get<Page>('/events?limit=5');
    expect(body.events).toHaveLength(5);
    // Ascending, even though the newest page is read backwards.
    const seqs = body.events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // And it really is the newest page, not the oldest.
    expect(body.nextSeq).toBe(seqs.at(-1));
    expect(body.total).toBeGreaterThan(5);
    expect(body.hasMore).toBe(true);
  });

  it('a cursor returns only what came after it', async () => {
    const { body: first } = await get<Page>('/events?limit=3&sinceSeq=0');
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3]);

    const { body: second } = await get<Page>(`/events?limit=3&sinceSeq=${first.nextSeq}`);
    expect(second.events.map((event) => event.seq)).toEqual([4, 5, 6]);
  });

  /**
   * The property that makes a cursor worth having on an append-only
   * log: paging through it start to finish yields every event exactly
   * once, with no gap and no repeat, whatever the page size.
   */
  it('paging with the cursor covers the log exactly once', async () => {
    const { body: head } = await get<Page>('/events?limit=1');
    const seen: number[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 200; guard += 1) {
      const { body } = await get<Page>(`/events?limit=7&sinceSeq=${cursor}`);
      seen.push(...body.events.map((event) => event.seq));
      cursor = body.nextSeq;
      if (!body.hasMore) break;
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size, 'an event came back twice').toBe(seen.length);
    expect(seen.length).toBe(head.total);
  });

  it('a cursor at the head returns nothing and does not move', async () => {
    const { body: head } = await get<Page>('/events?limit=1');
    const { body } = await get<Page>(`/events?sinceSeq=${head.nextSeq}`);
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
    // Critically: it hands back the cursor it was given rather than 0,
    // which is what would make a follower start over from the beginning.
    expect(body.nextSeq).toBe(head.nextSeq);
  });

  it('the cursor and the filter compose, and total counts the filter', async () => {
    const { body } = await get<Page>('/events?types=run.started&sinceSeq=0&limit=50');
    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) expect(event.type).toBe('run.started');
    // `total` is the size of the filtered set, not of the whole log.
    const { body: all } = await get<Page>('/events?limit=1');
    expect(body.total).toBeLessThan(all.total);
    expect(body.total).toBe(body.events.length);
  });

  it('refuses a cursor that is not a whole number rather than guessing', async () => {
    for (const bad of ['-1', 'abc', '1.5']) {
      const { status } = await get(`/events?sinceSeq=${bad}`);
      expect(status, `sinceSeq=${bad}`).toBe(400);
    }
  });

  it('caps the page size so one client cannot ask for the whole log', async () => {
    const { body } = await get<Page>('/events?limit=99999&sinceSeq=0');
    expect(body.events.length).toBeLessThanOrEqual(500);
  });
});
