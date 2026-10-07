import { describe, expect, it } from 'vitest';
import { Egress, DEFAULT_POLICY } from '../../src/security/egress.js';
import { OAuthClient, OAuthError, type ProviderConfig, type TokenSet } from '../../src/capability/auth/oauth.js';
import { codeChallenge, codeVerifier, constantTimeEqual } from '../../src/capability/auth/pkce.js';
import { IdentityStore } from '../../src/capability/auth/identities.js';
import { FakeProvider, type FakeProviderOptions } from '../fakes/oauth-provider.js';
import { vaultHarness } from '../fakes/vault.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { must } from '../fakes/must.js';

/**
 * The authorization code flow, end to end, against a provider that
 * enforces the protocol instead of agreeing with us.
 *
 * Credentials for a real provider are the only missing piece: everything
 * below runs the same code path that `google` will, with `authorizeUrl`,
 * `tokenUrl` and `clientId` coming from configuration (§59.17).
 */

const SCOPES = ['calendar.readonly', 'calendar.events'];

function setup(options: FakeProviderOptions = {}, overrides: Partial<ProviderConfig> = {}): {
  provider: FakeProvider; client: OAuthClient; crypto: FakeCrypto; clock: { t: number };
} {
  const provider = new FakeProvider(options);
  const crypto = new FakeCrypto(7);
  const clock = { t: 1_700_000_000_000 };
  const egress = new Egress(
    { net: provider.net(), events: { append: () => undefined } as never, now: () => clock.t },
    { ...DEFAULT_POLICY, allowedOrigins: [provider.origin], trust: 'USER' },
  );
  const config: ProviderConfig = {
    id: 'fakegoogle',
    authorizeUrl: provider.authorizeUrl,
    tokenUrl: provider.tokenUrl,
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:8899/oauth/callback',
    scopes: SCOPES,
    ...overrides,
  };
  return { provider, crypto, clock, client: new OAuthClient({ egress, crypto, now: () => clock.t }, config) };
}

describe('PKCE', () => {
  it('derives the challenge the provider will check, and never sends the verifier early', () => {
    const crypto = new FakeCrypto();
    const verifier = codeVerifier(crypto);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);

    const challenge = codeChallenge(crypto, verifier);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toBe(verifier);
  });

  it('compares state without leaking its prefix through timing', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('the happy path', () => {
  it('completes a sign-in and comes back with a usable token', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();

    expect(url).toContain('code_challenge_method=S256');
    expect(url).not.toContain(pending.verifier);
    expect(url).toContain('response_type=code');

    const tokens = await client.complete(pending, provider.consent(url));
    expect(tokens.accessToken).toMatch(/^access-/);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.grantedScopes).toEqual(SCOPES);
    expect(tokens.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
  });

  it('sends the verifier, and only then, at the token endpoint', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    await client.complete(pending, provider.consent(url));

    const sent = must(provider.requests[0], 'token request');
    expect(sent['code_verifier']).toBe(pending.verifier);
    expect(sent['grant_type']).toBe('authorization_code');
    expect(sent['client_id']).toBe('client-123');
  });
});

