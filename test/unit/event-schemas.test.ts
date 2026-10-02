import { describe, expect, it } from 'vitest';
import {
  EVENT_SCHEMAS,
  EVENT_TYPES,
  type EventType,
  atLeastTrust,
  isEventType,
  minTrust,
} from '../../src/substrate/events/types.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

describe('the event type union is closed and total', () => {
  it('has a payload schema for every declared type', () => {
    for (const type of EVENT_TYPES) {
      expect(EVENT_SCHEMAS[type], `no schema for ${type}`).toBeDefined();
      expect(typeof EVENT_SCHEMAS[type].safeParse).toBe('function');
    }
    expect(EVENT_TYPES.length).toBeGreaterThan(40);
  });

  it('uses dotted namespaces consistently, so the log stays greppable', () => {
    for (const type of EVENT_TYPES) {
      expect(type, `${type} is not namespaced`).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    }
  });

  it('rejects a type it does not know', () => {
    expect(isEventType('session.created')).toBe(true);
    expect(isEventType('session.exploded')).toBe(false);
  });
});

describe('payload validation happens before any write', () => {
  it('throws on a payload that fails its schema and leaves the log empty', () => {
    const s = createTestSubstrate();
    expect(() =>
      s.events.append({
        type: 'memory.written',
        // Missing sources — invariant 5 says a fact without provenance is not a fact.
        payload: {
          factId: 'f1',
          subject: 'user',
          predicate: 'works_at',
          object: 'Acme',
          basis: 'observed',
          confidence: 0.9,
          sources: [],
          validFrom: 0,
        } as never,
        principal: 'system',
        trust: 'DERIVED',
      }),
    ).toThrow(/invalid payload for memory.written/);
    expect(s.events.count()).toBe(0);
    s.close();
  });

  it('rejects a confidence outside [0,1]', () => {
    const s = createTestSubstrate();
    expect(() =>
      s.events.append({
        type: 'memory.written',
        payload: {
          factId: 'f1',
          subject: 'user',
          predicate: 'likes',
          object: 'tea',
          basis: 'observed',
          confidence: 1.5,
          sources: [{ eventId: 'e1' }],
          validFrom: 0,
        },
        principal: 'system',
        trust: 'DERIVED',
      }),
    ).toThrow(/confidence/);
    s.close();
  });

  it('rejects an unknown event type at runtime as well as at compile time', () => {
    const s = createTestSubstrate();
    expect(() =>
      s.events.append({
        type: 'session.exploded' as EventType,
        payload: {} as never,
        principal: 'system',
        trust: 'SYSTEM',
      }),
    ).toThrow(/unknown event type|invalid payload/);
    s.close();
  });

  it('applies schema defaults, so a stored payload is always complete', () => {
    const s = createTestSubstrate();
    const e = s.events.append({
      type: 'message.user',
      payload: { text: 'hello' }, // attachments omitted
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });
    expect((e.payload as { attachments: string[] }).attachments).toEqual([]);
    s.close();
  });
});

describe('the trust lattice', () => {
  it('orders SYSTEM > USER > DERIVED > TOOL > FOREIGN', () => {
    expect(atLeastTrust('SYSTEM', 'FOREIGN')).toBe(true);
    expect(atLeastTrust('FOREIGN', 'TOOL')).toBe(false);
    expect(atLeastTrust('USER', 'USER')).toBe(true);
  });

  it('takes the minimum, so trust can never increase along a chain', () => {
    expect(minTrust('SYSTEM', 'USER')).toBe('USER');
    expect(minTrust('USER', 'FOREIGN', 'DERIVED')).toBe('FOREIGN');
    expect(minTrust('SYSTEM')).toBe('SYSTEM');
  });
});
