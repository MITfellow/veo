# 029 — Recall is synchronous, so the embedder runs before the run

**Status:** accepted · **Milestone:** M6 · **Spec:** §21, §22.6

## The ambiguity

§22.6 specifies hybrid retrieval with a semantic component, which means
calling an embedder, which is asynchronous. §21's `MemorySource.recall()` —
declared at M5, before any of this existed — is **synchronous**, because the
context assembler is a pure function and the snapshotter is called inside the
run loop.

Those two cannot both be satisfied as written.

## The decision

Keep `recall()` synchronous. Add a `prime()` path that runs the real
asynchronous hybrid recall *before* the run starts, from the HTTP layer,
which is the only place that has the user's text that early. `recall()`
returns what `prime()` left in a one-entry cache, keyed by the query.

When nothing has been primed — a scheduled run, a resumed run, a caller that
does not know about priming — `recall()` falls back to a synchronous ranking:
lexical overlap plus importance, no embedder.

## Why not the alternatives

**Make the port async.** It propagates: `gather()` becomes async, then the
run loop, then everything that composes it. §21's purity is load-bearing for
the golden tests (a pure assembler is a function of its input and can be
diffed), and I am not spending that to avoid a cache.

**Block on the embedder inside `recall()`.** Synchronous network I/O in the
run loop. No.

**Drop semantic recall.** It is the component §22.6 names first.

## What this costs

Two paths through retrieval, and the fallback is measurably worse — no
semantic matching at all. That is a real deficiency and it is declared in
`M6.md` rather than hidden: a scheduled run recalls worse than an interactive
one. It is acceptable because the degradation is *graceful and in the right
direction* — the cold path still returns the user's pinned and most important
memories, which is what a cold path should prioritise.

## What would change my mind

A local embedder with sub-millisecond synchronous inference would remove the
reason for the split entirely.
