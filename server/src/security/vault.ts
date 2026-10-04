import type { Clock, Storage } from '../substrate/ports.js';
import { open, randomKey, seal, zeroize } from './box.js';
import type { Argon2Params } from './kdf.js';
import {
  initKeyring,
  isInitialized,
  type InitResult,
  type OpenKeyring,
  panic as panicKeyring,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  VaultError,
} from './keyring.js';

/**
 * The vault (§23).
 *
 * Three responsibilities, deliberately in one place because they share the
 * unlocked-state invariant:
 *
 *   1. **Lifecycle** — locked by default, unlock, idle auto-lock, panic.
 *   2. **Secrets** — stored as `secret://name/version` references; the value
 *      is resolved at the last possible moment and zeroized after.
 *   3. **Per-item keys** — random, wrapped under the MDK, individually
 *      destroyable. This is what makes forgetting real (invariant 10).
 *
 * The in-memory unlocked material is held in one mutable field so there is
 * exactly one thing to zeroize on lock, and one thing to check before every
 * operation. A second cache would be a second thing to forget.
 */

export interface SecretRef {
  readonly uri: string;
  readonly name: string;
  readonly version: number;
}

const SECRET_URI = /^secret:\/\/([a-zA-Z0-9._-]+)\/(\d+)$/;

export function parseSecretRef(uri: string): SecretRef {
  const match = SECRET_URI.exec(uri);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new VaultError('not_found', `Not a secret reference: ${uri}`);
  }
  return { uri, name: match[1], version: Number(match[2]) };
}

export function secretRef(name: string, version: number): SecretRef {
  return { uri: `secret://${name}/${version}`, name, version };
}

export interface SecretSummary {
  name: string;
  version: number;
  createdAt: number;
}

/** What the audit trail records on a resolution. Never the value (§23). */
export interface ResolutionContext {
  principal: string;
  runId?: string | undefined;
  tool?: string | undefined;
}

export interface VaultEvents {
  secretCreated(ref: SecretRef, at: number): void;
  secretRead(ref: SecretRef, ctx: ResolutionContext, at: number): void;
  unlocked(at: number): void;
  locked(at: number, reason: 'explicit' | 'idle'): void;
  destroyed(at: number): void;
  itemShredded(keyId: string, at: number): void;
}

export interface VaultOptions {
  storage: Storage;
  clock: Clock;
  argon2: Argon2Params;
  /** §D.4 ships 60. Zero disables idle locking. */
  idleLockMinutes: number;
  events: VaultEvents;
}

export class Vault {
  /** Non-null exactly when unlocked. The single source of lock state. */
  private opened: OpenKeyring | null = null;
  private lastActivityAt = 0;

  constructor(private readonly options: VaultOptions) {}

  get locked(): boolean {
    this.enforceIdleLock();
    return this.opened === null;
  }

  isInitialized(): boolean {
    return isInitialized(this.options.storage);
  }

  async init(passphrase: string): Promise<InitResult> {
    return initKeyring(this.options.storage, passphrase, this.options.argon2, this.options.clock.now());
  }

  async unlock(passphrase: string): Promise<void> {
    this.adopt(await unlockWithPassphrase(this.options.storage, passphrase));
  }

  async unlockWithRecovery(code: string): Promise<void> {
    this.adopt(await unlockWithRecoveryCode(this.options.storage, code));
  }

  private adopt(keyring: OpenKeyring): void {
    const now = this.options.clock.now();
    this.opened = keyring;
    this.lastActivityAt = now;
    this.options.events.unlocked(now);
  }

  lock(reason: 'explicit' | 'idle' = 'explicit'): void {
    if (this.opened === null) return;
    // §23: the root key and MDK are zeroized on lock. `box.zeroize` is
    // best-effort in a GC'd runtime, but it bounds the window in which a
    // heap dump yields a live key.
    zeroize(this.opened.mdk, this.opened.indexKey);
    this.opened = null;
    this.options.events.locked(this.options.clock.now(), reason);
  }

  /**
   * Idle auto-lock, evaluated lazily rather than on a timer.
   *
   * A `setTimeout` would be a second source of truth about time, invisible to
   * the injected clock and therefore untestable by advancing it. Checking on
   * access means a test advances the clock six hours and the next call finds
   * the vault locked — which is also exactly what a real idle lock means.
   */
  private enforceIdleLock(): void {
    if (this.opened === null || this.options.idleLockMinutes <= 0) return;
    const idleMs = this.options.clock.now() - this.lastActivityAt;
    if (idleMs >= this.options.idleLockMinutes * 60_000) this.lock('idle');
  }

  private require(): OpenKeyring {
    this.enforceIdleLock();
    if (this.opened === null) throw new VaultError('locked', 'The vault is locked.');
    this.lastActivityAt = this.options.clock.now();
    return this.opened;
  }

  /** Destroy the key material. Irreversible, audited, fast (§23). */
  panic(): void {
    const now = this.options.clock.now();
    panicKeyring(this.options.storage, now);
    if (this.opened !== null) zeroize(this.opened.mdk, this.opened.indexKey);
    this.opened = null;
    this.options.events.destroyed(now);
  }

  // ---------------------------------------------------------------- secrets

  /**
   * Store a secret and return a reference.
   *
   * The caller receives a `secret://` URI and never holds the value again.
   * A repeat `put` of the same name creates a new version; the old one keeps
   * resolving, because a rotation that broke every in-flight reference would
   * make rotation the risky operation rather than the safe one.
   */
  async put(name: string, value: string): Promise<SecretRef> {
    const { mdk } = this.require();
    const now = this.options.clock.now();
    const next = this.nextVersion(name);
    const ref = secretRef(name, next);
    // The AAD binds this ciphertext to this name and version: a row swapped
    // in by someone with database write access will not open.
    const sealed = await seal(mdk, new TextEncoder().encode(value), ref.uri);
    this.options.storage.prepare(
      'INSERT INTO secrets (name, version, sealed, created_at) VALUES (?,?,?,?)',
    ).run(name, next, sealed, now);
    this.options.events.secretCreated(ref, now);
    return ref;
  }

