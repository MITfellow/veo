import { describe, expect, it } from 'vitest';
import { applyTrustFloor, effectiveTrust, FOREIGN_DENIED, meetAll } from '../../src/security/trust.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';
import { createTestSubstrate } from '../fakes/substrate.js';

describe('§20 effective trust over the causal closure', () => {
  function chain(levels: TrustLevel[]) {
    const s = createTestSubstrate();
    let causationId: string | undefined;
    const ids: string[] = [];
    for (const trust of levels) {
      const event = s.events.append({
        type: 'capture.received', actor: 'a', trust,
        ...(causationId === undefined ? {} : { causationId }),
        payload: { captureId: `c${ids.length}`, source: 'test', kind: 'text', content: 'x' },
      });
      ids.push(event.id);
      causationId = event.id;
      s.clock.advance(10);
    }
    return { s, ids };
  }

  it('is the minimum over the whole chain', () => {
    const { s, ids } = chain(['SYSTEM', 'USER', 'DERIVED']);
    expect(effectiveTrust(s.storage, ids[ids.length - 1] as string)).toBe('DERIVED');
    s.close();
  });

  it('a FOREIGN ancestor poisons every descendant, however deep', () => {
    // The property that stops injection laundering itself through DERIVED steps.
    const { s, ids } = chain(['SYSTEM', 'FOREIGN', 'DERIVED', 'USER', 'SYSTEM', 'DERIVED']);
    expect(effectiveTrust(s.storage, ids[ids.length - 1] as string)).toBe('FOREIGN');
    s.close();
  });

  it('never increases, at any length', () => {
    const { s, ids } = chain(['USER', 'TOOL', 'SYSTEM', 'USER', 'SYSTEM']);
    let previous: TrustLevel = 'SYSTEM';
    const rank = { FOREIGN: 0, TOOL: 1, DERIVED: 2, USER: 3, SYSTEM: 4 };
    for (const id of ids) {
      const current = effectiveTrust(s.storage, id);
      expect(rank[current]).toBeLessThanOrEqual(rank[previous]);
      previous = current;
    }
    s.close();
  });

  it('FAILS CLOSED on a dangling causation id', () => {
    // An attacker who can delete one row must not be able to promote
    // everything downstream of it.
    const s = createTestSubstrate();
    const event = s.events.append({
      type: 'capture.received', actor: 'a', trust: 'SYSTEM', causationId: 'does-not-exist',
      payload: { captureId: 'c', source: 'test', kind: 'text', content: 'x' },
    });
    expect(effectiveTrust(s.storage, event.id)).toBe('FOREIGN');
    s.close();
  });

  it('returns FOREIGN for an unknown event id', () => {
    const s = createTestSubstrate();
    expect(effectiveTrust(s.storage, 'nonexistent')).toBe('FOREIGN');
    s.close();
  });

  it('terminates on a cycle instead of hanging', () => {
    const s = createTestSubstrate();
    const a = s.events.append({ type: 'capture.received', actor: 'a', trust: 'USER', payload: { captureId: 'c1', source: 't', kind: 'text', content: 'x' } });
    const b = s.events.append({ type: 'capture.received', actor: 'a', trust: 'USER', causationId: a.id, payload: { captureId: 'c2', source: 't', kind: 'text', content: 'x' } });
    s.storage.prepare('UPDATE events SET causation_id = ? WHERE id = ?').run(b.id, a.id);
    expect(effectiveTrust(s.storage, b.id)).toBe('USER');
    s.close();
  });

  it('meetAll folds an explicit set', () => {
    expect(meetAll(['SYSTEM', 'USER', 'TOOL'])).toBe('TOOL');
    expect(meetAll([])).toBe('SYSTEM');
  });
});

describe('§20.2 capability floors', () => {
  it('FOREIGN is denied vault reads, external effects, promotion and escalation', () => {
    const decision = applyTrustFloor('FOREIGN', [...FOREIGN_DENIED], 4);
    expect(decision.allowed).toBe(false);
    expect(decision.denied).toEqual([...FOREIGN_DENIED]);
    expect(decision.reason).toMatch(/FOREIGN trust forbids/);
  });

  it('FOREIGN may still read memory and act locally', () => {
    const decision = applyTrustFloor('FOREIGN', ['memory:read', 'effect:local'], 4);
    expect(decision.allowed).toBe(true);
  });

  it('FOREIGN caps autonomy at L1 regardless of what was earned', () => {
    expect(applyTrustFloor('FOREIGN', [], 4).autonomyCap).toBe(1);
    expect(applyTrustFloor('FOREIGN', [], 0).autonomyCap).toBe(0);
  });

  it('non-FOREIGN levels keep their earned autonomy', () => {
    for (const trust of ['SYSTEM', 'USER', 'DERIVED', 'TOOL'] as TrustLevel[]) {
      const decision = applyTrustFloor(trust, ['vault:read', 'effect:external'], 3);
      expect(decision.allowed, trust).toBe(true);
      expect(decision.autonomyCap).toBe(3);
    }
  });
});
