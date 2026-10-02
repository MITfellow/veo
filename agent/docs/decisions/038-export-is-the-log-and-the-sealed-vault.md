# 038 — An export is the log plus the sealed vault, and import never merges

**Status:** accepted · **Milestone:** M9 · **Spec:** §13, §29, §34.2

## The ambiguity

§29 says `POST /export  POST /import   full portability` and nothing
else. "Full" has to be decided: how much of the database, what happens
to secrets, and what an import does to an agent that already has a life.

## The decision

**Export the events and the sealed vault. Nothing else.**

The log is the only source of truth (invariant 1), so an export of it is
both the smallest honest export and the most complete one — every
projection at the destination is rebuilt from it, which makes the import
a free end-to-end test of the rebuild path §34.2 already requires. The
alternative, dumping every table, would ship derived state that could
silently disagree with the events that produced it.

**Secrets travel as ciphertext, with their wrapped keys.** §13 says a
secret value never exists outside the vault boundary and does not carve
out an exception for portability. So an export is useless to a thief
without the passphrase, and an import without the passphrase restores
everything except the ability to *use* the secrets. A test fuzzes the
serialised export for a known secret value and requires zero hits.

**Import refuses a non-empty log.** Merging two event logs means
reconciling two hash chains and two ULID orderings, and the result of
getting that subtly wrong is a personal history that is quietly wrong
about when things happened. A refusal is recoverable; a bad merge is
not. Import into an empty agent verifies the chain *before* projections
exist, replays, rebuilds, and compares the digest.

**Import is atomic.** One transaction; any failure — broken chain,
invalid payload, constraint violation — rolls back and the destination is
left empty. A half-imported personal agent is worse than a failed import,
because the user cannot tell which half they have.

## A digest mismatch is reported, not fatal

If the rebuilt projections differ from the source's digest, the import
still succeeds and says so with both digests. Different versions of the
agent legitimately produce different projections from identical events —
that is what a projector version is for — and refusing the import would
make upgrading impossible. Silently ignoring it would make corruption
invisible. Reporting it is the only option that is both.
