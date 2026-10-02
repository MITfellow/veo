# M1 — Security core: design note and test list

Written before the code, per §36. Scope is §33's M1 line only.

> keyring, Argon2id + recovery code, per-item encryption, vault with secret
> references, model-request firewall, lock/unlock/panic, audit chain,
> **trust lattice**.
> *Done when:* the secret-leakage fuzz finds zero hits and a secret value
> provably never exists outside the vault boundary.

M0 already shipped the trust *lattice values* (`TrustLevel`, `minTrust`,
`atLeastTrust`) because the event envelope needed them. M1 makes trust
**load-bearing**: effective trust computed over a causal closure, and a
capability set derived from it.

## The threat model this is built against

Not "someone steals the laptop" — full-disk encryption is the user's job. The
threats that are *ours*:

1. **A bug upstream leaks a credential into the log, a context, or a model
   request.** Most likely failure by far, and the one §13.2 and §31 target.
   Defence is depth: redaction at append (M0), the vault never returning values
   to callers that could log them, and the firewall as a final backstop.
2. **Backups make deletion a lie.** A row deleted today is still in last week's
   snapshot. Only crypto-shredding fixes this (§13.3).
3. **Injected content escalates capability.** M4's problem, but the mechanism —
   effective trust → capability set — must exist and be tested now (§12 says
   "build this before any tool").
4. **The passphrase is lost.** A recovery code is a second unwrap path, not a
   backdoor: it unwraps the same MDK and is never derivable from the first.

## Key hierarchy (§13.1)

```
passphrase ──Argon2id(salt, m=64MiB, t=3, p=1)──▶ Root Key   [memory only]
                 │
                 ├─HKDF(info="mdk-wrap")──▶ KEK_root ──wraps──▶ MDK
                 ├─HKDF(info="index")─────▶ Index Key          [deterministic]
                 │
recovery code ──Argon2id(salt2)──▶ Recovery Key ──wraps──▶ MDK (second copy)
                 │
MDK ──HKDF(info="item:"+itemId)──▶ per-item key   [derived, never stored]
```

Decisions inside this, each with its own doc:

- **Per-item keys are *derived* from the MDK, not generated and stored.**
  Storing N wrapped keys means N rows to keep consistent with N items, and a
  shred that misses a row is a silent failure. Deriving means the key for an
  item exists only while in use. **Shredding then needs an explicit tombstone**
  (see D-011) — that is the cost, and it is worth it because the tombstone is
  the auditable artifact §13.3 asks for anyway.
- **AES-256-GCM, not XChaCha20-Poly1305.** §6 permits either and mandates
  webcrypto; webcrypto has AES-GCM and not XChaCha20. Picking the one the
  mandated library actually provides.
- **Argon2id comes from `hash-wasm`.** §6 says "webcrypto only" *and*
  "Argon2id". Those conflict — webcrypto has no Argon2id (verified). D-009.

## Where the vault boundary actually is

This is the heart of M1, so stating it precisely:

```
            ┌──────────────── vault boundary ────────────────┐
  caller ──▶│ resolve(ref) → never returns the value         │
            │                                                 │
            │ useSecret(ref, fn) → fn(value) → zeroize       │
            └─────────────────────────────────────────────────┘
                              │
                     value exists only inside fn's frame
```

`Vault.resolve()` **does not exist** as a public method returning a string.
The only way to touch a secret value is `useSecret(ref, async (value) => …)`,
which:

1. unwraps into a `Uint8Array`,
2. registers the value with the `Redactor` so any accidental logging of it is
   caught by M0's append-time redaction,
3. runs the callback,
4. zeroizes the buffer in a `finally`,
5. emits `vault.secret.read` with who/when/which run/which tool — never the
   value.

A method that returns the value would be used, and then logged, and then we
would be writing a post-mortem. Making the unsafe thing *unexpressible* is
cheaper than making it discouraged.

The caveat worth being honest about: JavaScript strings are immutable and
copied by the runtime, so a secret that becomes a `string` cannot be reliably
zeroized. Secrets are therefore `Uint8Array` end to end inside the boundary,
and the callback receives bytes. Tools that need a string get one *inside* the
callback and it dies with the frame — best achievable on this runtime, and
D-012 records that limitation rather than pretending it away.

## Effective trust and capability (§12)

