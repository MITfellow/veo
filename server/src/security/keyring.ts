import type { Storage } from '../substrate/ports.js';
import { DecryptError, open, randomBytes, randomKey, seal, subkey, zeroize } from './box.js';
import { type Argon2Params, deriveRootKey, SALT_BYTES } from './kdf.js';

/**
 * The key hierarchy (§23, as corrected by decision 006).
 *
 *   passphrase ──Argon2id(salt_p)──▶ Root Key ──HKDF──▶ KEK_passphrase ─┐
 *                                                                        ├─▶ unwraps MDK
 *   recovery   ──Argon2id(salt_r)──▶ Rec. Key ──HKDF──▶ KEK_recovery ───┘
 *
 *   MDK (random, never derived) ──┬──HKDF──▶ Index Key (deterministic search)
 *                                 └──wraps──▶ per-item keys (random, in item_keys)
 *
 * The MDK is random rather than derived because the recovery code has to be a
 * genuine second path to the *same* key. Two independent derivations of one
 * value is impossible; two wraps of one random value is the standard envelope
 * and is what makes "lose the passphrase, keep the data" work exactly once.
 *
 * Per-item keys are random and stored wrapped, because a derived key cannot be
 * destroyed — anyone holding the MDK re-derives it forever. Shredding is the
 * deletion of a wrapped row. See decision 006.
 */

export const KEYRING_ID = 'default';

/** 128 bits, rendered Crockford base32 in five-character groups. */
const RECOVERY_BYTES = 16;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type VaultErrorKind =
  | 'already_initialized'
  | 'not_initialized'
  | 'bad_passphrase'
  | 'bad_recovery_code'
  | 'locked'
  | 'destroyed'
  | 'not_found';

export class VaultError extends Error {
  constructor(readonly kind: VaultErrorKind, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

interface KeyringRow {
  id: string;
  salt_passphrase: Uint8Array;
  salt_recovery: Uint8Array;
  wrapped_passphrase: Uint8Array | null;
  wrapped_recovery: Uint8Array | null;
  argon_mem_mib: number;
  argon_iterations: number;
  argon_parallelism: number;
  created_at: number;
  destroyed_at: number | null;
}

/** Unwrapped material. Lives in memory only, and only while unlocked. */
export interface OpenKeyring {
  mdk: Uint8Array;
  indexKey: Uint8Array;
}

function groupsOf(value: string, size: number): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
  return parts.join('-');
}

/** Render random bytes as a human-transcribable recovery code. */
export function formatRecoveryCode(bytes: Uint8Array): string {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  // 16 bytes = 128 bits = 26 base32 characters (last one partially filled).
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return groupsOf(out, 5);
}

/** Accept a code with any grouping or casing; reject anything outside the alphabet. */
export function parseRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[\s-]/g, '');
  for (const char of normalized) {
    if (!CROCKFORD.includes(char)) throw new VaultError('bad_recovery_code', 'Recovery code contains invalid characters.');
  }
  if (normalized.length !== 26) throw new VaultError('bad_recovery_code', 'Recovery code is the wrong length.');
  return normalized;
}

function readRow(storage: Storage): KeyringRow | undefined {
  return storage.prepare('SELECT * FROM keyring WHERE id = ?').get<KeyringRow>(KEYRING_ID);
}

function requireRow(storage: Storage): KeyringRow {
  const row = readRow(storage);
  if (!row) throw new VaultError('not_initialized', 'No vault. Run `arish init` first.');
  if (row.destroyed_at !== null) {
    throw new VaultError('destroyed', 'This vault was destroyed by `panic`. Its data is permanently unreadable.');
  }
  return row;
}

export function isInitialized(storage: Storage): boolean {
  return readRow(storage) !== undefined;
}

async function wrappingKey(secret: string, salt: Uint8Array, params: Argon2Params, info: string): Promise<Uint8Array> {
  const root = await deriveRootKey(secret, salt, params);
  const kek = await subkey(root, info);
  // The root key's only job is to produce the KEK. It must not outlive it.
  zeroize(root);
  return kek;
}

const INFO_PASSPHRASE = 'arish:kek:passphrase:v1';
const INFO_RECOVERY = 'arish:kek:recovery:v1';
const INFO_INDEX = 'arish:index:v1';
const AAD_MDK = 'arish:mdk:v1';

