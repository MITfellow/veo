import { describe, expect, it } from 'vitest';
import { canonicalJson, GENESIS_HASH, hashEvent } from '../../src/substrate/events/hash.js';
import { FakeCrypto } from '../fakes/crypto.js';
import type { StoredEvent } from '../../src/substrate/events/types.js';

describe('canonical JSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys at every depth', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }))
      .toBe('{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}');
  });

  it('rejects undefined rather than silently dropping it', () => {
    // {a: undefined} and {} must not hash the same while comparing unequal.
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
  });

  it('drops undefined object members but keeps the rest stable', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
  });

  it('rejects bigint', () => {
    expect(() => canonicalJson(1n)).toThrow(/bigint/);
  });
});

const base: Omit<StoredEvent, 'hash'> = {
  seq: 1, id: '01', type: 'session.started', ts: 1000, actor: 'user:ara', trust: 'USER',
  sessionId: 's1', runId: null, correlationId: null, causationId: null,
  schemaVersion: 1, payload: { channel: 'veo' }, prevHash: GENESIS_HASH,
};

describe('hashEvent', () => {
  const crypto = new FakeCrypto();

  it('covers every envelope field', () => {
    const original = hashEvent(crypto, base);
    const fields: Array<Partial<StoredEvent>> = [
      { seq: 2 }, { id: '02' }, { ts: 1001 }, { actor: 'user:other' },
      { trust: 'FOREIGN' }, { sessionId: 's2' }, { runId: 'r1' },
      { correlationId: 'c1' }, { causationId: 'x1' }, { schemaVersion: 2 },
      { payload: { channel: 'cli' } }, { prevHash: 'f'.repeat(64) },
    ];
    for (const change of fields) {
      expect(hashEvent(crypto, { ...base, ...change })).not.toBe(original);
    }
  });

  it('is stable across payload key order', () => {
    const a = hashEvent(crypto, { ...base, payload: { x: 1, y: 2 } });
    const b = hashEvent(crypto, { ...base, payload: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });
});