```ts
effectiveTrust(stepId) = min( trust of every event in the causal closure )
capabilitiesFor(trust) = CAPABILITY_CEILING[trust]
```

The ceiling for FOREIGN is the spec's list in §12.2 inverted into an allowlist:
no `vault:read`, no `spend`, no `send`, no `fs:write` outside sandbox, no new
egress host. Deny-by-default: a capability absent from the ceiling table is not
granted, so adding a capability later cannot accidentally be granted to
FOREIGN by omission.

## Shape

```
src/security/
  crypto.ts    CryptoPort over webcrypto + hash-wasm Argon2id
  keyring.ts   the hierarchy, lock/unlock/panic, recovery code
  vault.ts     secret refs, useSecret, rotation, destroy
  cipher.ts    per-item encrypt/decrypt + the EncryptedBlob envelope
  shred.ts     crypto-shredding + tombstones
  trust.ts     effective trust over causal closure, capability sets
  firewall.ts  the outbound model-request scan
  audit.ts     privileged-action queries over the log
```

## Test list (written before the implementation)

**unit/crypto**
1. AES-256-GCM round-trips; ciphertext differs from plaintext
2. a tampered ciphertext fails to decrypt (auth tag works)
3. wrong AAD fails to decrypt
4. nonces never repeat across 10k encryptions with the same key
5. HKDF is deterministic for the same (key, info) and differs across info
6. Argon2id is deterministic for (passphrase, salt) and differs across salt
7. `randomBytes` is injectable, so the suite is deterministic

**unit/keyring**
8. unlock with the right passphrase yields a usable MDK
9. unlock with the wrong passphrase fails and does not leak *why*
10. the Root Key is never persisted — scan every table for it
11. the MDK on disk is wrapped, never plaintext
12. the recovery code unwraps the same MDK as the passphrase
13. the recovery code is not derivable from the passphrase wrap
14. rotating the passphrase keeps the MDK (data stays readable)
15. lock zeroizes: after `lock()`, no key material is reachable
16. panic destroys both wraps; the data is then unrecoverable *forever*,
    verified by attempting unlock with the correct passphrase afterwards
17. the Index Key is deterministic across unlocks (searchable fields depend on it)

**unit/trust**
18. `effectiveTrust` over a chain SYSTEM→USER→FOREIGN is FOREIGN
19. one FOREIGN ancestor poisons an otherwise USER chain
20. capability sets shrink monotonically as trust drops
21. FOREIGN has none of: `vault:read`, `spend`, `send`, `fs:write`
22. an unknown capability is denied at every level (deny-by-default)
23. escalation from FOREIGN requires approval and emits `policy.escalated`
    carrying the asking content

**integration/vault**
24. creating a secret returns a `secret://name/version` ref, never the value
25. the value is absent from the created event's payload
26. `useSecret` yields the value to the callback and zeroizes after
27. every resolution emits `vault.secret.read` with run/tool, without the value
28. rotation creates v2; v1 still resolvable until destroyed
29. destroying a version makes it unresolvable; the event remains
30. `list()` returns names and metadata only — asserted field by field
31. reads are refused while locked

**integration/shred**
32. an encrypted item is readable, then unreadable after shredding
33. the ciphertext row survives the shred (deletion stays auditable)
34. shredding is idempotent
35. a shredded item stays shredded across a rebuild from the log
36. **shredded content is unreadable with full DB access** — the adversarial
    version: dump every table and assert the plaintext appears nowhere

**integration/firewall**
37. a model request containing a known secret is refused, not scrubbed
38. the refusal names which secret label, never the value
39. a request containing a secret *fragment* below the match threshold passes
    (and this is documented as a known limit, not a silent one)
40. the firewall catches a secret that a deliberately leaky fake tool put into
    tool output (§13.2's required test)

**adversarial/secret-leakage** (the M1 "done when")
41. fuzz: create 50 secrets, drive 200 operations that touch them, then scan
    **every surface** — all event payloads, all projection rows, all log lines,
    all model requests, the export — for every secret value. Zero hits.
42. the same fuzz with secrets embedded in error messages and stack traces
43. the same fuzz with a secret used as an object *key*

**integration/audit**
44. the privileged-action query returns vault reads, approvals, denials and
    shreds for a time range
45. the audit chain over those events verifies
46. an audit query cannot itself read a secret value

Target: 46 tests, offline, deterministic, under 15s (Argon2id runs at test cost
parameters — see D-010).
