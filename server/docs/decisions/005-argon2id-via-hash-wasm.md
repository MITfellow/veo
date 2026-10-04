# 005 — Argon2id comes from `hash-wasm`; it is the third runtime dependency

**Status:** accepted
**Date:** 2026-10-04

## Context

§11 requires Argon2id and says "Node `webcrypto` only. No custom crypto, ever."
Appendix D.1 sets the runtime budget at two dependencies and asserts that
"Argon2id, AES-256-GCM, HKDF and ULID generation all come from Node's
`webcrypto` and `crypto`".

That assertion is false, and it is checkable in one command:

```
PBKDF2   importKey OK
HKDF     importKey OK
Argon2id NotSupportedError: Unrecognized algorithm name
```

Node 20 and Node 22 both ship WebCrypto without Argon2id; it is not in the W3C
algorithm registry at all. So the three available routes are:

1. **`scrypt`** — Appendix E.9 rules this out explicitly.
2. **Implement Argon2id** — forbidden by §11's "no custom crypto, ever", and
   correctly so: a hand-rolled memory-hard KDF is exactly the code that is
   catastrophic when subtly wrong and silent about being wrong.
3. **Add a dependency** — which E.9 anticipates: *"Use `argon2` only if
   `webcrypto` cannot provide it… Prefer a pure-WASM build over a native one."*

## Decision

Add **`hash-wasm`** as the third runtime dependency, behind the `Crypto` port.

**What it does:** compiled-to-WASM reference implementations of Argon2 and
other hashes. We use `argon2id` and nothing else.

**Why stdlib is insufficient:** demonstrated above — the algorithm does not
exist in `webcrypto`, at any Node version.

**Why this package:** zero transitive dependencies (verified:
`dependencies: {}`), 2.1 MB installed, pure WASM so no node-gyp, no native
toolchain and no per-platform prebuild. The native `argon2` package is the
alternative E.9 names second, and it would make `npm install` require a C++
compiler — a real cost for a system meant to be installed with one command
(§54).

**Cost of removal:** one file. `src/security/kdf.ts` is the only importer, and
it exposes `deriveRootKey(passphrase, salt, params)`. Swapping to native
`argon2`, or to a future `webcrypto` Argon2id, is a change to that file alone.

## Consequences

* The dependency budget is now three. This is the only addition anticipated;
  AES-256-GCM and HKDF really are in `webcrypto` and really are used from it.
* Argon2id parameters live in config (§D.4: `memMiB: 64, iterations: 3,
  parallelism: 1`). At those settings a derivation costs ~330 ms, which is the
  point of a KDF. **Tests override to 8 MiB / 1 iteration** — not to weaken a
  test, but because the test suite's subject is the key hierarchy, not the
  cost factor, and §57 budgets the whole suite at 60 s. One test asserts the
  shipping parameters are what config actually defaults to.
