import type { CryptoPort } from '../../substrate/ports.js';

/**
 * PKCE (RFC 7636) and the other single-use random values an authorization
 * code flow needs.
 *
 * PKCE is not optional here even though this is a "confidential" client in
 * the classic sense. The redirect lands on a loopback listener that any
 * local process could race for, so the authorization code is assumed to be
 * interceptable, and the verifier is the thing that makes an intercepted
 * code useless.
 *
 * All randomness comes from the injected `CryptoPort` — the lint rule bans
 * ambient `crypto` outside `substrate/`, and a test that cannot fix the
 * verifier cannot assert the challenge.
 */

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** RFC 4648 §5 base64url, no padding. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A code verifier: 43–128 characters from the unreserved set.
 *
 * Built by indexing the unreserved alphabet rather than base64url-ing raw
 * bytes, because the alphabet is 64 characters long and `256 % 64 === 0`,
 * so a byte maps onto a character with no modulo bias.
 */
export function codeVerifier(crypto: CryptoPort, length = 64): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += UNRESERVED[b % UNRESERVED.length];
  return out;
}

/** S256 only. `plain` is in the RFC and is not implemented here on purpose. */
export function codeChallenge(crypto: CryptoPort, verifier: string): string {
  return base64url(hexToBytes(crypto.sha256(verifier)));
}

/** CSRF value for the `state` parameter, and the nonce for OIDC if asked. */
export function opaqueToken(crypto: CryptoPort, bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

/**
 * Constant-time string comparison, for `state`.
 *
 * `===` on a secret leaks its prefix through timing. The value compared
 * here is low-value and local, but a codebase in which secret comparison
 * is sometimes careful and sometimes not is one where the careless form
 * eventually lands somewhere it matters.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