export interface InitResult {
  /** Shown exactly once. Never stored, never recoverable (§E.4). */
  recoveryCode: string;
}

/**
 * Create the vault.
 *
 * The MDK is generated here and wrapped twice before anything is written, so
 * a crash mid-init leaves no half-vault: the row is one transaction.
 */
export async function initKeyring(
  storage: Storage,
  passphrase: string,
  params: Argon2Params,
  now: number,
): Promise<InitResult> {
  if (isInitialized(storage)) {
    throw new VaultError('already_initialized', 'A vault already exists. Use `panic` to destroy it first.');
  }

  const saltPassphrase = randomBytes(SALT_BYTES);
  const saltRecovery = randomBytes(SALT_BYTES);
  const recoveryBytes = randomBytes(RECOVERY_BYTES);
  const recoveryCode = formatRecoveryCode(recoveryBytes);

  const mdk = randomKey();
  const kekPassphrase = await wrappingKey(passphrase, saltPassphrase, params, INFO_PASSPHRASE);
  const kekRecovery = await wrappingKey(parseRecoveryCode(recoveryCode), saltRecovery, params, INFO_RECOVERY);

  const wrappedPassphrase = await seal(kekPassphrase, mdk, AAD_MDK);
  const wrappedRecovery = await seal(kekRecovery, mdk, AAD_MDK);

  storage.prepare(
    `INSERT INTO keyring (id, salt_passphrase, salt_recovery, wrapped_passphrase, wrapped_recovery,
                          argon_mem_mib, argon_iterations, argon_parallelism, created_at, destroyed_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    KEYRING_ID, saltPassphrase, saltRecovery, wrappedPassphrase, wrappedRecovery,
    params.memMiB, params.iterations, params.parallelism, now,
  );

  zeroize(mdk, kekPassphrase, kekRecovery, recoveryBytes);
  return { recoveryCode };
}

function paramsOf(row: KeyringRow): Argon2Params {
  // Read from the row, not from config: a vault created at 64 MiB must still
  // open after someone edits the config, or the data is lost to a setting.
  return { memMiB: row.argon_mem_mib, iterations: row.argon_iterations, parallelism: row.argon_parallelism };
}

async function unwrap(kek: Uint8Array, wrapped: Uint8Array | null, kind: VaultErrorKind, message: string): Promise<OpenKeyring> {
  if (wrapped === null) throw new VaultError(kind, message);
  let mdk: Uint8Array;
  try {
    mdk = await open(kek, wrapped, AAD_MDK);
  } catch (error) {
    if (error instanceof DecryptError) throw new VaultError(kind, message);
    throw error;
  } finally {
    zeroize(kek);
  }
  return { mdk, indexKey: await subkey(mdk, INFO_INDEX) };
}

export async function unlockWithPassphrase(storage: Storage, passphrase: string): Promise<OpenKeyring> {
  const row = requireRow(storage);
  const kek = await wrappingKey(passphrase, row.salt_passphrase, paramsOf(row), INFO_PASSPHRASE);
  return unwrap(kek, row.wrapped_passphrase, 'bad_passphrase', 'Incorrect passphrase.');
}

export async function unlockWithRecoveryCode(storage: Storage, code: string): Promise<OpenKeyring> {
  const row = requireRow(storage);
  const kek = await wrappingKey(parseRecoveryCode(code), row.salt_recovery, paramsOf(row), INFO_RECOVERY);
  return unwrap(kek, row.wrapped_recovery, 'bad_recovery_code', 'Incorrect recovery code.');
}

/**
 * Destroy both wraps (§23 panic).
 *
 * The MDK was never persisted in the clear, so deleting the two wraps makes
 * it unreachable by any path — there is no third copy. Every item key in the
 * database is sealed under it and becomes permanently unopenable. The row
 * itself survives, carrying `destroyed_at`, because an audit trail that
 * vanishes with the data cannot prove what happened.
 */
export function panic(storage: Storage, now: number): void {
  requireRow(storage);
  storage.transaction(() => {
    storage.prepare(
      'UPDATE keyring SET wrapped_passphrase = NULL, wrapped_recovery = NULL, destroyed_at = ? WHERE id = ?',
    ).run(now, KEYRING_ID);
    // The item keys are already unopenable; removing them makes the shred
    // complete rather than merely theoretical.
    storage.prepare('DELETE FROM item_keys').run();
  });
}
