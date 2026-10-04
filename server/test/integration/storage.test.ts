import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSubstrate } from '../../src/substrate/index.js';
import { snapshotDigest } from '../../src/substrate/projections/index.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/substrate/storage/migrations.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { FakeLogger } from '../fakes/logger.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arish-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open(start = '2026-01-01T00:00:00Z') {
  const clock = new FakeClock(start);
  return {
    clock,
    substrate: createSubstrate({ dbPath: join(dir, 'arish.db'), clock, crypto: new FakeCrypto(), log: new FakeLogger() }),
  };
}

describe('durable storage', () => {
  it('migrates a fresh database to the current version', () => {
    const { substrate } = open();
    expect(substrate.storage.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
    substrate.close();
  });

  it('is in WAL mode', () => {
    const { substrate } = open();
    const mode = substrate.storage.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>();
    expect(mode?.journal_mode).toBe('wal');
    substrate.close();
  });

  it('survives a process-level reopen with the chain and projections intact', () => {
    // Crash-only design (§54): closing and reopening is ordinary, not recovery.
    const first = open();
    for (let i = 0; i < 100; i++) {
      first.clock.advance(1000);
      first.substrate.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: `s${i}`, payload: { channel: 'veo' } });
    }
    const digestBefore = snapshotDigest(first.substrate.storage, first.substrate.crypto).digest;
    const headBefore = first.substrate.events.head();
    first.substrate.close();

    const second = open();
    expect(second.substrate.events.count()).toBe(100);
    expect(second.substrate.events.head()).toEqual(headBefore);
    expect(second.substrate.events.verifyChain().ok).toBe(true);
    expect(snapshotDigest(second.substrate.storage, second.substrate.crypto).digest).toBe(digestBefore);
    second.substrate.close();
  });

  it('continues the hash chain across a reopen', () => {
    const first = open();
    const a = first.substrate.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: 'a', payload: { channel: 'veo' } });
    first.substrate.close();

    const second = open('2026-02-01T00:00:00Z');
    const b = second.substrate.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: 'b', payload: { channel: 'veo' } });
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(2);
    expect(second.substrate.events.verifyChain().ok).toBe(true);
    second.substrate.close();
  });

  it('running migrations twice is a no-op', () => {
    const first = open();
    first.substrate.close();
    const second = open();
    expect(second.substrate.storage.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
    second.substrate.close();
  });
});

describe('projector reset discipline', () => {
  it('each projector clears exactly the tables it declares', () => {
    const { substrate } = open();
    const owned = new Map<string, string[]>();
    for (const projector of substrate.events.projectors()) {
      for (const table of projector.tables) {
        const existing = owned.get(table) ?? [];
        existing.push(projector.name);
        owned.set(table, existing);
      }
    }
    // Two projectors sharing a table means one resets the other's rows and
    // the rebuild outcome depends on registration order.
    for (const [table, owners] of owned) {
      expect(owners, `${table} is owned by ${owners.join(' and ')}`).toHaveLength(1);
    }
    substrate.close();
  });
});
