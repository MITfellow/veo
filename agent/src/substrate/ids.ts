import { randomBytes } from 'node:crypto';
import type { Clock, Ids } from './ports.js';

/**
 * ULIDs, implemented here rather than taken as a dependency.
 *
 * Every published implementation calls `Date.now()` and a global RNG directly,
 * which breaks the determinism rule in §8 — a seeded test run has to produce
 * the same ids every time. It is 40 lines; owning it is cheaper than owning a
 * dependency we would have to patch.
 *
 * Layout: 48-bit timestamp + 80 bits of randomness, Crockford base32, 26 chars.
 * Sortable by time; monotonic within a millisecond by incrementing the random
 * component, which is what keeps `ORDER BY id` equal to `ORDER BY seq`.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 281_474_976_710_655) {
    throw new RangeError(`ULID timestamp out of range: ${ms}`);
  }
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

export function decodeTime(ulid: string): number {
  let ms = 0;
  for (let i = 0; i < TIME_CHARS; i++) {
    const idx = ALPHABET.indexOf(ulid[i]!);
    if (idx < 0) throw new Error(`not a ULID: ${ulid}`);
    ms = ms * 32 + idx;
  }
  return ms;
}

/** Increments a base32 string in place, for monotonic ids inside one ms. */
function incrementBase32(s: string): string {
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ALPHABET.indexOf(chars[i]!);
    if (idx < 31) {
      chars[i] = ALPHABET[idx + 1]!;
      return chars.join('');
    }
    chars[i] = ALPHABET[0]!;
  }
  // 80 bits of randomness exhausted inside a single millisecond: not reachable
  // in practice, and silently wrapping would break sort order.
  throw new Error('ULID random component overflow within one millisecond');
}

export type RandomSource = (bytes: number) => Uint8Array;

export class UlidIds implements Ids {
  private lastTime = -1;
  private lastRandom = '';

  constructor(
    private readonly clock: Clock,
    private readonly random: RandomSource = (n) => new Uint8Array(randomBytes(n)),
  ) {}

  ulid(): string {
    const now = this.clock.now();
    if (now === this.lastTime) {
      this.lastRandom = incrementBase32(this.lastRandom);
    } else {
      // A clock that jumped backwards (NTP step, test rewind) must not produce
      // ids that sort before ones already issued, so time regression keeps the
      // previous timestamp and just increments the random part.
      if (now < this.lastTime && this.lastTime >= 0) {
        this.lastRandom = incrementBase32(this.lastRandom);
        return encodeTime(this.lastTime) + this.lastRandom;
      }
      this.lastTime = now;
      this.lastRandom = this.randomChars();
    }
    return encodeTime(this.lastTime) + this.lastRandom;
  }

  token(bytes = 32): string {
    return Buffer.from(this.random(bytes)).toString('base64url');
  }

  private randomChars(): string {
    const bytes = this.random(RANDOM_CHARS);
    let out = '';
    for (let i = 0; i < RANDOM_CHARS; i++) out += ALPHABET[bytes[i]! % 32];
    return out;
  }
}

/**
 * Deterministic ids for tests: a counter-driven PRNG (xorshift32) so a seeded
 * run is byte-identical, which is what `rebuild-identity` and the golden
 * context tests depend on.
 */
export function seededRandom(seed = 1): RandomSource {
  let state = seed >>> 0 || 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

export function fakeIds(clock: Clock, seed = 1): Ids {
  return new UlidIds(clock, seededRandom(seed));
}
