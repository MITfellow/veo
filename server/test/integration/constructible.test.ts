import { describe, expect, it } from 'vitest';
import { createSubstrate } from '../../src/substrate/index.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { FakeLogger } from '../fakes/logger.js';

describe('§14 — constructible with fakes', () => {
  it('builds the whole substrate in under twenty lines', () => {
    // This test IS the requirement. If assembly ever grows past what fits
    // here comfortably, the composition root has acquired a dependency that
    // should have been a port.
    const clock = new FakeClock('2026-05-01T09:00:00Z');
    const crypto = new FakeCrypto();
    const log = new FakeLogger();
    const substrate = createSubstrate({ dbPath: ':memory:', clock, crypto, log });

    const event = substrate.events.append({
      type: 'session.started',
      actor: 'user:ara',
      trust: 'USER',
      sessionId: 's1',
      payload: { channel: 'veo' },
    });

    expect(event.seq).toBe(1);
    expect(event.ts).toBe(clock.now());
    expect(substrate.events.count()).toBe(1);
    substrate.close();
  });

  it('produces identical bytes on two independent runs', () => {
    // Determinism end to end: same fakes in, same hashes out.
    const build = () => {
      const s = createSubstrate({ dbPath: ':memory:', clock: new FakeClock(), crypto: new FakeCrypto(), log: new FakeLogger() });
      const e = s.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: 's1', payload: { channel: 'veo' } });
      s.close();
      return e;
    };
    const first = build();
    const second = build();
    expect(first.id).toBe(second.id);
    expect(first.hash).toBe(second.hash);
  });
});
