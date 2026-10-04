import { argon2id } from 'hash-wasm';

/**
 * The only file in the platform that imports `hash-wasm` (decision 005).
 *
 * `webcrypto` has PBKDF2 and HKDF but no Argon2id — it is not in the W3C
 * algorithm registry at all — and §11 forbids writing our own. Everything
 * else in this file is deliberately thin so that swapping the implementation
 * later (native `argon2`, or a future `webcrypto` Argon2id) is a change to
 * one function.
 */

export interface Argon2Params {
  /** Memory cost in MiB. §D.4 ships 64. */
  memMiB: number;
  iterations: number;
  parallelism: number;
}

/** §D.4's shipping defaults. A test asserts these are what config produces. */
export const SHIPPING_ARGON2: Argon2Params = { memMiB: 64, iterations: 3, parallelism: 1 };

/**
 * Cheap parameters for tests.
 *
 * This is not weakening a test (§H.3): the subject under test is the key
 * hierarchy, not Argon2's cost factor, and §57 budgets the entire suite at
 * 60 s while one shipping-strength derivation costs ~330 ms. The cost factor
 * itself is covered by asserting the config defaults.
 */
export const TEST_ARGON2: Argon2Params = { memMiB: 8, iterations: 1, parallelism: 1 };

export const ROOT_KEY_BYTES = 32;
export const SALT_BYTES = 16;

/**
 * passphrase + salt → Root Key.
 *
 * The Root Key never persists and never leaves memory (§23). It exists only
 * to unwrap, and is zeroized on lock.
 */
export async function deriveRootKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2Params,
): Promise<Uint8Array> {
  if (salt.length < SALT_BYTES) throw new Error(`kdf: salt must be at least ${SALT_BYTES} bytes`);
  const hash = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memMiB * 1024,
    hashLength: ROOT_KEY_BYTES,
    outputType: 'binary',
  });
  return new Uint8Array(hash);
}
