import type { Storage } from '../../substrate/ports.js';
import type { Vault } from '../../security/vault.js';
import type { Scope } from '../world/contracts.js';
import type { IdentityRef } from '../semantics/broker.js';
import { OAuthError, type OAuthClient, type TokenSet } from './oauth.js';

/**
 * Connected accounts.
 *
 * The broker asks "which account can do this?" and gets an `IdentityRef`
 * carrying scope, granted provider scopes and status — and *no token*. The
 * token is fetched at the moment of the call, from the vault, through
 * `withAccessToken`, and is a string for the length of one closure (§23).
 *
 * That split is the whole design. Routing decisions are made over metadata
 * that is safe to log, compare and show the user; the secret only exists
 * where it is spent.
 */

export type IdentityStatus = 'active' | 'expired' | 'revoked';

export interface IdentityRecord {
  id: string;
  provider: string;
  accountLabel: string;
  scope: Scope;
  grantedScopes: readonly string[];
  accessRef: string;
  refreshRef: string | null;
  expiresAt: number | null;
  status: IdentityStatus;
  connectedAt: number;
  lastVerified: number;
  lastError: string | null;
}

interface Row {
  id: string;
  provider: string;
  account_label: string;
  scope: string;
  granted_scopes: string;
  access_ref: string;
  refresh_ref: string | null;
  expires_at: number | null;
  status: string;
  connected_at: number;
  last_verified: number;
  last_error: string | null;
}

export interface IdentityStoreDeps {
  storage: Storage;
  vault: Vault;
  now: () => number;
  newId: () => string;
}

export interface ConnectRequest {
  provider: string;
  accountLabel: string;
  scope: Scope;
  tokens: TokenSet;
}

export class IdentityStore {
  constructor(private readonly deps: IdentityStoreDeps) {}

  /**
   * Record a freshly granted set of tokens.
   *
   * Re-connecting the same account updates it rather than creating a
   * second row: two rows for one mailbox is the state in which the broker
   * asks the user which account to use and both answers are the same one.
   */
  async connect(request: ConnectRequest): Promise<IdentityRecord> {
    const now = this.deps.now();
    const existing = this.byAccount(request.provider, request.accountLabel);
    const id = existing?.id ?? this.deps.newId();
    const refs = await this.storeTokens(id, request.tokens);

    this.deps.storage.prepare(`
      INSERT INTO identities
        (id, provider, account_label, scope, granted_scopes, access_ref, refresh_ref,
         expires_at, status, connected_at, last_verified, last_error)
      VALUES (?,?,?,?,?,?,?,?,'active',?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        granted_scopes = excluded.granted_scopes,
        access_ref = excluded.access_ref,
        refresh_ref = excluded.refresh_ref,
        expires_at = excluded.expires_at,
        status = 'active',
        last_verified = excluded.last_verified,
        last_error = NULL
    `).run(
      id, request.provider, request.accountLabel, request.scope,
      request.tokens.grantedScopes.join(' '), refs.access, refs.refresh,
      request.tokens.expiresAt, existing?.connectedAt ?? now, now,
    );

    return this.require(id);
  }

  list(): IdentityRecord[] {
    const rows = this.deps.storage.prepare('SELECT * FROM identities ORDER BY provider, account_label').all<Row>();
    return rows.map(toRecord);
  }

