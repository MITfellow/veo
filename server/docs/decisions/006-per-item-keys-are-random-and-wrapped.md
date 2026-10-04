# 006 — Per-item keys are random and wrapped, not derived; and vault material is not a projection

**Status:** accepted
**Date:** 2026-10-04

Two corrections to §23, both found by trying to make crypto-shredding
actually work.

## 1. Derived per-item keys cannot be shredded

§23's diagram shows the hierarchy as pure derivation:

```
Master Data Key ──▶ per-secret keys
                └─▶ per-memory-item keys   ← enables shredding
```

If an item key is `HKDF(MDK, info = itemId)`, then **it cannot be destroyed**.
Anyone holding the MDK can re-derive it at will, forever. Deleting a derived
key deletes nothing. The annotation "enables shredding" is only true of the
opposite construction.

**Decision:** each item key is **32 random bytes**, encrypted under the MDK and
stored as a row in `item_keys`. Shredding is `DELETE FROM item_keys WHERE
key_id = ?`. The ciphertext it protected may survive in backups, on disk, in
free pages — and is permanently unreadable, which is what §23 promises and
what invariant 10 requires.

The MDK itself remains the root of the wrapping tree, so losing it still loses
everything. The difference is that individual items can now be lost *on
purpose*.

## 2. The recovery code requires a random MDK, not a derived one

§23 shows the Master Data Key being HKDF'd from the Root Key, and also requires
an offline recovery code as "a second unwrap path". These are incompatible: if
the MDK is a deterministic function of the passphrase, there is only ever one
path to it, and a recovery code could only work by storing the passphrase.

**Decision:** the MDK is **random, generated once at `init`**, and wrapped
twice — once under a key derived from the passphrase, once under a key derived
from the recovery code. Either unwraps it; neither reveals the other. This is
the standard envelope construction and it is the only one that satisfies both
sentences of §23.

## 3. Vault material is durable state, not a projection

Invariant 1 says the event log is the only source of truth, and §16 says
everything else is a rebuildable projection. Wrapped keys and secret
ciphertext are neither:

* They **cannot** go in the log. The log is the thing we hand to someone to
  verify (§15 hash chain), and §23 forbids a secret value appearing in any
  event. A log containing the wrapped MDK would also make `panic` impossible —
  destroying the key would mean rewriting history, which invariant 2 forbids.
* They **cannot** be rebuilt. They are high-entropy bytes from a CSPRNG. No
  replay reconstructs them.

**Decision:** `keyring`, `secrets` and `item_keys` are durable non-projected
tables. They are excluded from `PROJECTION_TABLES`, so `rebuild` does not drop
them and the §16 identity test does not cover them — correctly, because a
rebuild that destroyed the vault would be a data-loss bug wearing the costume
of a correctness guarantee.

What *does* go in the log is the **metadata**: `vault.secret.created` records
the name, version and key id; `vault.secret.read` records who, when, which run
and which tool. Never a value. The audit trail is complete and the secrets are
absent — which is the property §23 is actually asking for.
