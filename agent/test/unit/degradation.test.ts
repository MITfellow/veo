/**
 * Tests 25–31: the degradation ladder (§27).
 *
 * §27's claim is social, not technical: "a personal agent that is quietly
 * dumber today than yesterday destroys trust faster than one that is
 * honestly broken." So the tests are mostly about what gets *said* — that
 * a transition is recorded, that recovery from one fault does not announce
 * full health while another is outstanding, and that the user is told
 * which mode they are in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEVEL_MEANING } from '../../src/orchestration/degradation.js';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import { snap, T0 } from '../fixtures/snapshots.js';
import { harness, type SchedulingHarness } from '../fixtures/scheduling.js';

let h: SchedulingHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const changes = () => h.substrate.events.read({ types: ['degradation.changed'] });

describe('the ladder', () => {
  it('25. a healthy system is L0 with nothing to report', () => {
    expect(h.degradation.current()).toBe('L0');
    expect(h.degradation.state().signals).toHaveLength(0);
    expect(changes()).toHaveLength(0);
  });

  it('26. an embedder failure is L1, and it is announced', () => {
    expect(h.degradation.report('embedder', 'connection refused')).toBe('L1');
    const [event] = changes();
    expect(event).toBeDefined();
    const payload = event!.payload as { from: string; to: string; signal: string; detail: string };
    expect(payload.from).toBe('L0');
    expect(payload.to).toBe('L1');
    expect(payload.signal).toBe('embedder');
    expect(payload.detail).toContain('connection refused');
  });

  it('27. the level is the worst active signal, not the latest', () => {
    h.degradation.report('vault', 'locked');
    expect(h.degradation.current()).toBe('L4');
    // A *less* serious fault arriving later must not improve the level.
    h.degradation.report('embedder', 'down');
    expect(h.degradation.current()).toBe('L4');
    expect(h.degradation.state().signals.map((s) => s.signal)).toEqual(['vault', 'embedder']);
  });

  it('28. clearing one fault falls to the next-worst, not to L0', () => {
    h.degradation.report('embedder', 'down');
    h.degradation.report('storage', 'disk full');
    expect(h.degradation.current()).toBe('L3');

    h.degradation.clear('storage');
    // The bug this guards against is a settable level, where the last
    // caller wins and the agent announces full health with an embedder
    // still on the floor.
    expect(h.degradation.current()).toBe('L1');
    h.degradation.clear('embedder');
    expect(h.degradation.current()).toBe('L0');
    expect(changes().map((e) => (e.payload as { to: string }).to)).toEqual(['L1', 'L3', 'L1', 'L0']);
  });

  it('29. the same fault reported twice is one event, not a flood', () => {
    for (let i = 0; i < 50; i += 1) h.degradation.report('embedder', 'connection refused');
    expect(changes()).toHaveLength(1);

    // A *different* detail at the same level is still not a transition —
    // the level did not move, so there is nothing new to tell anyone.
    h.degradation.report('embedder', 'timeout');
    expect(changes()).toHaveLength(1);
  });

  it('30. every transition records where it came from, where it went, and why', () => {
    h.degradation.report('model', 'provider 503');
    h.degradation.report('vault', 'locked by user');
    h.degradation.clear('vault');

    const payloads = changes().map((e) => e.payload as { from: string; to: string; active: string[] });
    expect(payloads.map((p) => `${p.from}->${p.to}`)).toEqual(['L0->L2', 'L2->L4', 'L4->L2']);
    expect(payloads[2]!.active).toEqual(['model']);
  });

  it('31. the context tells the user which mode they are in', () => {
    const context = assembleContext({
      principal: 'user:ara',
      sessionId: 'ses-1',
      trust: 'USER',
      now: T0,
      policy: policyFor('golden-model', { window: 4_000, reserveForOutput: 0 }),
      snapshot: snap({ situation: { ...snap().situation, degradation: 'L2' } }),
    });

    const situation = context.messages.map((m) => m.content).join('\n');
    expect(situation).toMatch(/fallback|degraded|reduced/i);
    // And the same words the HTTP surface uses, so "which mode am I in"
    // has one answer rather than two.
    expect(LEVEL_MEANING.L2).toContain('fallback');
    expect(Object.keys(LEVEL_MEANING)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });
});
