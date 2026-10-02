import { webcrypto } from 'node:crypto';

// Node exposes the WebCrypto DOM types under `webcrypto`; alias them so the
// file does not depend on a `dom` lib being in tsconfig.
type AesGcmParams = webcrypto.AesGcmParams;
type CryptoKey = webcrypto.CryptoKey;
import { argon2id } from 'hash-wasm';
import type { CryptoPort } from '../substrate/ports.js';

/**
 * Cryptography, via Node webcrypto (§6) plus one WASM dependency for Argon2id.
 *
 * §6 says "Node webcrypto only" *and* "Argon2id for the passphrase KDF". Those
 * two cannot both hold: webcrypto has no Argon2id, in any runtime. See
 * `docs/decisions/009-*`. Everything else here — AES-256-GCM, HKDF, random —
 * is webcrypto exactly as specified.
 */

const subtle = webcrypto.subtle;

export const NONCE_BYTES = 12; // AES-GCM standard; 96-bit nonces are the fast path
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;

export interface Argon2Params {
  memoryKib: number;
  iterations: number;
  parallelism: number;
}

/** OWASP's current floor for Argon2id. Overridden downward only in tests. */
export const PRODUCTION_ARGON2: Argon2Params = {
  memoryKib: 65_536,
  iterations: 3,
  parallelism: 1,
};

export type RandomSource = (bytes: number) => Uint8Array;

export class WebCrypto implements CryptoPort {
  constructor(
    private readonly random: RandomSource = (n) => webcrypto.getRandomValues(new Uint8Array(n)),
    private readonly argon2: Argon2Params = PRODUCTION_ARGON2,
  ) {}

  randomBytes(n: number): Uint8Array {
    return this.random(n);
  }

  /**
   * Returns `nonce || ciphertext || tag` as one buffer.
   *
   * Keeping the nonce with the ciphertext means a caller cannot store them in
   * two columns and then lose one. The nonce is random per call: at 96 bits
   * with a fresh key per item, collision probability is negligible, and the
   * alternative (a counter) needs durable state that could roll back after a
   * crash — which with GCM is catastrophic, not merely wrong.
   */
  async encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
    assertKey(key);
    const nonce = this.random(NONCE_BYTES);
    const cryptoKey = await importAes(key, 'encrypt');
    const params: AesGcmParams = { name: 'AES-GCM', iv: nonce, tagLength: TAG_BYTES * 8 };
    if (aad !== undefined) params.additionalData = aad;
    const sealed = new Uint8Array(await subtle.encrypt(params, cryptoKey, plaintext));

    const out = new Uint8Array(nonce.length + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, nonce.length);
    return out;
  }

  async decrypt(key: Uint8Array, payload: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
    assertKey(key);
    if (payload.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('ciphertext too short to be valid');
    }
    const nonce = payload.subarray(0, NONCE_BYTES);
    const sealed = payload.subarray(NONCE_BYTES);
    const cryptoKey = await importAes(key, 'decrypt');
    const params: AesGcmParams = { name: 'AES-GCM', iv: nonce, tagLength: TAG_BYTES * 8 };
    if (aad !== undefined) params.additionalData = aad;
    try {
      return new Uint8Array(await subtle.decrypt(params, cryptoKey, sealed));
    } catch {
      // Deliberately uniform: never report *why* decryption failed. A message
      // distinguishing "wrong key" from "tampered tag" is an oracle.
      throw new DecryptionError();
    }
  }

  /**
   * Argon2id. `iterations` overrides the configured cost when passed, which is
   * only used to run the suite at a lower cost (D-010).
   */
  async deriveKey(passphrase: string, salt: Uint8Array, iterations?: number): Promise<Uint8Array> {
    if (salt.length < 16) throw new Error('Argon2id salt must be at least 16 bytes');
    const hex = await argon2id({
      password: passphrase,
      salt,
      parallelism: this.argon2.parallelism,
      iterations: iterations ?? this.argon2.iterations,
      memorySize: this.argon2.memoryKib,
      hashLength: KEY_BYTES,
      outputType: 'binary',
    });
    return new Uint8Array(hex);
  }

  /**
   * HKDF-SHA256. `info` is the domain separator and is *mandatory* here — the
   * whole point of the hierarchy is that the MDK-wrapping key and the index
   * key cannot be each other.
   */
  async hkdf(key: Uint8Array, info: string, length = KEY_BYTES): Promise<Uint8Array> {
    if (info.length === 0) throw new Error('hkdf: info must be a non-empty domain separator');
    const base = await subtle.importKey('raw', copy(key), 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        // Salt is empty by design: the input key material is already a
        // high-entropy key, not a password. RFC 5869 §3.1 covers this case.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(info),
      },
      base,
      length * 8,
    );
    return new Uint8Array(bits);
  }
}

/** Uniform failure. Carries no information about the cause. */
export class DecryptionError extends Error {
  constructor() {
    super('decryption failed');
    this.name = 'DecryptionError';
  }
}

/**
 * Overwrite key material in place.
 *
 * Honest about what this does and does not achieve: it clears *this* buffer.
 * It cannot reach copies the JIT or the garbage collector may have made, and
 * it cannot touch anything that became a JS string. That is why secrets are
 * `Uint8Array` everywhere inside the vault boundary (D-012).
 */
export function zeroize(...buffers: Array<Uint8Array | undefined | null>): void {
  for (const b of buffers) {
    if (b) b.fill(0);
  }
}

/** Constant-time comparison, for anything an attacker can submit repeatedly. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

async function importAes(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return subtle.importKey('raw', copy(key), 'AES-GCM', false, [usage]);
}

/** webcrypto rejects views over a larger buffer in some paths; copy defensively. */
function copy(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

/** Deterministic randomness for tests. Never used in production wiring. */
export function seededRandomSource(seed = 1): RandomSource {
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

/** Argon2id at a cost the test suite can afford. Production uses the default. */
export const TEST_ARGON2: Argon2Params = { memoryKib: 8_192, iterations: 1, parallelism: 1 };
