import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../fakes/substrate.js';
import { EventError } from '../../src/substrate/events/types.js';
import { GENESIS_HASH } from '../../src/substrate/events/hash.js';

function session(s: ReturnType<typeof createTestSubstrate>, id: string) {
  return s.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: id, payload: { channel: 'veo' } });
}

describe('event log — append', () => {
  it('assigns seq monotonically from 1', () => {
    const s = createTestSubstrate();
    expect(session(s, 'a').seq).toBe(1);
    expect(session(s, 'b').seq).toBe(2);
    expect(session(s, 'c').seq).toBe(3);
    s.close();
  });

  it('chains the first event to the genesis hash', () => {
    const s = createTestSubstrate();
    expect(session(s, 'a').prevHash).toBe(GENESIS_HASH);
    s.close();
  });

  it('refuses an event type with no registered schema', () => {
    const s = createTestSubstrate();
    let caught: EventError | undefined;
    try {
      s.events.append({ type: 'schedule.fired', actor: 'user:ara', trust: 'USER', payload: {} });
    } catch (error) { caught = error as EventError; }
    expect(caught?.kind).toBe('unregistered_event_type');
    expect(s.events.count()).toBe(0);
    s.close();
  });

  it('refuses an invalid payload and stores nothing', () => {
    const s = createTestSubstrate();
    expect(() => s.events.append({ type: 'session.started', actor: 'u', trust: 'USER', payload: { channel: 42 } }))
      .toThrow(EventError);
    expect(s.events.count()).toBe(0);
    s.close();
  });

  it('rolls the event back when a projector throws', () => {
    // §15: the effect and its event commit together or not at all.
    const s = createTestSubstrate();
    s.events.register({
      name: 'exploder', tables: [],
      apply: () => { throw new Error('projector failed'); },
      reset: () => {},
    });
    expect(() => session(s, 'a')).toThrow(/projector failed/);
    expect(s.events.count()).toBe(0);
    s.close();
  });

  it('redacts before hashing, so the chain covers the stored bytes', () => {
    const s = createTestSubstrate();
    const event = s.events.append({
      type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: 'a',
      payload: { channel: 'veo', title: 'ok' },
    });
    expect(JSON.stringify(event.payload)).not.toContain('undefined');
    expect(s.events.verifyChain().ok).toBe(true);
    s.close();
  });
});

describe('event log — read', () => {
  function seeded() {
    const s = createTestSubstrate();
    session(s, 'a');
    s.clock.advanceSeconds(1);
    s.events.append({ type: 'message.received', actor: 'user:ara', trust: 'USER', sessionId: 'a', payload: { messageId: 'm1', role: 'user', content: 'hi' } });
    s.events.append({ type: 'message.sent', actor: 'agent', trust: 'DERIVED', sessionId: 'a', runId: 'r1', correlationId: 'c1', payload: { messageId: 'm2', role: 'agent', content: 'hello' } });
    session(s, 'b');
    return s;
  }

  it('filters by seq range', () => {
    const s = seeded();
    expect(s.events.read({ fromSeq: 2, toSeq: 3 }).map((e) => e.seq)).toEqual([2, 3]);
    s.close();
  });

  it('filters by session, run, correlation, type and trust', () => {
    const s = seeded();
    expect(s.events.read({ sessionId: 'a' })).toHaveLength(3);
    expect(s.events.read({ runId: 'r1' })).toHaveLength(1);
    expect(s.events.read({ correlationId: 'c1' })).toHaveLength(1);
    expect(s.events.read({ types: ['message.received', 'message.sent'] })).toHaveLength(2);
    expect(s.events.read({ trust: 'DERIVED' })).toHaveLength(1);
    s.close();
  });

  it('combines filters conjunctively and always orders by seq', () => {
    const s = seeded();
    const rows = s.events.read({ sessionId: 'a', types: ['message.received'] });
    expect(rows).toHaveLength(1);
    expect(s.events.read().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    s.close();
  });

  it('honours a limit', () => {
    const s = seeded();
    expect(s.events.read({ limit: 2 })).toHaveLength(2);
    s.close();
  });
});

describe('event log — hash chain (§15)', () => {
  it('verifies across 1,000 events', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 1000; i++) {
      s.clock.advance(10);
      s.events.append({ type: 'capture.received', actor: 'user:ara', trust: 'FOREIGN', payload: { captureId: `c${i}`, source: 'paste', kind: 'text', content: `item ${i}` } });
    }
    const result = s.events.verifyChain();
    expect(result).toEqual({ ok: true, events: 1000 });
    s.close();
  });

  it('detects a tampered payload and names the sequence number', () => {
    const s = createTestSubstrate();
    session(s, 'a'); session(s, 'b'); session(s, 'c');
    s.storage.prepare(`UPDATE events SET payload = ? WHERE seq = 2`).run(JSON.stringify({ channel: 'tampered' }));
    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toMatch(/does not match its hash/);
    }
    s.close();
  });

  it('detects a deleted event', () => {
    const s = createTestSubstrate();
    session(s, 'a'); session(s, 'b'); session(s, 'c');
    s.storage.prepare('DELETE FROM events WHERE seq = 2').run();
    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/gap/);
    s.close();
  });

  it('detects a reordered chain', () => {
    const s = createTestSubstrate();
    session(s, 'a'); session(s, 'b');
    s.storage.prepare(`UPDATE events SET prev_hash = ? WHERE seq = 2`).run('f'.repeat(64));
    const result = s.events.verifyChain();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/prevHash/);
    s.close();
  });
});
