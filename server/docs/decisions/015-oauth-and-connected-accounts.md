# 015 — OAuth: the whole mechanism, missing only the credentials

Status: accepted
Date: 2026-10-07
Builds on: 013 (egress), 014 (the broker), 006 (per-item keys)

## What exists

- `src/capability/auth/pkce.ts` — S256 verifier/challenge, opaque state,
  constant-time comparison.
- `src/capability/auth/oauth.ts` — authorization code flow with PKCE,
  refresh, expiry with skew. Knows the protocol; knows no provider.
- `src/capability/auth/identities.ts` — connected accounts, tokens in the
  vault, refresh-on-use.
- Schema **v9**: table `identities`.
- `test/fakes/oauth-provider.ts` + `test/integration/oauth.test.ts` — 24
  tests against a provider that enforces the protocol.

Attaching Google is a `ProviderConfig`: three URLs, a client id, a scope
list. No new code — the same promise §59.17 makes about the model.

## Why PKCE on a client that has a secret

The redirect lands on a loopback listener. Any local process can race for
that port, and an authorization code on a URL is as good as a password
until it is exchanged. PKCE makes a stolen code worthless, because the
verifier never left this process. The test
*is useless to someone who steals the code but not the verifier* is the
one that matters: the attacker holds the entire callback URL and still
cannot exchange it, and the legitimate client still can.

`plain` is in RFC 7636 and is deliberately not implemented.

## Tokens in the vault, references in the table

The `identities` row holds provider, label, scope, granted scopes, status
and two `secret://` URIs. It never holds a token. Two consequences:

- `IdentityStore.refs()` — what the broker consumes to choose an account —
  is metadata that is safe to log and show. A routing decision is made
  entirely over values that are not secret. Tests assert that neither a
  token nor even a `secret://` ref appears in it.
- Locking the vault makes every connected account unusable without
  touching a row, and panic destroys them for real.

The token becomes a string inside `withAccessToken(id, client, use)` and
is gone when the closure returns (§23).

## Refresh on use, not on a timer

A background refresher renews tokens nobody is using, and when it fails
there is no run, no user and nobody to ask to sign in again. Refreshing at
the moment of use means the failure surfaces attached to the work that
needed it — which is exactly where a "sign in to Gmail again" prompt
belongs.

A failed refresh sets `status = 'expired'` and records the provider's
message, so the next routing attempt refuses with a remedy (014) instead
of the user watching every call 401.

Rotating refresh tokens are followed; providers that do not rotate get the
old token carried forward. Getting this backwards is a session that dies
silently a month later.

## `identities` is not a projection

Projections are dropped and rebuilt from the event log (M0's byte-identity
gate). A dropped `identities` table would orphan the vault secrets it
points at — live tokens with no reference. So it is authoritative state,
like `secrets` and `keyring`, and it is not in `PROJECTION_TABLES`.

This also avoided adding event types, which decision 003 closed.

## The provider in the tests is a `Net`, not a server

Two reasons, both forced:

1. The egress guard refuses loopback (013). A real local HTTP server
   could only be reached by punching a hole in the thing under test.
2. A socket makes the suite timing-dependent, and §59 requires
   deterministic and offline.

The fake enforces PKCE, burns codes after one use, rotates refresh tokens
when asked, and returns OAuth-shaped error bodies. A fake that always says
yes would have let every test above pass with no implementation.

## Still missing

- **Credentials.** No client id for any real provider.
- **The loopback redirect listener.** `redirect_uri` is configured and the
  callback URL is parsed, but nothing serves `127.0.0.1:8899` yet; the
  flow is currently driven by handing `complete()` a callback URL.
- **Revocation at the provider.** `disconnect()` marks the row; it does
  not call a revocation endpoint.
- No connector uses `withAccessToken` yet — the seven manifests in 014
  still describe things that do not dial out.
