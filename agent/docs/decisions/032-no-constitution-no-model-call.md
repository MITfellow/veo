# 032 — No constitution, no model call (and no fallback branch)

**Status:** accepted · **Milestone:** M7 · **Spec:** §25, §26, invariant 15

## The ambiguity

§21 puts the constitution in the context, and §25 says it governs
generation. Neither says what happens if a call is assembled without it —
a new code path, a background job, a retry that rebuilds the request, a
future tool-use loop that constructs its own messages. In every system of
this shape, that path eventually exists.

## The decision

`GovernedProvider` wraps *the* model provider at the composition root, and
`assertGoverned()` runs **before** the inner provider is touched. It scans
only `role: 'system'` messages for a sentinel

```
[constitution v7 · sha 3f1c… · articles F1,F2,F4,U3]
```

and throws `UngovernedModelCallError` if the sentinel is missing or its
version/hash is stale. There is **no fallback branch** — no "assemble a
minimal constitution and continue", no warn-and-proceed. The run fails,
loudly, and the failure says which version was expected and which was
found.

Only system messages are scanned, because the model can and does echo text
it has seen; its own output must never be able to satisfy the gate.

## Why not the alternatives

**Check inside the assembler.** The assembler is one caller. The gate must
be at the last point before the network, which is the provider.

**Warn and continue.** The warning goes to a log nobody reads, and the
property "every answer this agent has ever produced was produced under a
known version of its contract" — which is the property that makes the
compliance table and the amendment history mean anything — becomes "almost
every".

**Inject the constitution at the provider if it is missing.** Then the
provider needs the context assembler, L2 depends on L4, and the dependency
rule in §7 is broken to paper over a bug upstream. Refusing is cheaper and
truer.

## The cost, stated plainly

The hash must match exactly, so a constitution amended *during* a run
invalidates an in-flight request. The run fails and the next one succeeds.
That is the correct trade: the alternative is an answer generated half
under one contract and half under another, with no way to say afterwards
which one applied.
