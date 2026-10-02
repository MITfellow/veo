import { zeroize } from './crypto.js';
import { Keyring, LockedError } from './keyring.js';
import type { WebCrypto } from './crypto.js';
import type { EventLog } from '../substrate/events/log.js';
import type { Redactor } from '../substrate/events/redact.js';
import type { Clock, Storage } from '../substrate/ports.js';

/**
 * The vault (§13.2).
 *
 * The single most important design decision in this file is a method that does
 * **not** exist: there is no `resolve(ref): string`. A method that hands back a
 * secret value would be called, and the value would end up in a log line, a
 * tool argument, or an error message, and we would be writing an incident
 * report. Making the unsafe operation *unexpressible* beats documenting that
 * it is discouraged.
 *
 * The only way to touch a value is `useSecret(ref, fn)`, which:
 *   1. unwraps it into a Uint8Array,
 *   2. registers it with the Redactor so that if it *does* escape into an
 *      event payload, M0's append-time redaction catches it,
 *   3. runs the callback,
 *   4. zeroizes in a `finally` — including when the callback throws,
 *   5. emits `vault.secret.read` naming who/when/which run/which tool and
 *      never the value.
 *
 * Step 2 is defence in depth, not the primary control. If it ever fires in
 * production that is a bug upstream, and the firewall (§13.2) is the last net.
 */

export interface SecretMetadata {
  name: string;
  version: number;
  createdAt: number;
  rotatedAt: number | null;
  destroyedAt: number | null;
  lastReadAt: number | null;
  readCount: number;
  label: string;
}

interface SecretRow {
  name: string;
  version: number;
  ciphertext: Uint8Array;
  label: string;
  created_at: number;
  destroyed_at: number | null;
  last_read_at: number | null;
  read_count: number;
}

export interface SecretRef {
  readonly ref: string; // secret://name/version
  readonly name: string;
  readonly version: number;
}

const SECRET_URI = /^secret:\/\/([a-z0-9][a-z0-9._-]{0,63})\/(\d+)$/i;

export function parseSecretRef(ref: string): SecretRef {
  const m = SECRET_URI.exec(ref);
  if (!m) throw new VaultError(`not a secret reference: ${ref}`);
  return { ref, name: m[1]!.toLowerCase(), version: Number(m[2]) };
}

export function makeSecretRef(name: string, version: number): SecretRef {
  return { ref: `secret://${name}/${version}`, name, version };
}

export interface UseSecretContext {
  principal: string;
  runId?: string | null;
  stepId?: string | null;
  sessionId?: string | null;
  /** Which tool is asking. Recorded in the audit event. */
  tool?: string | null;
  correlationId?: string;
  causationId?: string | null;
}

export class Vault {
  constructor(
    private readonly storage: Storage,
    private readonly keyring: Keyring,
    private readonly crypto: WebCrypto,
    private readonly events: EventLog,
    private readonly redactor: Redactor,
    private readonly clock: Clock,
  ) {}

  /* ──────────────────────────────── create ─────────────────────────────── */

  /**
   * Store a secret. Returns a reference; the value is not echoed back, because
   * a caller that receives it might log it.
   */
  async create(
    name: string,
    value: string | Uint8Array,
    ctx: { principal: string; label?: string },
  ): Promise<SecretRef> {
    assertName(name);
    const existing = this.latestVersion(name);
    if (existing !== undefined && existing.destroyed_at === null) {
      throw new VaultError(`secret "${name}" already exists — use rotate() to add a version`);
    }
    return this.put(name, 1, value, ctx);
  }

  /** New version of an existing secret. Old versions stay resolvable. */
  async rotate(
    name: string,
    value: string | Uint8Array,
    ctx: { principal: string; label?: string },
  ): Promise<SecretRef> {
    assertName(name);
    const latest = this.latestVersion(name);
    if (latest === undefined) throw new VaultError(`no such secret: ${name}`);
    const ref = await this.put(name, latest.version + 1, value, ctx, 'rotated');
    return ref;
  }

  private async put(
    name: string,
    version: number,
    value: string | Uint8Array,
    ctx: { principal: string; label?: string },
    kind: 'created' | 'rotated' = 'created',
  ): Promise<SecretRef> {
    if (!this.keyring.isUnlocked()) throw new LockedError();

    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
    const itemId = `secret/${name}/${version}`;
    const key = await this.keyring.itemKey(itemId);
    const label = ctx.label ?? name;
    let ciphertext: Uint8Array;
    try {
      // The item id is authenticated: a ciphertext cannot be moved to another
      // secret's row without failing to decrypt.
      ciphertext = await this.crypto.encrypt(key, bytes, new TextEncoder().encode(itemId));
    } finally {
      zeroize(key, bytes);
    }

    const now = this.clock.now();
    this.storage.run(
      `INSERT INTO secrets (name, version, ciphertext, label, created_at, destroyed_at, last_read_at, read_count)
       VALUES (?,?,?,?,?,NULL,NULL,0)`,
      [name, version, ciphertext, label, now],
    );

    this.events.append({
      type: kind === 'created' ? 'vault.secret.created' : 'vault.secret.rotated',
      payload: { name, version },
      principal: ctx.principal,
      trust: 'USER',
    });

    return makeSecretRef(name, version);
  }

