import { z } from 'zod';
import type { CryptoPort } from '../../substrate/ports.js';
import type { Egress } from '../../security/egress.js';
import { codeChallenge, codeVerifier, constantTimeEqual, opaqueToken } from './pkce.js';

/**
 * OAuth 2.0 authorization code flow with PKCE (RFC 6749 §4.1, RFC 7636).
 *
 * This module knows the *protocol* and nothing about any particular
 * provider: endpoints and scopes arrive as a `ProviderConfig`, which is why
 * attaching Google or GitHub later is configuration rather than code
 * (§59.17, the same promise made for the model).
 *
 * It also knows nothing about storage. It returns tokens; `identities.ts`
 * decides that a token belongs in the vault. Keeping the protocol pure is
 * what lets the whole flow be tested against a fake provider with no
 * database, no clock skew, and no network.
 *
 * Every request goes through `Egress`, so the token endpoint is subject to
 * the same allow-list, TLS requirement and private-address refusal as
 * anything else (decision 013). An OAuth endpoint is not special; it is
 * just the first one we actually want to reach.
 */

export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'state_mismatch' | 'provider_error' | 'malformed_response'
      | 'no_refresh_token' | 'expired' | 'scope_denied',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface ProviderConfig {
  /** Stable id: `google`, `github`, … Used as the identity's provider. */
  readonly id: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /**
   * A `secret://` reference, never a value. Public clients (installed
   * apps, which is what this is) may legitimately have none.
   */
  readonly clientSecretRef?: string | undefined;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Providers differ on how to ask for a refresh token at all. */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>> | undefined;
}

/** What must be kept between the redirect out and the redirect back. */
export interface PendingAuthorization {
  readonly providerId: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly requestedScopes: readonly string[];
  readonly startedAt: number;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Absolute epoch ms. Providers send a duration; a duration rots. */
  readonly expiresAt: number | null;
  readonly grantedScopes: readonly string[];
  readonly tokenType: string;
}

/**
 * The wire shape. `expires_in` is optional because some providers omit it,
 * `scope` because some return exactly what was asked for and say nothing.
 */
const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('Bearer'),
  expires_in: z.number().finite().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

/** 60s of slack: a token that expires during the request is expired now. */
export const EXPIRY_SKEW_MS = 60_000;

export interface OAuthDeps {
  egress: Egress;
  crypto: CryptoPort;
  now: () => number;
  /** Resolves `secret://` refs. Absent for public clients. */
  resolveSecret?: ((ref: string) => Promise<string>) | undefined;
}

export class OAuthClient {
  constructor(
    private readonly deps: OAuthDeps,
    private readonly provider: ProviderConfig,
  ) {}

  /**
   * Step one: the URL to open, and the state to remember.
   *
   * The verifier never leaves this process and the challenge is all the
   * provider ever sees, so an authorization code stolen from the redirect
   * cannot be exchanged by whoever stole it.
   */
  begin(): { url: string; pending: PendingAuthorization } {
    const verifier = codeVerifier(this.deps.crypto);
    const state = opaqueToken(this.deps.crypto);
    const url = new URL(this.provider.authorizeUrl);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.provider.clientId,
      redirect_uri: this.provider.redirectUri,
      scope: this.provider.scopes.join(' '),
      state,
      code_challenge: codeChallenge(this.deps.crypto, verifier),
      code_challenge_method: 'S256',
      ...(this.provider.extraAuthorizeParams ?? {}),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    return {
      url: url.toString(),
      pending: {
        providerId: this.provider.id,
        state,
        verifier,
        redirectUri: this.provider.redirectUri,
        requestedScopes: this.provider.scopes,
        startedAt: this.deps.now(),
      },
    };
  }

  /**
   * Step two: exchange the code.
   *
   * `state` is checked first and in constant time. A mismatch is not a
   * recoverable error — it means this response belongs to a different
   * request than the one we started, which is the shape of a CSRF.
   */
  async complete(pending: PendingAuthorization, callbackUrl: string): Promise<TokenSet> {
    const back = new URL(callbackUrl);
    const error = back.searchParams.get('error');
    if (error !== null) {
      throw new OAuthError('provider_error', `${error}: ${back.searchParams.get('error_description') ?? 'no detail given'}`);
    }

    const state = back.searchParams.get('state') ?? '';
    if (!constantTimeEqual(state, pending.state)) {
      throw new OAuthError('state_mismatch', 'The callback state does not match the request that started this.');
    }

    const code = back.searchParams.get('code');
    if (code === null || code === '') throw new OAuthError('malformed_response', 'The callback carried no authorization code.');

    return this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }, pending.requestedScopes);
  }

  /**
   * Step three, forever: refresh.
   *
   * Providers that rotate refresh tokens return a new one; providers that
   * do not, return none. Carrying the old one forward when none comes back
   * is the difference between a session that survives and one that dies
   * silently a month later.
   */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (tokens.refreshToken === null) {
      throw new OAuthError('no_refresh_token', 'This grant has no refresh token; the user must sign in again.');
    }
    const next = await this.exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }, tokens.grantedScopes);

    return next.refreshToken === null ? { ...next, refreshToken: tokens.refreshToken } : next;
  }

  /** True when the token is gone, or close enough to gone to re-ask. */
  isExpired(tokens: TokenSet): boolean {
    if (tokens.expiresAt === null) return false;
    return this.deps.now() + EXPIRY_SKEW_MS >= tokens.expiresAt;
  }

  private async exchange(form: Record<string, string>, requested: readonly string[]): Promise<TokenSet> {
    const body = new URLSearchParams({ ...form, client_id: this.provider.clientId });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };

    const secretRef = this.provider.clientSecretRef;
    if (secretRef !== undefined && this.deps.resolveSecret !== undefined) {
      // Resolved here and used immediately: the secret exists as a string
      // for the length of one request (§23), and is never put in the URL,
      // where egress logging and provider access logs would both keep it.
      const secret = await this.deps.resolveSecret(secretRef);
      body.set('client_secret', secret);
    }

    const response = await this.deps.egress.fetch({
      url: this.provider.tokenUrl,
      method: 'POST',
      headers,
      body: body.toString(),
    });

    return this.readTokens(response.status, response.body, requested);
  }

  private readTokens(status: number, raw: string, requested: readonly string[]): TokenSet {
    const parsed = parseJson(raw);
    if (status >= 400) {
      throw new OAuthError('provider_error', `The provider refused the token request: ${errorCode(parsed, status)}.`);
    }

    const result = tokenResponse.safeParse(parsed);
    if (!result.success) {
      throw new OAuthError('malformed_response', 'The token response did not contain a usable access token.');
    }
    const data = result.data;
    const granted = data.scope === undefined ? requested : data.scope.split(/\s+/).filter((s) => s !== '');

    // A provider is allowed to grant less than was asked for. Discovering
    // that at the token endpoint is far better than discovering it as a
    // 403 halfway through someone's work.
    const missing = requested.filter((s) => !granted.includes(s));
    if (missing.length > 0 && data.scope !== undefined) {
      throw new OAuthError('scope_denied', `The account did not grant: ${missing.join(', ')}.`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: data.expires_in === undefined ? null : this.deps.now() + data.expires_in * 1000,
      grantedScopes: granted,
      tokenType: data.token_type,
    };
  }
}

/** The provider's own error code if it sent one, else the status. */
function errorCode(parsed: unknown, status: number): string {
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    return String((parsed as { error: unknown }).error);
  }
  return `HTTP ${status}`;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
