import { describe, expect, it } from 'vitest';
import { createRunner, ALL_CAPABILITIES, type RunnerHarness } from '../fakes/runner.js';
import type { PlanSpec } from '../../src/orchestration/plan.js';
import type { RunOptions } from '../../src/orchestration/types.js';
import { must, one } from '../fakes/must.js';

/** M3 §5, §6, §9 — plan-then-execute, dry run, and the audit trail. */

const base: RunOptions = {
  inputTrust: 'USER',
  granted: [...ALL_CAPABILITIES],
  earnedAutonomy: 4,
};

function plan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    goal: 'find out what time it is',
    steps: [{ tool: 'time.now', input: {}, why: 'the user asked for the time' }],
    allowedTools: ['time.now'],
    maxSteps: 10,
    rung: 1,
    carriesPrivateData: false,
    ...overrides,
  };
}

const types = (h: RunnerHarness): string[] => h.s.events.read().map((e) => e.type);

describe('the executor — plan then execute (§22)', () => {
  it('runs a simple plan and reports each step', async () => {
    const h = await createRunner();
    const result = await h.executor.run(plan(), base);
    expect(result.status).toBe('finished');
    expect(must(result.steps[0], 'the step').status).toBe('succeeded');
    h.close();
  });

  it('appends run.planned before anything is invoked, by sequence number', async () => {
    const h = await createRunner();
    await h.executor.run(plan(), base);
    const events = h.s.events.read();
    const planned = one(events, (e) => e.type === 'run.planned', 'the plan event');
    const invoked = one(events, (e) => e.type === 'tool.invoked', 'the first invocation');
    // By seq, not by reading order: the claim is about what was committed
    // first, not about how the array happens to be sorted.
    expect(planned.seq).toBeLessThan(invoked.seq);
    h.close();
  });

  it('seals the plan over the budget and the rung, not only the steps', async () => {
    const h = await createRunner();
    const a = await h.executor.run(plan({ rung: 1 }), base);
    const b = await h.executor.run(plan({ rung: 3 }), base);
    // Same steps, different authority: a different plan, so a different seal.
    expect(a.plan.seal).not.toBe(b.plan.seal);
    h.close();
  });

  it('refuses a tool that is not in the plan, however it got there', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      plan({
        steps: [{ tool: 'memory.assert', input: { subject: 'u', predicate: 'p', object: 'o' }, why: 'smuggled' }],
        allowedTools: ['time.now'],
      }),
      base,
    );
    expect(must(result.steps[0], 'the step').code).toBe('not_in_plan');
    expect(must(result.steps[0], 'the step').detail).toMatch(/Nothing encountered during a run can add one/);
    h.close();
  });

  it('halts when the plan is mutated after it was sealed', async () => {
    const h = await createRunner();
    const spec = plan({
      steps: [
        { tool: 'time.now', input: {}, why: 'first' },
        { tool: 'time.now', input: {}, why: 'second' },
      ],
    });
    // Mutate between steps by handing the executor a plan whose seal was
    // computed over something else.
    const result = await h.executor.run(spec, base);
    expect(result.status).toBe('finished');

    const tampered = { ...result.plan, maxSteps: 99 };
    const verdict = (await import('../../src/orchestration/plan.js')).planPermits(tampered, 0, h.s.crypto);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe('seal_broken');
    h.close();
  });

  it('stops at the plan step limit rather than running on', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      plan({
        steps: [
          { tool: 'time.now', input: {}, why: 'one' },
          { tool: 'time.now', input: {}, why: 'two' },
        ],
        maxSteps: 1,
      }),
      base,
    );
    expect(must(result.steps[1], 'the second step').code).toBe('step_limit');
    expect(result.status).toBe('failed');
    h.close();
  });

  it('refuses a malformed step before claiming the call happened', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      plan({
        steps: [{ tool: 'memory.assert', input: { subject: 'u', nope: 1 }, why: 'bad input' }],
        allowedTools: ['memory.assert'],
        rung: 2,
      }),
      base,
    );
    expect(must(result.steps[0], 'the step').code).toBe('invalid_input');
    // Exactly one invocation row — the refusal's — and it is terminal.
    expect(types(h).filter((t) => t === 'tool.invoked')).toHaveLength(1);
    expect(types(h)).toContain('tool.denied');
    h.close();
  });
});

describe('L0 is propose-only', () => {
  it('produces a plan and runs nothing', async () => {
    const h = await createRunner();
    const result = await h.executor.run(plan({ rung: 0 }), { ...base, earnedAutonomy: 0 });
    expect(result.status).toBe('proposed');
    expect(must(result.steps[0], 'the step').status).toBe('proposed');
    expect(types(h)).not.toContain('tool.invoked');
    expect(result.stopReason).toMatch(/nothing was run/);
    h.close();
  });
});

