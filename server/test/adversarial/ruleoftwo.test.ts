import { describe, expect, it } from 'vitest';
import {
  computeTriple, describeTriple, evaluateRuleOfTwo, holdsAllThree,
  type Effect, type Sensitivity, type StepDescriptor,
} from '../../src/capability/ruleoftwo.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';
import type { Capability } from '../../src/security/trust.js';

function step(parts: Partial<StepDescriptor> = {}): StepDescriptor {
  return { trustInScope: ['USER'], capabilities: [], sensitivity: 'none', effect: 'pure', ...parts };
}

/** Build a step that holds exactly the requested subset of (A, B, C). */
function withTriple(a: boolean, b: boolean, c: boolean, extra: Partial<StepDescriptor> = {}): StepDescriptor {
  return step({
    trustInScope: a ? ['USER', 'FOREIGN'] : ['USER'],
    sensitivity: b ? 'reads-private' : 'none',
    effect: c ? 'external' : 'pure',
    ...extra,
  });
}

describe('§19 Rule of Two — the triple', () => {
  it('(A) is any FOREIGN trust in the causal closure', () => {
    expect(computeTriple(step({ trustInScope: ['SYSTEM', 'USER', 'DERIVED'] })).untrustedInput).toBe(false);
    expect(computeTriple(step({ trustInScope: ['SYSTEM', 'FOREIGN'] })).untrustedInput).toBe(true);
  });

  it('(B) comes from declared sensitivity OR a sensitive capability', () => {
    expect(computeTriple(step({ sensitivity: 'reads-private' })).sensitiveAccess).toBe(true);
    expect(computeTriple(step({ sensitivity: 'writes-private' })).sensitiveAccess).toBe(true);
    expect(computeTriple(step({ capabilities: ['vault:read'] })).sensitiveAccess).toBe(true);
    expect(computeTriple(step({ capabilities: ['memory:write'] })).sensitiveAccess).toBe(true);
    expect(computeTriple(step({ capabilities: ['effect:local'] })).sensitiveAccess).toBe(false);
  });

  it('(C) comes from declared effect OR an external capability', () => {
    expect(computeTriple(step({ effect: 'external' })).externalChange).toBe(true);
    expect(computeTriple(step({ capabilities: ['effect:external'] })).externalChange).toBe(true);
    expect(computeTriple(step({ effect: 'local' })).externalChange).toBe(false);
    expect(computeTriple(step({ effect: 'pure' })).externalChange).toBe(false);
  });
});

describe('§19 Rule of Two — the gate', () => {
  it('permits any two properties', () => {
    expect(evaluateRuleOfTwo(withTriple(true, true, false)).allowed).toBe(true);
    expect(evaluateRuleOfTwo(withTriple(true, false, true)).allowed).toBe(true);
    expect(evaluateRuleOfTwo(withTriple(false, true, true)).allowed).toBe(true);
  });

  it('BLOCKS all three', () => {
    const verdict = evaluateRuleOfTwo(withTriple(true, true, true));
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toMatch(/Rule of Two/);
      expect(holdsAllThree(verdict.triple)).toBe(true);
    }
  });

  it('is exhaustive over all 2³ combinations', () => {
    // The whole rule, as a truth table. Nothing here is a judgement call.
    const expected: Array<[boolean, boolean, boolean, boolean]> = [
      [false, false, false, true], [true, false, false, true],
      [false, true, false, true], [false, false, true, true],
      [true, true, false, true], [true, false, true, true],
      [false, true, true, true], [true, true, true, false],
    ];
    for (const [a, b, c, allowed] of expected) {
      expect(evaluateRuleOfTwo(withTriple(a, b, c)).allowed, `A=${a} B=${b} C=${c}`).toBe(allowed);
    }
  });

  it('a human approval naming all three permits it, and marks it supervised', () => {
    const verdict = evaluateRuleOfTwo(withTriple(true, true, true, {
      humanApproval: { approvalId: 'ap-1', acknowledged: { untrustedInput: true, sensitiveAccess: true, externalChange: true } },
    }));
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.supervised).toBe(true);
  });

  it('a PARTIAL acknowledgement is not an approval', () => {
    // Consenting to two thirds of the triple defeats the point of showing it.
    const partials = [
      { untrustedInput: true, sensitiveAccess: true, externalChange: false },
      { untrustedInput: true, sensitiveAccess: false, externalChange: true },
      { untrustedInput: false, sensitiveAccess: true, externalChange: true },
    ];
    for (const acknowledged of partials) {
      const verdict = evaluateRuleOfTwo(withTriple(true, true, true, { humanApproval: { approvalId: 'ap', acknowledged } }));
      expect(verdict.allowed, JSON.stringify(acknowledged)).toBe(false);
    }
  });

  it('an approval on a two-property step is unnecessary, not supervised', () => {
    const verdict = evaluateRuleOfTwo(withTriple(true, true, false, {
      humanApproval: { approvalId: 'ap', acknowledged: { untrustedInput: true, sensitiveAccess: true, externalChange: true } },
    }));
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) expect(verdict.supervised).toBe(false);
  });

  it('describes the triple in words a person can consent to', () => {
    const lines = describeTriple({ untrustedInput: true, sensitiveAccess: true, externalChange: true });
    expect(lines).toHaveLength(3);
    expect(lines.join(' ')).toMatch(/untrusted source/);
    expect(lines.join(' ')).toMatch(/outside this machine/);
  });
});

describe('§19 — exhaustive search for an unsupervised (A∧B∧C)', () => {
  it('no combination of declared inputs produces one', () => {
    // §59.8: "No code path produces an unsupervised operation holding all
    // three." This enumerates the entire declared input space rather than
    // sampling it — the space is small enough to be exhausted, so sampling
    // would be a worse test for no benefit.
    const trustSets: TrustLevel[][] = [
      ['SYSTEM'], ['USER'], ['DERIVED'], ['TOOL'], ['FOREIGN'],
      ['SYSTEM', 'FOREIGN'], ['USER', 'TOOL'], ['USER', 'DERIVED', 'FOREIGN'],
      ['SYSTEM', 'USER', 'DERIVED', 'TOOL', 'FOREIGN'],
    ];
    const sensitivities: Sensitivity[] = ['none', 'reads-private', 'writes-private'];
    const effects: Effect[] = ['pure', 'local', 'external'];
    const capabilitySets: Capability[][] = [
      [], ['vault:read'], ['memory:read'], ['memory:write'], ['memory:promote'],
      ['effect:local'], ['effect:external'], ['egress:new-host'], ['file:write'],
      ['vault:read', 'effect:external'], ['memory:write', 'effect:external'],
    ];

    let checked = 0;
    let blocked = 0;
    for (const trustInScope of trustSets) {
      for (const sensitivity of sensitivities) {
        for (const effect of effects) {
          for (const capabilities of capabilitySets) {
            const descriptor: StepDescriptor = { trustInScope, sensitivity, effect, capabilities };
            const verdict = evaluateRuleOfTwo(descriptor);
            const triple = computeTriple(descriptor);
            checked++;
            if (holdsAllThree(triple)) {
              blocked++;
              // The invariant: holding all three and unsupervised => refused.
              expect(verdict.allowed, JSON.stringify(descriptor)).toBe(false);
            } else {
              expect(verdict.allowed, JSON.stringify(descriptor)).toBe(true);
            }
          }
        }
      }
    }
    expect(checked).toBe(trustSets.length * 3 * 3 * capabilitySets.length);
    // Guard against the test passing because nothing ever triggered.
    expect(blocked).toBeGreaterThan(20);
  });
});
