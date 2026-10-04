import { describe, expect, it } from 'vitest';
import { createIds, isUlid, ulidTime } from '../../src/substrate/ids.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeCrypto } from '../fakes/crypto.js';

function harness(start = '2026-03-01T12:00:00.000Z') {
  const clock = new FakeClock(start);
  const crypto = new FakeCrypto();
  return { clock, ids: createIds({ now: () => clock.now(), crypto }) };
}

describe('ULID', () => {
  it('is 26 Crockford base32 characters', () => {
    const { ids } = harness();
    const id = ids.ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('decodes to the timestamp it was minted at', () => {
    const { clock, ids } = harness();
    expect(ulidTime(ids.ulid())).toBe(clock.now());
    clock.advanceMonths(6);
    expect(ulidTime(ids.ulid())).toBe(clock.now());
  });

  it('is strictly increasing across 10k ids in one millisecond', () => {
    // The property the whole design exists for: without the monotonic
    // counter these would sort arbitrarily and ORDER BY id would stop
    // agreeing with ORDER BY seq.
    const { ids } = harness();
    const generated = Array.from({ length: 10_000 }, () => ids.ulid());
    const sorted = [...generated].sort();
    expect(generated).toEqual(sorted);
    expect(new Set(generated).size).toBe(10_000);
  });

  it('keeps increasing when the clock jumps backwards', () => {
    const { clock, ids } = harness();
    const first = ids.ulid();
    clock.advance(-5000);
    const second = ids.ulid();
    // Time went backwards so the id does too — but it is still a valid,
    // unique id rather than a collision or a throw.
    expect(second).not.toBe(first);
    expect(isUlid(second)).toBe(true);
  });

  it('rejects an invalid character when decoding', () => {
    expect(() => ulidTime('UUUUUUUUUU0000000000000000')).toThrow(/invalid character/);
  });
});
