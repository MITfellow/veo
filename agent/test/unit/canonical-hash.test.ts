import { describe, expect, it } from 'vitest';
import { NodeHashing, canonicalJson } from '../../src/substrate/hash.js';

const hashing = new NodeHashing();
const h = (v: unknown): string => hashing.sha256Hex(canonicalJson(v));

describe('canonical JSON', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is insensitive to property insertion order', () => {
    const one: Record<string, unknown> = {};
    one.z = 1;
    one.a = { y: [3, 2, 1], x: 'q' };
    const two: Record<string, unknown> = {};
    two.a = { x: 'q', y: [3, 2, 1] };
    two.z = 1;
    expect(h(one)).toBe(h(two));
  });

  it('treats an absent key and an explicitly undefined key as the same', () => {
    expect(h({ a: 1 })).toBe(h({ a: 1, b: undefined }));
  });

  it('does not treat null as undefined — null is a value', () => {
    expect(h({ a: 1, b: null })).not.toBe(h({ a: 1 }));
  });

  it('keeps array order, which is information', () => {
    expect(h([1, 2, 3])).not.toBe(h([3, 2, 1]));
  });

  it('round-trips unicode and large integers', () => {
    const value = { emoji: '🜚 नमस्ते', big: 9_007_199_254_740_991, neg: -0 };
    expect(canonicalJson(value)).toBe('{"big":9007199254740991,"emoji":"🜚 नमस्ते","neg":0}');
  });

  it('encodes bigint and bytes distinguishably rather than dropping them', () => {
    expect(canonicalJson({ n: 10n })).toBe('{"n":{"$bigint":"10"}}');
    expect(canonicalJson({ b: new Uint8Array([1, 2, 3]) })).toBe('{"b":{"$bytes":"AQID"}}');
    // A bigint 10 and a number 10 are different things and must not collide.
    expect(h({ n: 10n })).not.toBe(h({ n: 10 }));
  });

  it('refuses values JSON would silently corrupt', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: new Date() })).toThrow(/Date is ambiguous/);
  });

  it('gives a stable hash for the same logical value across constructions', () => {
    const a = JSON.parse('{"x":[{"k":1},{"k":2}],"y":"z"}') as unknown;
    const b = { y: 'z', x: [{ k: 1 }, { k: 2 }] };
    expect(h(a)).toBe(h(b));
  });
});
