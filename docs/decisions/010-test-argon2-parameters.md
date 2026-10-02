# 010 — Tests use deliberately weak Argon2 parameters

**Status:** accepted · **Milestone:** M1

## Context

Production Argon2id (m=64MiB, t=3, p=1) measures **272ms** per derivation in
this sandbox. Nearly every security test calls `initialize` **and** `unlock`,
which is two derivations, or ~550ms per test. Across ~70 security tests that
is 38 seconds on its own, against a total suite budget of **<60s** (§6).

A slow suite is not a cosmetic problem: a suite people avoid running is a
suite that stops catching things.

## Decision

`PRODUCTION_ARGON2` = {m: 65536 KiB, t: 3, p: 1}. `TEST_ARGON2` = {m: 8192
KiB, t: 1, p: 1}, ~50ms. `createTestSecurity` uses `TEST_ARGON2`;
`createSecurity` defaults to `PRODUCTION_ARGON2` and the parameters are an
explicit constructor argument, never read from a global or an env var.

Both go through the identical code path — only the cost parameters differ — so
tests exercise the real derivation, just cheaply.

## Consequences

- The security suite runs in ~4s rather than ~40s.
- **Risk accepted and mitigated:** nothing may ship test parameters by
  accident. Mitigation is that `createSecurity` requires no argument to get
  production strength — weakening is opt-in, visible at the call site, and the
  weak constant's name says `TEST`.
- Argon2 parameters are stored *with* the keyring row, so raising production
  cost later does not lock anyone out: existing keyrings unwrap at their
  recorded cost and can be re-wrapped at the new one.
