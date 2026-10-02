import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { snapshotDigest, snapshotProjections } from '../../src/substrate/projections/snapshot.js';
import { seedWorld } from '../fixtures/world.js';
import type { Projector } from '../../src/substrate/events/log.js';

/**
 * The M0 acceptance test.
 *
 * Append ten thousand events. Snapshot every projection. Destroy all of them.
 * Replay from the log alone. The snapshots must be byte-identical.
 *
 * If this ever fails, some piece of state is living only in a projection, and
 * a restore from the log would quietly produce a different agent than the one
 * that was backed up. This test is not to be weakened — if a new feature makes
 * it fail, the feature is wrong.
 */
describe('rebuild-identity', () => {
  it('rebuilds 10k events into a byte-identical world', () => {
    const s = createTestSubstrate();
    seedWorld(s, 10_000);

    expect(s.events.count()).toBe(10_000);
    const before = snapshotProjections(s.storage);
    expect(before.length).toBeGreaterThan(10_000); // the snapshot is substantive

    const counts = {
      sessions: s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')?.n ?? 0,
      messages: s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM messages')?.n ?? 0,
      runs: s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM runs')?.n ?? 0,
      facts: s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM facts')?.n ?? 0,
      entities: s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM entities')?.n ?? 0,
    };
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} should not be empty`).toBeGreaterThan(0);
    }

    // Destroy everything derived. Not "clear some rows" — every table.
    for (const table of ['sessions', 'messages', 'runs', 'entities', 'artifacts', 'facts', 'facts_fts']) {
      s.storage.exec(`DELETE FROM ${table}`);
    }
    expect(snapshotProjections(s.storage)).not.toBe(before);

    const replayed = s.events.rebuild();
    expect(replayed).toBe(10_000);

    const after = snapshotProjections(s.storage);
    expect(after).toBe(before);
    expect(snapshotDigest(s.storage, s.hashing)).toBe(s.hashing.sha256Hex(before));
    s.close();
  });

  it('is idempotent: rebuilding twice changes nothing', () => {
    const s = createTestSubstrate();
    seedWorld(s, 600);
    const once = (s.events.rebuild(), snapshotProjections(s.storage));
    const twice = (s.events.rebuild(), snapshotProjections(s.storage));
    expect(twice).toBe(once);
    s.close();
  });

  it('does not depend on the clock at replay time', () => {
    // Projectors must take timestamps from the event, never from `now`. If one
    // ever reaches for the clock, this catches it.
    const s = createTestSubstrate();
    seedWorld(s, 400);
    const before = snapshotProjections(s.storage);
    s.clock.advanceYears(5);
    s.events.rebuild();
    expect(snapshotProjections(s.storage)).toBe(before);
    s.close();
  });

  it('lets a projection added years later rebuild from historical events alone', () => {
    const s = createTestSubstrate();
    seedWorld(s, 500);

    // A projection nobody had thought of when the events were written.
    s.storage.exec(`CREATE TABLE late_stats (type TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
    const latecomer: Projector = {
      name: 'late_stats',
      version: 1,
      handles: '*',
      reset: (storage) => storage.exec('DELETE FROM late_stats'),
      apply: (e, storage) =>
        void storage.run(
          `INSERT INTO late_stats (type, n) VALUES (?, 1)
           ON CONFLICT(type) DO UPDATE SET n = late_stats.n + 1`,
          [e.type],
        ),
    };
    s.events.register(latecomer);

    expect(s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM late_stats')?.n).toBe(0);
    s.events.rebuild();

    const total =
      s.storage.get<{ n: number }>('SELECT SUM(n) AS n FROM late_stats')?.n ?? 0;
    expect(total).toBe(500);
    s.close();
  });

  it('keeps the hash chain intact across a rebuild', () => {
    const s = createTestSubstrate();
    seedWorld(s, 500);
    const head = s.events.head();
    s.events.rebuild();
    expect(s.events.head()).toEqual(head);
    expect(s.events.verifyChain().ok).toBe(true);
    s.close();
  });
});