describe('the flow refuses what it should', () => {
  it('rejects a callback whose state is not the one it issued', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    const callback = new URL(provider.consent(url));
    callback.searchParams.set('state', 'attacker-chosen');

    await expect(client.complete(pending, callback.toString())).rejects.toThrow(OAuthError);
    expect(provider.requests).toHaveLength(0); // never even asked
  });

  it('reports the provider error when the user declines', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    await expect(client.complete(pending, provider.deny(url)))
      .rejects.toThrow(/access_denied/);
  });

  it('fails when the code is replayed, because the provider burns it', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    const callback = provider.consent(url);
    await client.complete(pending, callback);
    await expect(client.complete(pending, callback)).rejects.toThrow(/invalid_grant/);
  });

  it('is useless to someone who steals the code but not the verifier', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    const stolen = provider.consent(url);

    // The attacker has the full callback URL and must invent a verifier.
    const attacker = { ...pending, verifier: codeVerifier(new FakeCrypto(99)) };
    await expect(client.complete(attacker, stolen)).rejects.toThrow(/invalid_grant/);

    // And the real client still works, because the code was never spent.
    await expect(client.complete(pending, stolen)).resolves.toBeDefined();
  });

  it('refuses when the account granted less than was asked for', async () => {
    const { provider, client } = setup({ grantScopes: ['calendar.readonly'] });
    const { url, pending } = client.begin();
    await expect(client.complete(pending, provider.consent(url)))
      .rejects.toThrow(/did not grant: calendar\.events/);
  });

  it('will not talk to a token endpoint outside the allow-list', async () => {
    const { provider, client } = setup({}, { tokenUrl: 'https://evil.example.net/token' });
    const { url, pending } = client.begin();
    await expect(client.complete(pending, provider.consent(url))).rejects.toThrow(/not on the allow-list|refused/i);
  });
});

describe('refreshing', () => {
  it('exchanges a refresh token for a new access token', async () => {
    const { provider, client, clock } = setup({ expiresIn: 3600 });
    const { url, pending } = client.begin();
    const first = await client.complete(pending, provider.consent(url));

    clock.t += 3_600_000;
    expect(client.isExpired(first)).toBe(true);

    const second = await client.refresh(first);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(client.isExpired(second)).toBe(false);
  });

  it('treats a token expiring within the next minute as already expired', async () => {
    const { provider, client, clock } = setup({ expiresIn: 3600 });
    const { url, pending } = client.begin();
    const tokens = await client.complete(pending, provider.consent(url));

    clock.t += 3_600_000 - 30_000;
    expect(client.isExpired(tokens)).toBe(true);
  });

  it('keeps the old refresh token when the provider does not send a new one', async () => {
    const { provider, client } = setup();
    const { url, pending } = client.begin();
    const first = await client.complete(pending, provider.consent(url));
    const second = await client.refresh({ ...first, refreshToken: must(first.refreshToken, 'refresh') });
    expect(second.refreshToken).not.toBeNull();
  });

  it('follows a rotating refresh token, and the old one stops working', async () => {
    const { provider, client } = setup({ rotateRefresh: true });
    const { url, pending } = client.begin();
    const first = await client.complete(pending, provider.consent(url));

    const second = await client.refresh(first);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(client.refresh(first)).rejects.toThrow(/invalid_grant/);
  });

  it('says plainly that there is nothing to refresh when no refresh token exists', async () => {
    const { provider, client } = setup({ issueRefresh: false });
    const { url, pending } = client.begin();
    const tokens = await client.complete(pending, provider.consent(url));
    expect(tokens.refreshToken).toBeNull();
    await expect(client.refresh(tokens)).rejects.toThrow(/sign in again/);
  });

  it('never expires a token the provider gave no expiry for', async () => {
    const { provider, client, clock } = setup({ expiresIn: null });
    const { url, pending } = client.begin();
    const tokens = await client.complete(pending, provider.consent(url));
    clock.t += 365 * 24 * 3_600_000;
    expect(tokens.expiresAt).toBeNull();
    expect(client.isExpired(tokens)).toBe(false);
  });
});