  get(id: string): IdentityRecord | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM identities WHERE id = ?').get<Row>(id);
    return row === undefined ? undefined : toRecord(row);
  }

  /** What the broker consumes: everything needed to choose, nothing secret. */
  refs(): IdentityRef[] {
    return this.list().map((r) => ({
      identityId: r.id,
      provider: r.provider,
      scope: r.scope,
      grantedScopes: r.grantedScopes,
      status: r.status,
      lastVerified: r.lastVerified,
    }));
  }

  /**
   * Spend the access token, refreshing first if it is due.
   *
   * The caller receives the token inside a closure and never holds it
   * afterwards. Refresh happens here rather than in a background timer
   * because a timer refreshes tokens nobody is using, and the failure then
   * surfaces with no user, no run and nobody to ask to sign in again.
   */
  async withAccessToken<T>(
    id: string,
    client: OAuthClient,
    use: (token: string) => T | Promise<T>,
  ): Promise<T> {
    let record = this.require(id);
    if (record.status === 'revoked') {
      throw new OAuthError('expired', `The ${record.provider} account was disconnected; sign in again to use it.`);
    }

    const tokens = await this.readTokens(record);
    if (client.isExpired(tokens)) record = await this.renew(record, client, tokens);

    return this.deps.vault.resolve(
      record.accessRef,
      { principal: `identity:${record.id}`, tool: 'oauth' },
      (token) => use(token),
    );
  }

  /** Mark the account unusable without destroying the audit of its use. */
  disconnect(id: string, reason: string): void {
    this.deps.storage.prepare(
      "UPDATE identities SET status = 'revoked', last_error = ?, last_verified = ? WHERE id = ?",
    ).run(reason, this.deps.now(), id);
  }

  /** Record that a call failed in a way that signals the grant is gone. */
  markExpired(id: string, reason: string): void {
    this.deps.storage.prepare(
      "UPDATE identities SET status = 'expired', last_error = ? WHERE id = ?",
    ).run(reason, id);
  }

  // ─────────────────────────────────────────────────────────────── internals

  private async renew(record: IdentityRecord, client: OAuthClient, tokens: TokenSet): Promise<IdentityRecord> {
    try {
      const next = await client.refresh(tokens);
      const refs = await this.storeTokens(record.id, next);
      this.deps.storage.prepare(`
        UPDATE identities SET access_ref = ?, refresh_ref = ?, expires_at = ?,
          granted_scopes = ?, status = 'active', last_verified = ?, last_error = NULL
        WHERE id = ?
      `).run(refs.access, refs.refresh, next.expiresAt, next.grantedScopes.join(' '), this.deps.now(), record.id);
      return this.require(record.id);
    } catch (error) {
      // A failed refresh is the normal end of a grant, not a crash: the
      // account is marked so the broker refuses with "sign in again"
      // instead of every later call failing with a 401 nobody reads.
      const message = error instanceof Error ? error.message : 'refresh failed';
      this.markExpired(record.id, message);
      throw error;
    }
  }

  private async storeTokens(id: string, tokens: TokenSet): Promise<{ access: string; refresh: string | null }> {
    // Dots, not slashes: a secret name is `[A-Za-z0-9._-]+`, and a `/`
    // makes the resulting `secret://` URI unparseable by its own parser.
    const access = await this.deps.vault.put(`oauth.${id}.access`, tokens.accessToken);
    const refresh = tokens.refreshToken === null
      ? null
      : (await this.deps.vault.put(`oauth.${id}.refresh`, tokens.refreshToken)).uri;
    return { access: access.uri, refresh };
  }

  private async readTokens(record: IdentityRecord): Promise<TokenSet> {
    const ctx = { principal: `identity:${record.id}`, tool: 'oauth' };
    const accessToken = await this.deps.vault.resolve(record.accessRef, ctx, (v) => v);
    const refreshToken = record.refreshRef === null
      ? null
      : await this.deps.vault.resolve(record.refreshRef, ctx, (v) => v);
    return {
      accessToken,
      refreshToken,
      expiresAt: record.expiresAt,
      grantedScopes: record.grantedScopes,
      tokenType: 'Bearer',
    };
  }

  private byAccount(provider: string, label: string): IdentityRecord | undefined {
    const row = this.deps.storage
      .prepare('SELECT * FROM identities WHERE provider = ? AND account_label = ?')
      .get<Row>(provider, label);
    return row === undefined ? undefined : toRecord(row);
  }

  private require(id: string): IdentityRecord {
    const found = this.get(id);
    if (found === undefined) throw new OAuthError('expired', `No connected account with id ${id}.`);
    return found;
  }
}

function toRecord(row: Row): IdentityRecord {
  return {
    id: row.id,
    provider: row.provider,
    accountLabel: row.account_label,
    scope: row.scope as Scope,
    grantedScopes: row.granted_scopes === '' ? [] : row.granted_scopes.split(' '),
    accessRef: row.access_ref,
    refreshRef: row.refresh_ref,
    expiresAt: row.expires_at,
    status: row.status as IdentityStatus,
    connectedAt: row.connected_at,
    lastVerified: row.last_verified,
    lastError: row.last_error,
  };
}