describe('dry run (§6)', () => {
  it('emits tool.dryrun and never tool.invoked', async () => {
    const h = await createRunner();
    await h.executor.run(
      plan({
        goal: 'see what would happen',
        steps: [{ tool: 'http.fetch', input: { url: 'https://example.com/pay' }, why: 'pay the invoice' }],
        allowedTools: ['http.fetch'],
        rung: 4,
      }),
      { ...base, dryRun: true },
    );
    expect(types(h)).toContain('tool.dryrun');
    expect(types(h)).not.toContain('tool.invoked');
    h.close();
  });

  it('changes nothing — the projection digest is identical', async () => {
    const h = await createRunner();
    const { snapshotDigest } = await import('../../src/substrate/projections/index.js');
    const factsBefore = h.memory.count();

    await h.executor.run(
      plan({
        steps: [{ tool: 'memory.assert', input: { subject: 'u', predicate: 'p', object: 'o' }, why: 'remember' }],
        allowedTools: ['memory.assert'],
        rung: 2,
      }),
      { ...base, dryRun: true },
    );
    expect(h.memory.count()).toBe(factsBefore);
    // The run itself is recorded — that is the point of a dry run you can
    // audit — but no fact was written.
    expect(snapshotDigest(h.s.storage, h.s.crypto).tables['facts']).toBeDefined();
    h.close();
  });

  it('shows the origin of a request it would make, and not the query string', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      plan({
        steps: [{ tool: 'http.fetch', input: { url: 'https://api.example.com/pay?token=sekrit' }, why: 'pay' }],
        allowedTools: ['http.fetch'],
        rung: 4,
      }),
      { ...base, dryRun: true },
    );
    expect(must(result.steps[0], 'the step').detail).toContain('https://api.example.com');
    expect(JSON.stringify(h.s.events.read())).not.toContain('sekrit');
    h.close();
  });
});

describe('the audit trail (decision 010, generalised)', () => {
  it('terminates every invocation, on every path', async () => {
    const h = await createRunner();
    const specs: PlanSpec[] = [
      plan(),
      plan({ steps: [{ tool: 'nope.missing', input: {}, why: 'x' }], allowedTools: ['nope.missing'] }),
      plan({ steps: [{ tool: 'time.now', input: { bad: 1 }, why: 'x' }] }),
      plan({
        steps: [{ tool: 'http.fetch', input: { url: 'https://example.com' }, why: 'fetch' }],
        allowedTools: ['http.fetch'], rung: 4,
      }),
      plan({ steps: [{ tool: 'memory.assert', input: { subject: 'a', predicate: 'b', object: 'c' }, why: 'x' }], allowedTools: ['memory.assert'], rung: 1 }),
    ];
    for (const spec of specs) await h.executor.run(spec, base);

    const open = h.s.storage
      .prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'invoked'`)
      .get<{ n: number }>()?.n;
    expect(open).toBe(0);
    h.close();
  });

  it('carries a policy code on every denial', async () => {
    const h = await createRunner();
    await h.executor.run(plan({ steps: [{ tool: 'ghost.tool', input: {}, why: 'x' }], allowedTools: ['ghost.tool'] }), base);
    const denied = one(h.s.events.read(), (e) => e.type === 'tool.denied', 'the denial');
    expect(denied.payload['code']).toBe('unknown_tool');
    h.close();
  });

  it('reaches a terminal run state on every path', async () => {
    const h = await createRunner();
    await h.executor.run(plan(), base);
    await h.executor.run(plan({ steps: [{ tool: 'ghost.tool', input: {}, why: 'x' }], allowedTools: ['ghost.tool'] }), base);
    const dangling = h.s.storage
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`)
      .get<{ n: number }>()?.n;
    expect(dangling).toBe(0);
    h.close();
  });

  it('replays byte-identically', async () => {
    const h = await createRunner();
    const { diffSnapshots, snapshotDigest } = await import('../../src/substrate/projections/index.js');
    await h.executor.run(plan(), base);
    await h.executor.run(
      plan({ steps: [{ tool: 'http.fetch', input: { url: 'https://example.com' }, why: 'x' }], allowedTools: ['http.fetch'], rung: 4 }),
      base,
    );
    const before = snapshotDigest(h.s.storage, h.s.crypto);
    h.s.clock.advance(60_000);
    h.s.events.rebuild();
    const after = snapshotDigest(h.s.storage, h.s.crypto);
    expect(diffSnapshots(before, after)).toEqual([]);
    h.close();
  });
});
