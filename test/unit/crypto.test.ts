import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  TEST_ARGON2,
  WebCrypto,
  seededRandomSource,
  timingSafeEqual,
  zeroize,
} from '../../src/security/crypto.js';

const crypto = new WebCrypto(seededRandomSource(1), TEST_ARGON2);
const key = new Uint8Array(32).fill(7);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('AEAD', () => {
  it('round-trips and does not leave plaintext in the ciphertext', async () => {
    const sealed = await crypto.encrypt(key, text('the passphrase is swordfish'));
    expect(Buffer.from(sealed).toString('utf8')).not.toContain('swordfish');
    expect(new TextDecoder().decode(await crypto.decrypt(key, sealed))).toBe(
      'the passphrase is swordfish',
    );
  });

  it('rejects a tampered ciphertext', async () => {
    const sealed = await crypto.encrypt(key, text('authentic'));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
    await expect(crypto.decrypt(key, sealed)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('rejects the wrong key without saying why', async () => {
    const sealed = await crypto.encrypt(key, text('authentic'));
    const wrong = new Uint8Array(32).fill(9);
    await expect(crypto.decrypt(wrong, sealed)).rejects.toThrow('decryption failed');
  });

  it('binds the ciphertext to its AAD, so a blob cannot be moved between items', async () => {
    const sealed = await crypto.encrypt(key, text('item A content'), text('item:A'));
    await expect(crypto.decrypt(key, sealed, text('item:B'))).rejects.toBeInstanceOf(
      DecryptionError,
    );
    expect(new TextDecoder().decode(await crypto.decrypt(key, sealed, text('item:A')))).toBe(
      'item A content',
    );
  });

  it('never repeats a nonce across 10k encryptions with one key', async () => {
    const real = new WebCrypto(); // real randomness for this one, on purpose
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const sealed = await real.encrypt(key, text('x'));
      nonces.add(Buffer.from(sealed.subarray(0, 12)).toString('hex'));
    }
    expect(nonces.size).toBe(10_000);
  });

  it('refuses a key of the wrong length rather than padding it', async () => {
    await expect(crypto.encrypt(new Uint8Array(16), text('x'))).rejects.toThrow(/32 bytes/);
  });

  it('refuses a ciphertext too short to contain a nonce and a tag', async () => {
    await expect(crypto.decrypt(key, new Uint8Array(4))).rejects.toThrow(/too short/);
  });
});

describe('HKDF', () => {
  it('is deterministic for the same key and info', async () => {
    const a = await crypto.hkdf(key, 'arish/v1/index');
    const b = await crypto.hkdf(key, 'arish/v1/index');
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('separates domains — the index key is not the wrapping key', async () => {
    const index = await crypto.hkdf(key, 'arish/v1/index');
    const wrap = await crypto.hkdf(key, 'arish/v1/mdk-wrap');
    expect(Buffer.from(index).toString('hex')).not.toBe(Buffer.from(wrap).toString('hex'));
  });

  it('requires a domain separator, because an empty one defeats the hierarchy', async () => {
    await expect(crypto.hkdf(key, '')).rejects.toThrow(/domain separator/);
  });
});

describe('Argon2id', () => {
  it('is deterministic for a passphrase and salt', async () => {
    const salt = new Uint8Array(16).fill(3);
    const a = await crypto.deriveKey('correct horse battery', salt);
    const b = await crypto.deriveKey('correct horse battery', salt);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    expect(a).toHaveLength(32);
  });

  it('differs across salts, so two users with one passphrase get different keys', async () => {
    const a = await crypto.deriveKey('same passphrase', new Uint8Array(16).fill(1));
    const b = await crypto.deriveKey('same passphrase', new Uint8Array(16).fill(2));
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('refuses a salt short enough to be reused by chance', async () => {
    await expect(crypto.deriveKey('pass', new Uint8Array(8))).rejects.toThrow(/at least 16 bytes/);
  });
});

describe('helpers', () => {
  it('zeroize clears every buffer it is given and tolerates nulls', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    zeroize(a, null, b, undefined);
    expect([...a]).toEqual([0, 0, 0]);
    expect([...b]).toEqual([0, 0]);
  });

  it('timingSafeEqual compares correctly', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('the seeded random source is reproducible', () => {
    expect([...seededRandomSource(5)(8)]).toEqual([...seededRandomSource(5)(8)]);
  });
});
