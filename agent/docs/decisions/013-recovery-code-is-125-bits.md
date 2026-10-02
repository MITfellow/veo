# 013 — The recovery code is 25 Crockford characters (125 bits), and is normalized before use

**Status:** accepted · **Milestone:** M1

## Context

Two bugs found by `test/unit/keyring.test.ts`, both worth recording because
both are a *class* of bug, not a typo.

**1. Normalize on write, not only on read.** The code was generated and
displayed dashed (`ABCDE-FGHIJ-…`), wrapped the MDK under the dashed form, and
`unlockWithRecoveryCode` normalized its input (upper-case, strip dashes, map
Crockford's ambiguous `I/L→1`, `O→0`) before deriving. A user who transcribed
their code **correctly** would therefore have been locked out — and would only
have discovered it on the day they needed it, which is the worst possible day.

**2. The length did not divide into groups.** 26 characters cannot be shown as
groups of five.

## Decision

- 25 Crockford base32 characters = **125 bits**, displayed as five groups of
  five.
- `normalizeRecoveryCode` is applied on **both** paths — wrap and unwrap — and
  the round trip is tested with deliberately mangled input (lower-case, no
  dashes, `O` for `0`, `l` for `1`).

125 bits is far beyond brute force, and each guess additionally costs an
Argon2id derivation.

## Consequences

- General rule, now enforced by test: **if a credential is normalized on the
  read path it must be normalized on the write path.** Any future credential
  (device pairing code, export passphrase) must round-trip through a mangling
  test before it ships.
- Changing the code format after a keyring exists would invalidate recovery
  codes, so the format is frozen as of M1.
