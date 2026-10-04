import { describe, expect, it } from 'vitest';
import { DecryptError, open, randomKey, seal, subkey, zeroize } from '../../src/security/box.js';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const read = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('AES-256-GCM', () => {
  it('round-trips', async () => {
    const key = randomKey();
    expect(read(await open(key, await seal(key, text('hello'))))).toBe('hello');
  });

  it('fails authentication with the wrong key', async () => {
    const sealed = await seal(randomKey(), text('hello'));
    await expect(open(randomKey(), sealed)).rejects.toBeInstanceOf(DecryptError);
  });

  it('fails authentication on a single tampered byte', async () => {
    const key = randomKey();
    const sealed = await seal(key, text('hello world'));
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0x01;
    await expect(open(key, sealed)).rejects.toBeInstanceOf(DecryptError);
  });

  it('binds the ciphertext to its AAD', async () => {
    // A row swapped in by someone with DB write access must not open.
    const key = randomKey();
    const sealed = await seal(key, text('api-key'), 'secret://stripe/1');
    await expect(open(key, sealed, 'secret://stripe/2')).rejects.toBeInstanceOf(DecryptError);
    expect(read(await open(key, sealed, 'secret://stripe/1'))).toBe('api-key');
  });

  it('never reuses a nonce — identical plaintexts seal differently', async () => {
    const key = randomKey();
    const a = await seal(key, text('same'));
    const b = await seal(key, text('same'));
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('rejects a key of the wrong length rather than padding it', async () => {
    await expect(seal(new Uint8Array(16), text('x'))).rejects.toThrow(/32 bytes/);
  });

  it('rejects a ciphertext too short to hold a nonce', async () => {
    await expect(open(randomKey(), new Uint8Array(4))).rejects.toBeInstanceOf(DecryptError);
  });
});

describe('HKDF subkeys', () => {
  it('are deterministic for the same parent and info', async () => {
    const parent = randomKey();
    expect(await subkey(parent, 'a')).toEqual(await subkey(parent, 'a'));
  });

  it('are independent across info strings', async () => {
    const parent = randomKey();
    expect(await subkey(parent, 'arish:index:v1')).not.toEqual(await subkey(parent, 'arish:kek:passphrase:v1'));
  });

  it('differ for different parents', async () => {
    expect(await subkey(randomKey(), 'x')).not.toEqual(await subkey(randomKey(), 'x'));
  });
});

describe('zeroize', () => {
  it('overwrites key material in place', () => {
    const key = randomKey();
    zeroize(key);
    expect([...key].every((b) => b === 0)).toBe(true);
  });

  it('tolerates undefined', () => {
    expect(() => zeroize(undefined)).not.toThrow();
  });
});
