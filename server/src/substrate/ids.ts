import type { CryptoPort, Ids } from './ports.js';

/**
 * ULID (§D.2 — hand-written, no dependency).
 *
 * 128 bits: 48 of millisecond timestamp, 80 of randomness, rendered as 26
 * Crockford base32 characters. The point of the format over a UUID is that
 * lexicographic order matches time order, so `ORDER BY id` and `ORDER BY seq`
 * agree and a snapshot digest can use either.
 *
 * That property is only true if ids are *monotonic within a millisecond*,
 * which is the part implementations usually skip. Two ulids requested in the
 * same tick with fresh randomness sort arbitrarily against each other. Here
 * the random field is incremented instead, so they sort by request order.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xff_ff_ff_ff_ff_ff) {
    throw new Error(`ulid: timestamp out of range: ${ms}`);
  }
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** Encode 10 bytes (80 bits) as 16 Crockford characters, most-significant first. */
function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Increment the 80-bit random field by one, with carry. Throws on overflow. */
function increment(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(new ArrayBuffer(bytes.length));
  next.set(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    const byte = next[i] ?? 0;
    if (byte < 0xff) {
      next[i] = byte + 1;
      return next;
    }
    next[i] = 0;
  }
  // 2^80 ids inside one millisecond. Not reachable; not silently wrapped.
  throw new Error('ulid: random field overflow within a single millisecond');
}

export function createIds(deps: { now(): number; crypto: CryptoPort }): Ids {
  let lastMs = -1;
  let lastRandom: Uint8Array = new Uint8Array(RANDOM_BYTES);

  return {
    ulid(): string {
      const ms = deps.now();
      if (ms === lastMs) {
        lastRandom = increment(lastRandom);
      } else {
        // A clock that moves backwards (a fake one often does) must still
        // produce increasing ids for a given tick, so the state resets on any
        // change rather than only on an increase.
        lastMs = ms;
        lastRandom = deps.crypto.randomBytes(RANDOM_BYTES);
      }
      return encodeTime(ms) + encodeRandom(lastRandom);
    },
  };
}

/** Recover the embedded timestamp. Used by tests and by `verify-chain` output. */
export function ulidTime(id: string): number {
  const time = id.slice(0, TIME_CHARS);
  let ms = 0;
  for (const char of time) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) throw new Error(`ulid: invalid character ${char}`);
    ms = ms * 32 + digit;
  }
  return ms;
}

export function isUlid(value: string): boolean {
  if (value.length !== TIME_CHARS + RANDOM_CHARS) return false;
  for (const char of value) if (!CROCKFORD.includes(char)) return false;
  return true;
}
