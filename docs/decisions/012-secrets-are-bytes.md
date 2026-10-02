# 012 — A secret is a `Uint8Array` inside the boundary, never a `string`

**Status:** accepted · **Milestone:** M1

## Context

Invariant 7: a secret value never exists outside the vault boundary. JS
strings are immutable and interned — once a credential is a `string` it cannot
be overwritten, it lives until the GC collects it, it can be copied silently,
and it shows up in heap dumps and core files.

## Decision

Inside the boundary secrets are `Uint8Array`. `Vault.useSecret(ref, ctx, fn)`
hands the callback bytes and zeroizes them in a `finally` — including when the
callback throws. There is **no** method anywhere in the Vault that returns a
secret value: not `get`, not `resolve`, not `peek`. The scoped callback is the
only door, which is what makes "did anything read this credential?" answerable
from the audit log.

`Vault.create` accepts a `string` for ergonomics at the single point of entry
(a human typing a key), converts immediately, and zeroizes the byte copy.

## Consequences

- **A limit that is documented rather than pretended away:** a tool that needs
  a `string` must build one inside the callback, and *that* string cannot be
  zeroized. The boundary shrinks the exposure to one stack frame; it cannot
  eliminate it. Honest statement of the limit beats a false guarantee.
- Every callback is a measured, attributed read: `vault.secret.read` records
  `{ref, tool}` and never the value.
