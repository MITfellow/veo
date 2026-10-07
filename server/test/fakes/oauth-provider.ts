import { createHash } from 'node:crypto';
import type { Net } from '../../src/substrate/ports.js';

/**
 * A fake OAuth 2.0 provider, implemented as a `Net`.
 *
 * It is a `Net` rather than a real loopback HTTP server for two reasons:
 * the egress guard refuses loopback by design (decision 013), so a real
 * local server could only be reached by punching a hole in the thing under
 * test; and a socket makes the suite timing-dependent, which §59 forbids.
 *
 * It enforces the protocol rather than echoing success: PKCE is verified,
 * codes are single-use, refresh tokens rotate, and an unknown code is a
 * 400 with an OAuth error body. A fake that always says yes tests nothing.
 */

export interface FakeProviderOptions {
  /** Scopes the user actually consents to. Default: whatever was asked. */
  grantScopes?: readonly string[];
  /** Seconds. Default 3600. `null` to omit `expires_in` entirely. */
  expiresIn?: number | null;
  /** Whether the grant includes a refresh token at all. */
  issueRefresh?: boolean;
  /** Rotate the refresh token on every use, as Google does. */
  rotateRefresh?: boolean;
  requireClientSecret?: string;
}

interface Authorization {
  code: string;
  challenge: string;
  scopes: string[];
  used: boolean;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class FakeProvider {
  readonly authorizeUrl = 'https://accounts.example.com/authorize';
  readonly tokenUrl = 'https://accounts.example.com/token';
  readonly origin = 'https://accounts.example.com';

  /** Every token request body seen, for assertions about what was sent. */
  readonly requests: Array<Record<string, string>> = [];

  private readonly authorizations = new Map<string, Authorization>();
  private readonly refreshTokens = new Map<string, { scopes: string[]; live: boolean }>();
  private counter = 0;

  constructor(private readonly options: FakeProviderOptions = {}) {}

  /** What the user's browser would do: consent, and come back with a code. */
  consent(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    const method = url.searchParams.get('code_challenge_method');
    if (method !== 'S256') throw new Error(`provider requires S256, got ${String(method)}`);

    const asked = (url.searchParams.get('scope') ?? '').split(' ').filter((s) => s !== '');
    const code = `code-${++this.counter}`;
    this.authorizations.set(code, {
      code, challenge, used: false,
      scopes: [...(this.options.grantScopes ?? asked)],
    });

    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:1/cb');
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    return redirect.toString();
  }

  /** The user clicks "deny". */
  deny(authorizeUrl: string, error = 'access_denied'): string {
    const url = new URL(authorizeUrl);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:1/cb');
    redirect.searchParams.set('error', error);
    redirect.searchParams.set('error_description', 'The user said no.');
    redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
    return redirect.toString();
  }

  /** Revoke out of band, the way a user clicking "remove access" does. */
  revokeAll(): void {
    for (const entry of this.refreshTokens.values()) entry.live = false;
  }

  net(): Net {
    return {
      fetch: (url, init) => {
        if (url !== this.tokenUrl) return Promise.resolve(this.json(404, { error: 'not_found' }));
        const form = new URLSearchParams(init?.body ?? '');
        const seen: Record<string, string> = {};
        for (const [k, v] of form) seen[k] = v;
        this.requests.push(seen);
        return Promise.resolve(this.token(form));
      },
    };
  }

  private token(form: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
    const required = this.options.requireClientSecret;
    if (required !== undefined && form.get('client_secret') !== required) {
      return this.json(401, { error: 'invalid_client' });
    }
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') return this.fromCode(form);
    if (grant === 'refresh_token') return this.fromRefresh(form);
    return this.json(400, { error: 'unsupported_grant_type' });
  }

  private fromCode(form: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
    const auth = this.authorizations.get(form.get('code') ?? '');
    if (auth === undefined || auth.used) return this.json(400, { error: 'invalid_grant' });

    const verifier = form.get('code_verifier') ?? '';
    if (s256(verifier) !== auth.challenge) return this.json(400, { error: 'invalid_grant' });

    auth.used = true;
    return this.issue(auth.scopes);
  }

  private fromRefresh(form: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
    const token = form.get('refresh_token') ?? '';
    const entry = this.refreshTokens.get(token);
    if (entry === undefined || !entry.live) return this.json(400, { error: 'invalid_grant' });
    if (this.options.rotateRefresh === true) entry.live = false;
    return this.issue(entry.scopes, this.options.rotateRefresh === true);
  }

  private issue(scopes: string[], forceNewRefresh = false): { status: number; headers: Record<string, string>; body: string } {
    const body: Record<string, unknown> = {
      access_token: `access-${++this.counter}`,
      token_type: 'Bearer',
      scope: scopes.join(' '),
    };
    const expiresIn = this.options.expiresIn === undefined ? 3600 : this.options.expiresIn;
    if (expiresIn !== null) body['expires_in'] = expiresIn;

    if (this.options.issueRefresh !== false || forceNewRefresh) {
      const refresh = `refresh-${++this.counter}`;
      this.refreshTokens.set(refresh, { scopes: [...scopes], live: true });
      body['refresh_token'] = refresh;
    }
    return this.json(200, body);
  }

  private json(status: number, body: unknown): { status: number; headers: Record<string, string>; body: string } {
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }
}
