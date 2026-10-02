import { DecryptionError, KEY_BYTES, WebCrypto, zeroize } from './crypto.js';
import type { Clock, Storage } from '../substrate/ports.js';

/**
 * The key hierarchy (§13.1).
 *
 *   passphrase ──Argon2id──▶ Root Key            (memory only, never persisted)
 *                   ├─HKDF("mdk-wrap")──▶ KEK ──wraps──▶ Master Data Key
 *                   └─HKDF("index")─────▶ Index Key
 *
 *   recovery code ──Argon2id──▶ Recovery Key ──wraps──▶ the same MDK
 *
 *   MDK ──HKDF("item:"+id)──▶ per-item key       (derived on demand)
 *
 * Two properties this shape buys:
 *
 *  - **Changing the passphrase does not re-encrypt the data.** Only the MDK
 *    wrap is rewritten. On a database with years of encrypted memories that is
 *    the difference between a rotation and an outage.
 *  - **The recovery code is a peer, not a backdoor.** It wraps the same MDK
 *    through an independent Argon2id derivation, so it is neither derivable
 *    from the passphrase nor weaker than it.
 */

export type KeyringState = 'uninitialized' | 'locked' | 'unlocked';

export interface KeyringRow {
  id: string;
  passphrase_salt: Uint8Array;
  passphrase_wrap: Uint8Array | null;
  recovery_salt: Uint8Array;
  recovery_wrap: Uint8Array | null;
  created_at: number;
  rotated_at: number | null;
  panicked_at: number | null;
}

const ROW_ID = 'default';
const INFO_MDK_WRAP = 'arish/v1/mdk-wrap';
const INFO_INDEX = 'arish/v1/index';
const INFO_ITEM = 'arish/v1/item:';
const AAD_MDK = new TextEncoder().encode('arish/v1/mdk');

/** 25 Crockford characters = 125 bits, in five groups of five for transcription. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface InitResult {
  /** Shown exactly once. Not recoverable — the system stores only its wrap. */
  recoveryCode: string;
}

