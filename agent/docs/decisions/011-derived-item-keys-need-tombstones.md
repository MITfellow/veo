# 011 — Per-item keys are derived, so shredding needs explicit tombstones

**Status:** accepted · **Milestone:** M1

## Context

§13 specifies `MDK → HKDF("item:" + id) → per-item key`, and §13.3 specifies
crypto-shredding: deleting means destroying the key, after which the
ciphertext is noise.

Derivation and shredding are in tension. A *stored* per-item key can be
deleted, and then it is gone. A *derived* key cannot be deleted — it is a pure
function of the MDK and the item id, so it can always be recomputed. Deriving
and then "destroying" the key accomplishes nothing at all.

## Options

1. **Store per-item keys** in a table, wrapped by the MDK. Deletion is a row
   delete. But this is thousands of rows of key material, a new thing to back
   up, leak, and get out of sync with the data.
2. **Derive, plus a tombstone** the key derivation consults.

## Decision

Option 2. `Keyring.itemKey(id)` stays derived, and a `shred_tombstones` table
records every shredded item id. `ShreddingCipher` checks the tombstone before
decrypting and raises the *same* `DecryptionError` a corrupt ciphertext
raises, so "forgotten" is indistinguishable from "unreadable". `Shredder.shred`
also overwrites the ciphertext at its recorded locations, so the bytes are
gone even for someone who ignores the tombstone entirely.

The tombstone table is append-only, enforced by SQLite `BEFORE DELETE` and
`BEFORE UPDATE` triggers that raise. Deleting a tombstone would resurrect the
ability to read shredded data, so the database refuses.

## Consequences

- **This is weaker than key deletion and it must be said plainly.** An
  attacker with the MDK, a copy of the ciphertext taken *before* the shred,
  and the ability to bypass the application can still recover the plaintext.
  Key deletion would stop them; derivation cannot.
- What the tombstone does guarantee: no code path in this system reads a
  shredded item, the stored bytes are overwritten, and the deletion is
  recorded as an event.
- Revisit at M6 if memory items turn out to warrant stored keys; the
  `ItemCipher` interface would not change.
