# 009 — Argon2id comes from `hash-wasm`, not webcrypto

**Status:** accepted · **Milestone:** M1

## Context

§6 says "Node webcrypto only" for cryptography. §13 says the passphrase is
stretched with **Argon2id** (m=64MiB, t=3, p=1). These cannot both be
satisfied: Node's webcrypto implements PBKDF2, HKDF, ECDH and AES, and nothing
else for key derivation. Verified directly — `crypto.subtle.importKey(...,
'Argon2id', ...)` throws a `DOMException`.

This is the spec being wrong once in the code, so per §36 it is stated
explicitly rather than silently worked around.

## Options

1. **PBKDF2-SHA256 with a very high iteration count** — stays inside
   webcrypto, zero dependencies. But PBKDF2 is not memory-hard; a GPU or ASIC
   attacker gets orders of magnitude more guesses per dollar against a
   passphrase a human can remember. For a vault that must resist offline
   attack for ten years this is the weaker choice.
2. **Hand-write Argon2id** — no dependency, but hand-rolled crypto in a
   security boundary is the single worst idea available.
3. **One audited WASM implementation for that one primitive.**

## Decision

Option 3: `hash-wasm` provides Argon2id; **everything else** — AES-256-GCM,
HKDF, random bytes — stays on Node webcrypto exactly as §6 requires.

`hash-wasm` is justified against §36's "no dependency without justification":
it is a WASM build of reference implementations, has no transitive
dependencies, does no I/O, and is used behind the `CryptoPort` interface, so
replacing it means changing one file.

## Consequences

- The §6 sentence should read "Node webcrypto only, except Argon2id, which
  webcrypto does not provide". Proposed as a spec amendment.
- Password stretching is memory-hard: 64 MiB per guess.
- Argon2id is the only asynchronous-WASM part of the crypto port, which is
  why `CryptoPort.argon2id` is async while the rest could have been sync.
