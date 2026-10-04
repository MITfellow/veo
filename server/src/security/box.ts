import { webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';

/**
 * AES-256-GCM, from `webcrypto` only (§11).
 *
 * Every sealed value carries its own random 96-bit nonce, prefixed to the
 * ciphertext. Reusing a nonce under the same key is the one catastrophic
 * mistake available with GCM, so the nonce is never a parameter — callers
 * cannot supply one even by accident.
 *
 * `aad` (additional authenticated data) binds a ciphertext to its context:
 * a secret sealed for `name@2` will not open as `name@3`, even under the
 * correct key. This stops a swap attack against someone with write access to
 * the database but not the key.
 */

export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

// `CryptoKey` is a DOM global; §D.2 excludes the "dom" lib because this is a
// server. Node re-exports the type under the `webcrypto` namespace.
async function importKey(raw: Uint8Array): Promise<WebCrypto.CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error(`box: key must be ${KEY_BYTES} bytes, got ${raw.length}`);
  return webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encoded(aad: string | undefined): Uint8Array | undefined {
  return aad === undefined ? undefined : new TextEncoder().encode(aad);
}

/** Returns `nonce || ciphertext || tag`. */
export async function seal(key: Uint8Array, plaintext: Uint8Array, aad?: string): Promise<Uint8Array> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const extra = encoded(aad);
  const cipher = await webcrypto.subtle.encrypt(
    extra === undefined ? { name: 'AES-GCM', iv: nonce } : { name: 'AES-GCM', iv: nonce, additionalData: extra },
    await importKey(key),
    plaintext,
  );
  const out = new Uint8Array(NONCE_BYTES + cipher.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(cipher), NONCE_BYTES);
  return out;
}

export async function open(key: Uint8Array, sealed: Uint8Array, aad?: string): Promise<Uint8Array> {
  if (sealed.length <= NONCE_BYTES) throw new DecryptError('box: ciphertext too short to contain a nonce');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const body = sealed.subarray(NONCE_BYTES);
  const extra = encoded(aad);
  try {
    const plain = await webcrypto.subtle.decrypt(
      extra === undefined ? { name: 'AES-GCM', iv: nonce } : { name: 'AES-GCM', iv: nonce, additionalData: extra },
      await importKey(key),
      body,
    );
    return new Uint8Array(plain);
  } catch {
    // Deliberately opaque: distinguishing "wrong key" from "tampered" leaks
    // information, and both are the same failure to the caller.
    throw new DecryptError('authentication failed: wrong key, wrong context, or tampered ciphertext');
  }
}

/**
 * HKDF-SHA256 subkey derivation.
 *
 * `info` separates domains so that the index key and a wrapping key derived
 * from the same parent are cryptographically independent.
 */
export async function subkey(parent: Uint8Array, info: string, bytes = KEY_BYTES): Promise<Uint8Array> {
  const key = await webcrypto.subtle.importKey('raw', parent, 'HKDF', false, ['deriveBits']);
  const derived = await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(derived);
}

export function randomKey(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

/**
 * Overwrite key material in place.
 *
 * This is best-effort in a garbage-collected runtime — V8 may have copied the
 * buffer — but it bounds the window in which a heap dump yields a live key,
 * and it makes "zeroized on lock" (§23) a thing the code actually does rather
 * than a thing the documentation claims.
 */
export function zeroize(...buffers: Array<Uint8Array | undefined>): void {
  for (const buffer of buffers) buffer?.fill(0);
}
