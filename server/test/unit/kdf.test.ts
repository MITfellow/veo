import { describe, expect, it } from 'vitest';
import { deriveRootKey, SHIPPING_ARGON2, TEST_ARGON2 } from '../../src/security/kdf.js';
import { ConfigSchema } from '../../src/substrate/config.js';

const salt = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);

describe('Argon2id (decision 005)', () => {
  it('is deterministic for the same passphrase, salt and params', async () => {
    const a = await deriveRootKey('passphrase', salt(7), TEST_ARGON2);
    const b = await deriveRootKey('passphrase', salt(7), TEST_ARGON2);
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
  });

  it('differs on salt', async () => {
    expect(await deriveRootKey('p', salt(1), TEST_ARGON2)).not.toEqual(await deriveRootKey('p', salt(2), TEST_ARGON2));
  });

  it('differs on passphrase', async () => {
    expect(await deriveRootKey('a', salt(1), TEST_ARGON2)).not.toEqual(await deriveRootKey('b', salt(1), TEST_ARGON2));
  });

  it('rejects a short salt', async () => {
    await expect(deriveRootKey('p', new Uint8Array(4), TEST_ARGON2)).rejects.toThrow(/salt/);
  });

  it('ships at §D.4 cost parameters, whatever the tests use', async () => {
    // The cost factor is the one thing the cheap test params do not cover,
    // so it is asserted directly rather than exercised.
    expect(SHIPPING_ARGON2).toEqual({ memMiB: 64, iterations: 3, parallelism: 1 });
    expect(ConfigSchema.parse({}).argon2).toEqual(SHIPPING_ARGON2);
    expect(TEST_ARGON2.memMiB).toBeLessThan(SHIPPING_ARGON2.memMiB);
  });
});