describe('where the tokens live', () => {
  async function connected(options: FakeProviderOptions = {}): Promise<{
    store: IdentityStore; client: OAuthClient; provider: FakeProvider;
    harness: Awaited<ReturnType<typeof vaultHarness>>; id: string; tokens: TokenSet;
    advance: (ms: number) => void;
  }> {
    // Idle locking off: these tests advance the clock by hours to make a
    // token expire, and an idle lock would answer first.
    const harness = await vaultHarness({ idleLockMinutes: 0 });
    const { provider, client, clock } = setup(options);
    // One timeline. The OAuth client and the vault must agree about now,
    // or a token expires for one of them and not the other.
    const advance = (ms: number): void => {
      clock.t += ms;
      harness.substrate.clock.advance(ms);
    };
    let counter = 0;
    const store = new IdentityStore({
      storage: harness.substrate.storage,
      vault: harness.vault,
      now: () => harness.substrate.clock.now(),
      newId: () => `identity-${++counter}`,
    });
    const { url, pending } = client.begin();
    const tokens = await client.complete(pending, provider.consent(url));
    const record = await store.connect({ provider: 'fakegoogle', accountLabel: 'me@work.example', scope: 'WORK', tokens });
    return { store, client, provider, harness, id: record.id, tokens, advance };
  }

  it('puts the token in the vault and the reference in the table', async () => {
    const { store, harness, id, tokens } = await connected();
    const record = must(store.get(id), 'record');

    expect(record.accessRef).toMatch(/^secret:\/\//);
    const row = harness.substrate.storage
      .prepare('SELECT * FROM identities WHERE id = ?').get<Record<string, unknown>>(id);
    expect(JSON.stringify(row)).not.toContain(tokens.accessToken);
    harness.close();
  });

  it('hands the broker metadata and no secret at all', async () => {
    const { store, harness, tokens } = await connected();
    const refs = store.refs();
    expect(must(refs[0], 'ref').scope).toBe('WORK');
    expect(must(refs[0], 'ref').grantedScopes).toEqual(SCOPES);
    expect(JSON.stringify(refs)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(refs)).not.toContain('secret://');
    harness.close();
  });

  it('spends the token inside a closure, refreshing first when it is due', async () => {
    const { store, client, harness, id, tokens, advance } = await connected({ expiresIn: 3600 });
    advance(3_600_000);

    const used = await store.withAccessToken(id, client, (token) => token);
    expect(used).not.toBe(tokens.accessToken);
    expect(must(store.get(id), 'record').status).toBe('active');
    harness.close();
  });

  it('does not refresh a token that is still good', async () => {
    const { store, client, provider, harness, id } = await connected({ expiresIn: 3600 });
    const before = provider.requests.length;
    await store.withAccessToken(id, client, () => undefined);
    expect(provider.requests.length).toBe(before);
    harness.close();
  });

  it('marks the account expired when the user revokes access at the provider', async () => {
    const { store, client, provider, harness, id, advance } = await connected({ expiresIn: 3600 });
    provider.revokeAll();
    advance(3_600_000);

    await expect(store.withAccessToken(id, client, () => undefined)).rejects.toThrow();
    const record = must(store.get(id), 'record');
    expect(record.status).toBe('expired');
    expect(must(record.lastError, 'error')).toMatch(/invalid_grant|refused/);
    harness.close();
  });

  it('refuses to use a disconnected account, and says why', async () => {
    const { store, client, harness, id } = await connected();
    store.disconnect(id, 'user removed it');
    await expect(store.withAccessToken(id, client, () => undefined))
      .rejects.toThrow(/sign in again/);
    harness.close();
  });

  it('updates the same account rather than connecting it twice', async () => {
    const { store, client, provider, harness } = await connected();
    const { url, pending } = client.begin();
    const again = await client.complete(pending, provider.consent(url));
    await store.connect({ provider: 'fakegoogle', accountLabel: 'me@work.example', scope: 'WORK', tokens: again });

    expect(store.list()).toHaveLength(1);
    harness.close();
  });

  it('keeps two different accounts on the same provider apart', async () => {
    const { store, client, provider, harness } = await connected();
    const { url, pending } = client.begin();
    const personal = await client.complete(pending, provider.consent(url));
    await store.connect({ provider: 'fakegoogle', accountLabel: 'me@home.example', scope: 'PERSONAL', tokens: personal });

    const scopes = store.refs().map((r) => r.scope).sort();
    expect(scopes).toEqual(['PERSONAL', 'WORK']);
    harness.close();
  });
});
