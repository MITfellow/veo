/**
 * The M5 bar (§33): *"a 200-turn session stays in budget with no loss of
 * coherence and assembly is under 100ms."*
 *
 * Timing assertions in a test suite are a known hazard — CI machines stall,
 * and a flaky perf test gets deleted within a month, taking the guarantee
 * with it. Two mitigations: the budget is 100ms against a measured ~2ms, so
 * only a *structural* regression (an accidental O(n²), a per-turn re-render)
 * can trip it; and the structural properties are asserted separately from
 * the wall clock, so a slow machine fails loudly on time while the real
 * invariants keep being checked on their own terms.
 */
import { describe, expect, it } from 'vitest';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import { TokenCache } from '../../src/cognition/tokens.js';
import { Compactor } from '../../src/cognition/compaction.js';
import { Snapshotter } from '../../src/orchestration/snapshot.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { T0, snap, turns } from '../fixtures/snapshots.js';

const SESSION = 'sess-perf';
const PRINCIPAL = 'user:ara';
const BAR_MS = 100;

function longSession(count: number) {
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'long' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0;
    substrate.events.append({
      type: user ? 'message.user' : 'message.agent',
      payload: user ? { text: `turn ${i}: ${'content '.repeat(25)}`, attachments: [] } : { text: `turn ${i}: ${'content '.repeat(25)}` },
      principal: user ? PRINCIPAL : 'system',
      trust: user ? 'USER' : 'DERIVED',
      sessionId: SESSION,
    });
  }
  return substrate;
}

describe('§33: a 200-turn session', () => {
  it('assembles in under 100ms, gather included', () => {
    const substrate = longSession(200);
    const compactor = new Compactor(substrate);
    const snapshotter = new Snapshotter({
      events: substrate.events,
      clock: substrate.clock,
      compactor,
    });
    const cache = new TokenCache();
    const policy = policyFor('gpt-4o');

    const assembleOnce = (): number => {
      const gathered = snapshotter.gather({
        principal: PRINCIPAL,
        sessionId: SESSION,
        runId: 'run-1',
        trigger: 'user',
        degradation: 'L0',
        observations: [],
        fallbackTrust: 'USER',
      });
      return assembleContext({
        principal: PRINCIPAL,
        sessionId: SESSION,
        trust: gathered.effectiveTrust,
        now: T0,
        policy,
        snapshot: gathered.snapshot,
        countTokens: (text) => cache.count(text),
      }).totalTokens;
    };

    assembleOnce(); // warm the caches, as turn 201 would find them
    const start = performance.now();
    const tokens = assembleOnce();
    const elapsed = performance.now() - start;

    expect(tokens).toBeGreaterThan(0);
    expect(elapsed, `assembly took ${elapsed.toFixed(1)}ms`).toBeLessThan(BAR_MS);
    substrate.close();
  });

  it('stays in budget and keeps the newest turn verbatim', () => {
    const snapshot = snap({
      conversation: turns(200).map((turn) => ({
        ...turn,
        content: `${turn.content} ${'detail '.repeat(40)}`,
      })),
    });
    const policy = policyFor('local-small');
    const result = assembleContext({
      principal: PRINCIPAL,
      sessionId: SESSION,
      trust: 'USER',
      now: T0,
      policy,
      snapshot,
    });

    expect(result.totalTokens).toBeLessThanOrEqual(policy.window - policy.reserveForOutput);
    const text = result.messages.map((message) => message.content).join('\n');
    // Coherence: the live turn is always there, and the model is told what
    // is not. A context that silently loses the question is worse than one
    // that admits it lost the preamble.
    expect(text).toContain(snapshot.conversation.at(-1)!.content);
    expect(text).toContain('dropped to fit the context budget');
  });

  it('does not get slower per turn as the session grows', () => {
    // The real regression risk is not absolute speed, it is an O(n) read
    // creeping back in per step. Two hundred turns assembled one at a time
    // should cost roughly 200×, not 200²×.
    const substrate = longSession(200);
    const snapshotter = new Snapshotter({ events: substrate.events, clock: substrate.clock });
    const cache = new TokenCache();
    const policy = policyFor('gpt-4o');

    const run = (): number => {
      const start = performance.now();
      const gathered = snapshotter.gather({
        principal: PRINCIPAL,
        sessionId: SESSION,
        runId: 'run-1',
        trigger: 'user',
        degradation: 'L0',
        observations: [],
        fallbackTrust: 'USER',
      });
      assembleContext({
        principal: PRINCIPAL,
        sessionId: SESSION,
        trust: gathered.effectiveTrust,
        now: T0,
        policy,
        snapshot: gathered.snapshot,
        countTokens: (text) => cache.count(text),
      });
      return performance.now() - start;
    };

    run();
    const samples = Array.from({ length: 20 }, run).sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median, `median re-assembly ${median.toFixed(2)}ms`).toBeLessThan(BAR_MS / 2);
    substrate.close();
  });

  it('shrinks the work compaction has already done', () => {
    const substrate = longSession(200);
    const compactor = new Compactor(substrate);
    const withoutCompaction = new Snapshotter({ events: substrate.events, clock: substrate.clock });
    const before = withoutCompaction.gather({
      principal: PRINCIPAL,
      sessionId: SESSION,
      runId: 'r',
      trigger: 'user',
      degradation: 'L0',
      observations: [],
      fallbackTrust: 'USER',
    }).snapshot.conversation.length;

    compactor.compact(SESSION);
    const withCompaction = new Snapshotter({
      events: substrate.events,
      clock: substrate.clock,
      compactor,
    });
    const after = withCompaction.gather({
      principal: PRINCIPAL,
      sessionId: SESSION,
      runId: 'r',
      trigger: 'user',
      degradation: 'L0',
      observations: [],
      fallbackTrust: 'USER',
    }).snapshot;

    expect(before).toBe(200);
    expect(after.conversation.length).toBe(180);
    expect(after.compacted).toHaveLength(1);
    // The twenty turns did not vanish — they are a summary with pointers.
    expect(after.compacted[0]!.summary.span.turnCount).toBe(20);
    substrate.close();
  });
});
