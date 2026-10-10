import { describe, expect, it } from 'vitest';
import { assess, atLeast, DEFAULT_SIGNALS, explain, RUNGS, type Signals } from '../../src/orchestration/degradation.js';

/**
 * §20 — the ladder.
 *
 * The property that matters is monotonicity: a lower rung can do
 * strictly less, never something different. Everything else here is
 * about saying so in words a person can act on.
 */

const healthy: Signals = { ...DEFAULT_SIGNALS, modelAttached: true, modelReachable: true };

describe('§20 the degradation ladder', () => {
  it('is L0 only when nothing at all is wrong', () => {
    expect(assess(healthy).rung).toBe('L0');
    expect(explain(assess(healthy))).toBe('Everything is available.');
  });

  it('is L1 with no model — the intended state of this build', () => {
    const at = assess();
    expect(at.rung).toBe('L1');
    expect(at.reason).toBe('no model provider configured');
    expect(at.kept.join(' ')).toContain('deterministic baseline');
  });

  it('reports the most severe binding constraint, not the first noticed', () => {
    // Everything is wrong at once; the chain outranks all of it.
    const broken = assess({
      modelAttached: false, networkUp: false, vaultUnlocked: false,
      storageWritable: false, chainIntact: false,
    });
    expect(broken.rung).toBe('L6');
    expect(broken.reason).toContain('hash chain');
  });

  it('walks down one rung at a time as each signal fails', () => {
    expect(assess({ ...healthy }).rung).toBe('L0');
    expect(assess({ ...healthy, modelReachable: false }).rung).toBe('L1');
    expect(assess({ ...healthy, credentialsValid: false }).rung).toBe('L2');
    expect(assess({ ...healthy, networkUp: false }).rung).toBe('L3');
    expect(assess({ ...healthy, vaultUnlocked: false }).rung).toBe('L4');
    expect(assess({ ...healthy, storageWritable: false }).rung).toBe('L5');
    expect(assess({ ...healthy, chainIntact: false }).rung).toBe('L6');
  });

  it('a configured model that cannot be reached is no better than none', () => {
    expect(assess({ ...healthy, modelReachable: false }).rung).toBe(assess({ ...healthy, modelAttached: false }).rung);
  });

  it('every rung below the top says what was lost and what remains', () => {
    for (const signals of [
      { ...healthy, modelAttached: false },
      { ...healthy, credentialsValid: false },
      { ...healthy, networkUp: false },
      { ...healthy, vaultUnlocked: false },
      { ...healthy, storageWritable: false },
      { ...healthy, chainIntact: false },
    ]) {
      const at = assess(signals);
      expect(at.lost.length, at.rung).toBeGreaterThan(0);
      expect(at.kept.length, at.rung).toBeGreaterThan(0);
      expect(at.label.length, at.rung).toBeGreaterThan(8);
    }
  });

  it('explains itself as the state of the machine, not as a refusal', () => {
    const text = explain(assess({ ...healthy, vaultUnlocked: false }));
    expect(text).toContain('the vault is locked');
    expect(text.toLowerCase()).not.toContain('permission denied');
    expect(text).toContain('Unavailable:');
  });

  it('atLeast treats L0 as the highest rung', () => {
    expect(atLeast('L0', 'L2')).toBe(true);
    expect(atLeast('L2', 'L2')).toBe(true);
    expect(atLeast('L3', 'L2')).toBe(false);
  });

  it('is pure: the same signals give the same answer', () => {
    expect(assess({ networkUp: false })).toEqual(assess({ networkUp: false }));
  });

  it('declares exactly seven rungs, L0 through L6', () => {
    expect(RUNGS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  });
});