export class Keyring {
  private rootKey: Uint8Array | null = null;
  private masterKey: Uint8Array | null = null;
  private indexKey: Uint8Array | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly crypto: WebCrypto,
    private readonly clock: Clock,
  ) {}

  /* ───────────────────────────── lifecycle ──────────────────────────────── */

  state(): KeyringState {
    const row = this.row();
    if (!row || row.passphrase_wrap === null) {
      return row?.panicked_at !== null && row !== undefined ? 'uninitialized' : 'uninitialized';
    }
    return this.masterKey === null ? 'locked' : 'unlocked';
  }

  /**
   * First-run setup. Generates the MDK and wraps it twice — once under the
   * passphrase, once under a freshly minted recovery code.
   */
  async initialize(passphrase: string): Promise<InitResult> {
    if (this.row() !== undefined) throw new Error('keyring already initialized');
    assertPassphrase(passphrase);

    const passphraseSalt = this.crypto.randomBytes(16);
    const recoverySalt = this.crypto.randomBytes(16);
    const recoveryCode = this.mintRecoveryCode();
    const masterKey = this.crypto.randomBytes(KEY_BYTES);

    const passphraseWrap = await this.wrapWith(passphrase, passphraseSalt, masterKey);
    // Wrap under the *normalized* form, because that is what unlock derives
    // from. Wrapping the dashed display form would make a correctly
    // transcribed code fail — found by a test, and it would have been found
    // by a user at the worst possible moment otherwise.
    const recoveryWrap = await this.wrapWith(
      normalizeRecoveryCode(recoveryCode),
      recoverySalt,
      masterKey,
    );

    this.storage.run(
      `INSERT INTO keyring (id, passphrase_salt, passphrase_wrap, recovery_salt, recovery_wrap,
         created_at, rotated_at, panicked_at)
       VALUES (?,?,?,?,?,?,NULL,NULL)`,
      [ROW_ID, passphraseSalt, passphraseWrap, recoverySalt, recoveryWrap, this.clock.now()],
    );

    zeroize(masterKey);
    return { recoveryCode };
  }

  async unlock(passphrase: string): Promise<void> {
    const row = this.requireRow();
    if (row.passphrase_wrap === null) {
      throw new KeyringError('this keyring has been destroyed and cannot be unlocked');
    }
    const root = await this.crypto.deriveKey(passphrase, row.passphrase_salt);
    await this.unwrapInto(root, row.passphrase_wrap);
  }

  /** The second path. Same MDK, independent derivation. */
  async unlockWithRecoveryCode(code: string): Promise<void> {
    const row = this.requireRow();
    if (row.recovery_wrap === null) {
      throw new KeyringError('this keyring has been destroyed and cannot be unlocked');
    }
    const root = await this.crypto.deriveKey(normalizeRecoveryCode(code), row.recovery_salt);
    await this.unwrapInto(root, row.recovery_wrap);
  }

  /**
   * Drop every key from memory. After this the process holds nothing that can
   * decrypt anything, which is what makes auto-lock meaningful rather than
   * cosmetic.
   */
  lock(): void {
    zeroize(this.rootKey, this.masterKey, this.indexKey);
    this.rootKey = null;
    this.masterKey = null;
    this.indexKey = null;
  }

  /**
   * Panic wipe (§13.4). Destroys both wraps.
   *
   * After this the MDK cannot be reconstructed by anyone, including the user
   * with the correct passphrase. Every encrypted item in the database and in
   * every backup is permanently unreadable. That is the entire point, and it
   * is why it is a separate method with a scary name rather than a flag.
   */
  panic(): void {
    this.storage.run(
      `UPDATE keyring SET passphrase_wrap = NULL, recovery_wrap = NULL, panicked_at = ? WHERE id = ?`,
      [this.clock.now(), ROW_ID],
    );
    this.lock();
  }

  /**
   * Change the passphrase without re-encrypting a byte of data: unwrap the MDK
   * with the old one, rewrap under the new one.
   */
  async rotatePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    assertPassphrase(newPassphrase);
    const row = this.requireRow();
    if (row.passphrase_wrap === null) throw new KeyringError('keyring destroyed');

    const oldRoot = await this.crypto.deriveKey(oldPassphrase, row.passphrase_salt);
    let master: Uint8Array;
    try {
      const kek = await this.crypto.hkdf(oldRoot, INFO_MDK_WRAP);
      master = await this.crypto.decrypt(kek, row.passphrase_wrap, AAD_MDK);
      zeroize(kek);
    } catch {
      zeroize(oldRoot);
      throw new KeyringError('could not unlock');
    }
    zeroize(oldRoot);

    const newSalt = this.crypto.randomBytes(16);
    const newWrap = await this.wrapWith(newPassphrase, newSalt, master);
    zeroize(master);

    this.storage.run(
      `UPDATE keyring SET passphrase_salt = ?, passphrase_wrap = ?, rotated_at = ? WHERE id = ?`,
      [newSalt, newWrap, this.clock.now(), ROW_ID],
    );
  }

  /* ─────────────────────────────── key access ───────────────────────────── */

  private requireUnlocked(): Uint8Array {
    if (this.masterKey === null) throw new LockedError();
    return this.masterKey;
  }

  /**
   * Per-item key, derived rather than stored (D-011). The key for an item
   * exists only for the duration of the operation that needs it.
   */
  async itemKey(itemId: string): Promise<Uint8Array> {
    if (itemId.length === 0) throw new Error('itemKey requires an item id');
    return this.crypto.hkdf(this.requireUnlocked(), `${INFO_ITEM}${itemId}`);
  }

  /**
   * Deterministic key for blind-index columns — the same value always hashes
   * the same way, so an encrypted field stays searchable by exact match.
   * Deliberately *not* usable for encryption.
   */
  getIndexKey(): Uint8Array {
    if (this.indexKey === null) throw new LockedError();
    return this.indexKey;
  }

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  /* ──────────────────────────────── internals ───────────────────────────── */

  private async wrapWith(secret: string, salt: Uint8Array, master: Uint8Array): Promise<Uint8Array> {
    const root = await this.crypto.deriveKey(secret, salt);
    const kek = await this.crypto.hkdf(root, INFO_MDK_WRAP);
    const wrapped = await this.crypto.encrypt(kek, master, AAD_MDK);
    zeroize(root, kek);
    return wrapped;
  }

  private async unwrapInto(root: Uint8Array, wrap: Uint8Array): Promise<void> {
    const kek = await this.crypto.hkdf(root, INFO_MDK_WRAP);
    let master: Uint8Array;
    try {
      master = await this.crypto.decrypt(kek, wrap, AAD_MDK);
    } catch (err) {
      zeroize(root, kek);
      // Uniform message. "Wrong passphrase" vs "corrupt wrap" is an oracle,
      // and the user can do nothing different with the distinction anyway.
      if (err instanceof DecryptionError) throw new KeyringError('could not unlock');
      throw err;
    }
    zeroize(kek);

    this.rootKey = root;
    this.masterKey = master;
    this.indexKey = await this.crypto.hkdf(root, INFO_INDEX);
  }

  private mintRecoveryCode(): string {
    const bytes = this.crypto.randomBytes(25);
    let out = '';
    for (let i = 0; i < 25; i++) {
      if (i > 0 && i % 5 === 0) out += '-';
      out += RECOVERY_ALPHABET[bytes[i]! % 32];
    }
    return out;
  }

  private row(): KeyringRow | undefined {
    return this.storage.get<KeyringRow>('SELECT * FROM keyring WHERE id = ?', [ROW_ID]);
  }

  private requireRow(): KeyringRow {
    const row = this.row();
    if (!row) throw new KeyringError('keyring is not initialized');
    return row;
  }
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

export class LockedError extends Error {
  constructor() {
    super('the vault is locked');
    this.name = 'LockedError';
  }
}

function assertPassphrase(passphrase: string): void {
  // A length floor, not a composition rule. Composition rules produce
  // "P@ssw0rd!" and nothing else; length is what actually resists Argon2id-
  // backed guessing.
  if (passphrase.length < 12) {
    throw new Error('passphrase must be at least 12 characters');
  }
}

/** Accept the code however the user typed it off paper. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}
