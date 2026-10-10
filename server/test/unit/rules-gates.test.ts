import { describe, expect, it } from 'vitest';
import {
  applicable, confirm, explainRule, newRule, override, PROBATION_AT, REHABILITATION, RETIRED_AT,
} from '../../src/cognition/rules.js';
import {
  evaluateGates, FAILURE_MODES, NO_EVIDENCE, STANDARD_GATES, type Evidence,
} from '../../src/orchestration/gates.js';

/**
 * §18's rule decay and §19's completion gates.
 *
 * Both encode the same idea from opposite directions: the agent does not
 * get to be the judge of whether it was right.
 */

const T = 1_700_000_000_000;

function overrideTimes(count: number): ReturnType<typeof newRule> {
  let rule = newRule('r1', 'she says the warehouse', 'she means the northern one', T);
  for (let i = 0; i < count; i++) rule = override(rule, T + i).rule;
  return rule;
}

describe('§18 a rule that keeps being wrong', () => {
  it('starts active and in use', () => {
    const rule = newRule('r1', 'a', 'b', T);
    expect(rule.status).toBe('active');
    expect(applicable([rule])).toHaveLength(1);
  });

  it(`goes to probation on the ${PROBATION_AT}rd correction, not before`, () => {
    expect(overrideTimes(PROBATION_AT - 1).status).toBe('active');
    expect(overrideTimes(PROBATION_AT).status).toBe('probation');
  });

  it('is kept but not used while on probation', () => {
    const rule = overrideTimes(PROBATION_AT);
    expect(applicable([rule])).toHaveLength(0);
    expect(explainRule(rule)).toContain('on hold');
  });

  it(`retires on the ${RETIRED_AT}th correction`, () => {
    expect(overrideTimes(RETIRED_AT).status).toBe('retired');
    expect(explainRule(overrideTimes(RETIRED_AT))).toContain('will not come back on its own');
  });

  it('tells the user, once, at each transition', () => {
    let rule = newRule('r1', 'x', 'y', T);
    const notes: string[] = [];
    for (let i = 0; i < RETIRED_AT; i++) {
      const change = override(rule, T + i);
      rule = change.rule;
      if (change.changed) notes.push(change.note);
    }
    expect(notes).toHaveLength(2); // probation, then retirement
    expect(notes[1]).toContain('Stopped applying');
  });

  it('never resurrects a retired rule, however long the streak', () => {
    let rule = overrideTimes(RETIRED_AT);
    for (let i = 0; i < 50; i++) rule = confirm(rule, T + i).rule;
    expect(rule.status).toBe('retired');
    expect(applicable([rule])).toHaveLength(0);
  });

  it(`lets a probationary rule back after ${REHABILITATION} confirmations`, () => {
    let rule = overrideTimes(PROBATION_AT);
    for (let i = 0; i < REHABILITATION - 1; i++) rule = confirm(rule, T + i).rule;
    expect(rule.status).toBe('probation');

    const change = confirm(rule, T + 99);
    expect(change.rule.status).toBe('active');
    expect(change.changed).toBe(true);
  });

  it('resets the streak on a single correction', () => {
    let rule = overrideTimes(PROBATION_AT);
    for (let i = 0; i < REHABILITATION - 1; i++) rule = confirm(rule, T + i).rule;
    rule = override(rule, T + 50).rule;
    expect(rule.streak).toBe(0);
    expect(rule.status).toBe('probation');
  });

  it('loses confidence faster than it gains it', () => {
    const start = newRule('r1', 'a', 'b', T, 0.5);
    const down = override(start, T).rule.confidence;
    const up = confirm(start, T).rule.confidence;
    expect(0.5 - down).toBeGreaterThan(up - 0.5);
  });
});

describe('§19 gates default to FAIL', () => {
  it('rejects a run that produced nothing at all', () => {
    const report = evaluateGates(NO_EVIDENCE);
    expect(report.passed).toBe(false);
    expect(report.failures).toContain('no_evidence');
    expect(report.failures).toContain('abandoned');
  });

  it('counts a gate whose check throws as failed, never as skipped', () => {
    const exploding = [{
      name: 'boom', asks: 'does it explode?',
      check: (): never => { throw new Error('the checker is broken'); },
    }];
    const report = evaluateGates(NO_EVIDENCE, exploding);
    expect(report.passed).toBe(false);
    expect(report.results[0]?.failure).toBe('evidence_unverifiable');
    expect(report.results[0]?.detail).toContain('the checker is broken');
  });

  it('names every failure from the closed list', () => {
    const report = evaluateGates(NO_EVIDENCE);
    for (const failure of report.failures) expect(FAILURE_MODES).toContain(failure);
  });

  it('declares exactly sixteen failure modes', () => {
    expect(new Set(FAILURE_MODES).size).toBe(16);
  });
});

describe('§19 what the gates actually catch', () => {
  const good: Evidence = {
    events: ['run.started', 'tool.called', 'run.finished'],
    effects: [{ key: 'k1', status: 'committed', tool: 'calendar.create' }],
    artifacts: [{ id: 'a1', exists: true, bytes: 120 }],
    approvals: ['seal-1'],
    requiredApprovals: ['seal-1'],
    budget: { steps: 4, maxSteps: 20, wallClockMs: 900, maxWallClockMs: 120_000 },
    concluded: true, truncated: false, truncationReported: false,
  };

  it('passes a run that really did the work', () => {
    const report = evaluateGates(good);
    expect(report.passed, report.summary).toBe(true);
    expect(report.results).toHaveLength(STANDARD_GATES.length);
  });

  it('catches an artifact that was claimed but never written', () => {
    const report = evaluateGates({ ...good, artifacts: [{ id: 'a1', exists: false, bytes: 0 }] });
    expect(report.failures).toContain('evidence_unverifiable');
  });

  it('catches an effect nobody can account for', () => {
    const report = evaluateGates({ ...good, effects: [{ key: 'k1', status: 'needs_attention', tool: 'mail.send' }] });
    expect(report.failures).toContain('partial_completion');
  });

  it('catches the same effect happening twice', () => {
    const report = evaluateGates({
      ...good,
      effects: [
        { key: 'k1', status: 'committed', tool: 'mail.send' },
        { key: 'k1', status: 'committed', tool: 'mail.send' },
      ],
    });
    expect(report.failures).toContain('duplicate_effect');
  });

  it('catches a step that ran without the approval it needed', () => {
    const report = evaluateGates({ ...good, approvals: [] });
    expect(report.failures).toContain('unapproved_effect');
  });

  it('catches a silent truncation but accepts an announced one', () => {
    expect(evaluateGates({ ...good, truncated: true }).failures).toContain('silent_truncation');
    expect(evaluateGates({ ...good, truncated: true, truncationReported: true }).passed).toBe(true);
  });

  it('catches a run that burst its budget', () => {
    const report = evaluateGates({ ...good, budget: { ...good.budget, steps: 21 } });
    expect(report.failures).toContain('budget_exhausted');
  });

  it('summarises failures in one line naming each gate and its mode', () => {
    const report = evaluateGates({ ...good, concluded: false, approvals: [] });
    expect(report.summary).toContain('concluded (abandoned)');
    expect(report.summary).toContain('approvals-honoured (unapproved_effect)');
  });
});