  /* ──────────────────────────────── use ────────────────────────────────── */

  /**
   * The only way to touch a secret value.
   *
   * The callback receives bytes, not a string: strings are immutable in JS and
   * cannot be zeroized, so a `string` secret lives until the GC feels like it
   * (D-012). A tool that genuinely needs a string builds one inside the
   * callback, where it dies with the frame.
   */
  async useSecret<T>(
    ref: string | SecretRef,
    ctx: UseSecretContext,
    fn: (value: Uint8Array) => Promise<T> | T,
  ): Promise<T> {
    if (!this.keyring.isUnlocked()) throw new LockedError();
    const parsed = typeof ref === 'string' ? parseSecretRef(ref) : ref;

    const row = this.storage.get<SecretRow>(
      'SELECT * FROM secrets WHERE name = ? AND version = ?',
      [parsed.name, parsed.version],
    );
    if (!row) throw new VaultError(`no such secret: ${parsed.ref}`);
    if (row.destroyed_at !== null) {
      throw new VaultError(`secret ${parsed.ref} was destroyed and cannot be read`);
    }

    const itemId = `secret/${parsed.name}/${parsed.version}`;
    const key = await this.keyring.itemKey(itemId);
    let value: Uint8Array;
    try {
      value = await this.crypto.decrypt(key, row.ciphertext, new TextEncoder().encode(itemId));
    } finally {
      zeroize(key);
    }

    // Belt: from here until the finally, this value is known to the redactor,
    // so any event appended during the callback has it stripped.
    const asString = new TextDecoder().decode(value);
    this.redactor.register(asString, row.label);

    this.storage.run(
      'UPDATE secrets SET last_read_at = ?, read_count = read_count + 1 WHERE name = ? AND version = ?',
      [this.clock.now(), parsed.name, parsed.version],
    );

    // Audited before the callback runs: if the tool crashes the machine, the
    // record that it *had* the secret must already be durable.
    this.events.append({
      type: 'vault.secret.read',
      payload: { ref: parsed.ref, tool: ctx.tool ?? null },
      principal: ctx.principal,
      trust: 'SYSTEM',
      sessionId: ctx.sessionId ?? null,
      runId: ctx.runId ?? null,
      stepId: ctx.stepId ?? null,
      ...(ctx.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
      causationId: ctx.causationId ?? null,
    });

    try {
      return await fn(value);
    } finally {
      zeroize(value);
      // The registration stays: the redactor must keep catching this value for
      // the rest of the process, because a leak usually surfaces *after* the
      // call that caused it (an error logged later, a retry, a trace dump).
    }
  }

  /* ─────────────────────────────── destroy ─────────────────────────────── */

  /**
   * Crypto-shred one version. The ciphertext row is overwritten rather than
   * deleted, so the fact that a secret existed and was destroyed stays
   * auditable — §13.3's tombstone.
   */
  destroy(name: string, version: number | 'all', ctx: { principal: string }): number {
    const rows =
      version === 'all'
        ? this.storage.all<SecretRow>('SELECT * FROM secrets WHERE name = ? AND destroyed_at IS NULL', [name])
        : this.storage.all<SecretRow>(
            'SELECT * FROM secrets WHERE name = ? AND version = ? AND destroyed_at IS NULL',
            [name, version],
          );
    if (rows.length === 0) return 0;

    const now = this.clock.now();
    for (const row of rows) {
      this.storage.run(
        `UPDATE secrets SET ciphertext = ?, destroyed_at = ? WHERE name = ? AND version = ?`,
        [new Uint8Array(0), now, row.name, row.version],
      );
      this.events.append({
        type: 'vault.secret.destroyed',
        payload: { name: row.name, version: row.version },
        principal: ctx.principal,
        trust: 'USER',
      });
    }
    return rows.length;
  }

  /* ──────────────────────────────── list ───────────────────────────────── */

  /**
   * Names and metadata only. The query selects columns explicitly rather than
   * `SELECT *` so that adding a column to `secrets` can never silently start
   * leaking it through this endpoint.
   */
  list(): SecretMetadata[] {
    const rows = this.storage.all<Omit<SecretRow, 'ciphertext'>>(
      `SELECT name, version, label, created_at, destroyed_at, last_read_at, read_count
       FROM secrets ORDER BY name, version`,
    );
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      label: r.label,
      createdAt: r.created_at,
      rotatedAt: r.version > 1 ? r.created_at : null,
      destroyedAt: r.destroyed_at,
      lastReadAt: r.last_read_at,
      readCount: r.read_count,
    }));
  }

  /** Latest live version of a secret, as a reference. */
  current(name: string): SecretRef | undefined {
    const row = this.latestVersion(name);
    if (row === undefined || row.destroyed_at !== null) return undefined;
    return makeSecretRef(row.name, row.version);
  }

  private latestVersion(name: string): SecretRow | undefined {
    return this.storage.get<SecretRow>(
      'SELECT * FROM secrets WHERE name = ? ORDER BY version DESC LIMIT 1',
      [name],
    );
  }
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new VaultError(`invalid secret name: ${name}`);
  }
}
