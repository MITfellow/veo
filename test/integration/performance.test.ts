import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { seedWorld } from '../fixtures/world.js';

/**
 * Performance budgets from §32, asserted rather than hoped for.
 *
 * These are generous on purpose — they are regression detectors, not
 * benchmarks. A 10x slowdown from an accidental missing index should fail the
 * build; a 20% difference between a laptop and CI should not.
 */
describe('substrate performance budgets', () => {
  it('appends 10k events in a few seconds, including projections', () => {
    const s = createTestSubstrate();
    const started = performance.now();
    seedWorld(s, 10_000);
    const elapsed = performance.now() - started;
    expect(s.events.count()).toBe(10_000);
    expect(elapsed, `append of 10k took ${elapsed.toFixed(0)}ms`).toBeLessThan(10_000);
    s.close();
  });

  it('queries projections well under the 100ms interactive budget', () => {
    const s = createTestSubstrate();
    seedWorld(s, 10_000);

    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };

    const recentSessions = timed(() =>
      s.storage.all('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50'),
    );
    const sessionMessages = timed(() =>
      s.storage.all('SELECT * FROM messages WHERE session_id = ? ORDER BY seq LIMIT 100', ['sess-00007']),
    );
    const factLookup = timed(() =>
      s.storage.all(
        "SELECT * FROM facts WHERE subject = 'Maya' AND superseded_at IS NULL ORDER BY confidence DESC",
      ),
    );
    const eventTail = timed(() => s.events.read({ reverse: true, limit: 100 }));

    expect(recentSessions).toBeLessThan(100);
    expect(sessionMessages).toBeLessThan(100);
    expect(factLookup).toBeLessThan(100);
    expect(eventTail).toBeLessThan(100);
    s.close();
  });

  it('verifies a 10k-event chain in reasonable time', () => {
    const s = createTestSubstrate();
    seedWorld(s, 10_000);
    const t = performance.now();
    const result = s.events.verifyChain();
    const elapsed = performance.now() - t;
    expect(result.ok).toBe(true);
    expect(elapsed, `verifyChain took ${elapsed.toFixed(0)}ms`).toBeLessThan(5_000);
    s.close();
  });
});