  private nextVersion(name: string): number {
    const row = this.options.storage
      .prepare('SELECT MAX(version) AS v FROM secrets WHERE name = ?')
      .get<{ v: number | null }>(name);
    return (row?.v ?? 0) + 1;
  }

  /**
   * Resolve a reference into a value, for the duration of one closure.
   *
   * The value is passed to `use` and zeroized when it returns — §23's "resolve
   * at the last possible moment into the execution closure and zeroize after".
   * Returning the string instead would put the lifetime in the caller's hands,
   * and the caller is the thing we are protecting against.
   */
  async resolve<T>(ref: SecretRef | string, ctx: ResolutionContext, use: (value: string) => T | Promise<T>): Promise<T> {
    const { mdk } = this.require();
    const parsed = typeof ref === 'string' ? parseSecretRef(ref) : ref;
    const row = this.options.storage
      .prepare('SELECT sealed FROM secrets WHERE name = ? AND version = ?')
      .get<{ sealed: Uint8Array }>(parsed.name, parsed.version);
    if (!row) throw new VaultError('not_found', `No such secret: ${parsed.uri}`);

    const plain = await open(mdk, row.sealed, parsed.uri);
    this.options.events.secretRead(parsed, ctx, this.options.clock.now());
    try {
      return await use(new TextDecoder().decode(plain));
    } finally {
      zeroize(plain);
    }
  }

  /** Names and versions only — never values (§API `GET /api/vault/secrets`). */
  list(): SecretSummary[] {
    this.require();
    return this.options.storage
      .prepare('SELECT name, version, created_at AS createdAt FROM secrets ORDER BY name ASC, version ASC')
      .all<SecretSummary>();
  }

  /**
   * Every known secret value, for the request firewall (§23).
   *
   * This is the one place values leave the vault in bulk, and it exists so
   * that the firewall can refuse to let them leave at all. It requires an
   * unlocked vault and is never exposed over the API.
   */
  async knownValues(): Promise<string[]> {
    const { mdk } = this.require();
    const rows = this.options.storage
      .prepare('SELECT name, version, sealed FROM secrets ORDER BY name, version')
      .all<{ name: string; version: number; sealed: Uint8Array }>();
    const values: string[] = [];
    for (const row of rows) {
      const plain = await open(mdk, row.sealed, secretRef(row.name, row.version).uri);
      values.push(new TextDecoder().decode(plain));
      zeroize(plain);
    }
    return values;
  }

  // -------------------------------------------------------- per-item keys

  /**
   * Mint a random key for one item and store it wrapped (decision 006).
   *
   * Random, not derived: a derived key cannot be destroyed, so a derived
   * hierarchy makes `shred` a no-op that looks like a feature.
   */
  async createItemKey(keyId: string): Promise<Uint8Array> {
    const { mdk } = this.require();
    const itemKey = randomKey();
    const wrapped = await seal(mdk, itemKey, `arish:item:${keyId}`);
    this.options.storage.prepare(
      'INSERT OR REPLACE INTO item_keys (key_id, wrapped, created_at) VALUES (?,?,?)',
    ).run(keyId, wrapped, this.options.clock.now());
    return itemKey;
  }

  async itemKey(keyId: string): Promise<Uint8Array> {
    const { mdk } = this.require();
    const row = this.options.storage
      .prepare('SELECT wrapped FROM item_keys WHERE key_id = ?')
      .get<{ wrapped: Uint8Array }>(keyId);
    if (!row) throw new VaultError('not_found', `No key for item ${keyId}. It may have been shredded.`);
    return open(mdk, row.wrapped, `arish:item:${keyId}`);
  }

  /** Encrypt one item's content under its own key. */
  async sealItem(keyId: string, plaintext: string): Promise<Uint8Array> {
    const key = await this.itemKeyOrCreate(keyId);
    try {
      return await seal(key, new TextEncoder().encode(plaintext), `arish:item:${keyId}`);
    } finally {
      zeroize(key);
    }
  }

  async openItem(keyId: string, sealed: Uint8Array): Promise<string> {
    const key = await this.itemKey(keyId);
    try {
      return new TextDecoder().decode(await open(key, sealed, `arish:item:${keyId}`));
    } finally {
      zeroize(key);
    }
  }

  private async itemKeyOrCreate(keyId: string): Promise<Uint8Array> {
    const row = this.options.storage.prepare('SELECT wrapped FROM item_keys WHERE key_id = ?').get<{ wrapped: Uint8Array }>(keyId);
    return row ? this.itemKey(keyId) : this.createItemKey(keyId);
  }

  /**
   * Crypto-shred: destroy the key, leave the ciphertext (§23, invariant 10).
   *
   * Idempotent, because "forget this" arriving twice is a user action, not an
   * error. The tombstone event is what remains auditable; the content is gone
   * even from backups taken while it existed.
   */
  shred(keyId: string): boolean {
    this.require();
    const result = this.options.storage.prepare('DELETE FROM item_keys WHERE key_id = ?').run(keyId);
    const destroyed = result.changes > 0;
    if (destroyed) this.options.events.itemShredded(keyId, this.options.clock.now());
    return destroyed;
  }
}

/** Re-exported so the interface layer imports errors from the module it calls. */
export { VaultError };
