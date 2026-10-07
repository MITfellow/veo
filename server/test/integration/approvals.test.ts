import { describe, expect, it } from 'vitest';
import { createRunner, ALL_CAPABILITIES } from '../fakes/runner.js';
import { ApprovalError, DEFAULT_TTL_MS } from '../../src/orchestration/approvals.js';
import type { PlanSpec } from '../../src/orchestration/plan.js';
import type { RunOptions } from '../../src/orchestration/types.js';
import { must, one } from '../fakes/must.js';

/** M3 §4 — the approval lifecycle, through the real executor. */

const base: RunOptions = { inputTrust: 'USER', granted: [...ALL_CAPABILITIES], earnedAutonomy: 4 };

/** An interact-tier step on an observe-only rung: the executor must ask. */
function needsApproval(): PlanSpec {
  return {
    goal: 'remember where I live',
    steps: [{ tool: 'memory.assert', input: { subject: 'user', predicate: 'lives_in', object: 'Berlin' }, why: 'remember where you live' }],
    allowedTools: ['memory.assert'],
    maxSteps: 5,
    rung: 1,
    carriesPrivateData: true,
  };
}

describe('approvals (§30)', () => {
  it('asks rather than failing when a step is above the rung', async () => {
    const h = await createRunner();
    const result = await h.executor.run(needsApproval(), base);

    expect(result.status).toBe('awaiting-approval');
    const step = must(result.steps[0], 'the step');
    expect(step.status).toBe('awaiting-approval');
    expect(step.approvalId).toBeDefined();
    // Nothing ran, and nothing failed. The run is paused.
    expect(h.memory.count()).toBe(0);
    expect(h.s.events.read().map((e) => e.type)).not.toContain('run.failed');
    h.close();
  });

  it('shows the human what they are being asked to allow', async () => {
    const h = await createRunner();
    await h.executor.run(needsApproval(), base);
    const requested = one(h.s.events.read(), (e) => e.type === 'approval.requested', 'the request');
    expect(requested.payload['tool']).toBe('memory.assert');
    expect(requested.payload['action']).toBe('remember where you live');
    expect(requested.payload['triple']).toEqual({
      untrustedInput: false, sensitiveAccess: true, externalChange: false,
    });
    h.close();
  });

  it('proceeds once granted, and the second run of the same plan runs the step', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    h.approvals.grant(must(must(first.steps[0], 'step').approvalId, 'approval id'), 'user:ara', 'USER', 'yes');

    const second = await h.executor.run(needsApproval(), base);
    expect(second.status).toBe('finished');
    expect(h.memory.count()).toBe(1);
    h.close();
  });

  it('binds an approval to one step of one plan', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    const approvalId = must(must(first.steps[0], 'step').approvalId, 'approval id');
    h.approvals.grant(approvalId, 'user:ara', 'USER');

    // A different plan — different goal, therefore different seal — must
    // not inherit the yes.
    const other = { ...needsApproval(), goal: 'something else entirely' };
    const result = await h.executor.run(other, base);
    expect(result.status).toBe('awaiting-approval');
    expect(must(result.steps[0], 'step').approvalId).not.toBe(approvalId);
    h.close();
  });

  it('cancels the run when the human says no', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    h.approvals.deny(must(must(first.steps[0], 'step').approvalId, 'approval id'), 'user:ara', 'USER', 'no thanks');

    const second = await h.executor.run(needsApproval(), base);
    // Cancelled, not failed: the user did not break anything, they answered.
    expect(second.status).toBe('cancelled');
    expect(h.s.events.read().map((e) => e.type)).toContain('run.cancelled');
    h.close();
  });

  it('expires, and an expired approval authorises nothing', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    const approvalId = must(must(first.steps[0], 'step').approvalId, 'approval id');

    h.s.clock.advance(DEFAULT_TTL_MS + 1000);
    expect(h.approvals.expireStale()).toBe(1);
    expect(must(h.approvals.get(approvalId), 'the row').status).toBe('expired');

    const second = await h.executor.run(needsApproval(), base);
    expect(second.status).toBe('awaiting-approval');
    h.close();
  });

  it('refuses an answer that arrives after the deadline', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    const approvalId = must(must(first.steps[0], 'step').approvalId, 'approval id');
    h.s.clock.advance(DEFAULT_TTL_MS + 1);
    try {
      h.approvals.grant(approvalId, 'user:ara', 'USER');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).kind).toBe('expired');
    }
    h.close();
  });

  it('cannot be answered twice', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    const approvalId = must(must(first.steps[0], 'step').approvalId, 'approval id');
    h.approvals.grant(approvalId, 'user:ara', 'USER');
    expect(() => h.approvals.deny(approvalId, 'user:ara', 'USER')).toThrow(/already granted/);
    h.close();
  });

  it('refuses an agent granting its own approval', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    const approvalId = must(must(first.steps[0], 'step').approvalId, 'approval id');
    // The type says USER | SYSTEM; this is what an agent would have to do
    // at runtime, and it must still be refused.
    expect(() => h.approvals.grant(approvalId, 'agent', 'DERIVED' as 'USER')).toThrow(/Only a human/);
    h.close();
  });

  it('stops asking forever — the approval budget is a budget', async () => {
    const h = await createRunner();
    const many: PlanSpec = {
      ...needsApproval(),
      steps: Array.from({ length: 4 }, (_, i) => ({
        tool: 'memory.assert',
        input: { subject: 'user', predicate: `p${i}`, object: 'o' },
        why: `step ${i}`,
      })),
    };
    // One approval allowed; the first step asks, so the run pauses there.
    const result = await h.executor.run(many, { ...base, budget: { approvals: 0 } });
    expect(must(result.steps[0], 'step').code).toBe('budget');
    expect(h.s.events.read().map((e) => e.type)).toContain('budget.exceeded');
    h.close();
  });

  it('lists what it is waiting on', async () => {
    const h = await createRunner();
    await h.executor.run(needsApproval(), base);
    const pending = h.approvals.pending();
    expect(pending).toHaveLength(1);
    expect(must(pending[0], 'pending row').tool).toBe('memory.assert');
    h.close();
  });

  it('survives a rebuild with its status intact', async () => {
    const h = await createRunner();
    const first = await h.executor.run(needsApproval(), base);
    h.approvals.grant(must(must(first.steps[0], 'step').approvalId, 'approval id'), 'user:ara', 'USER');
    const before = h.s.storage.prepare('SELECT * FROM approvals ORDER BY id').all();
    h.s.events.rebuild();
    expect(h.s.storage.prepare('SELECT * FROM approvals ORDER BY id').all()).toEqual(before);
    h.close();
  });
});
