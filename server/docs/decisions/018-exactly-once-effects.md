# 018 — Exactly-once external effects, and a reopened event union

Status: accepted · Supersedes nothing · Amends 003

## Context

Two things happened at once.

**First, the specification was replaced.** A new, larger document —
"ARISH — The Complete Personal Agent" — arrived and supersedes the one
this repository was built against. Most of it is compatible: the four
layers, the milestone discipline, the model-attaches-later rule and the
evidence-based gates all survive intact. Some of it is new, and §13
("exactly-once external effects") is the first new subsystem that is
fully specified in the portion received.

**The paste is truncated at §20.** Parts IV–VIII and Appendices A–H are
missing: the 14 connectors, the 18 workflows, Part VI browser use,
Part VII Veo integration, the M0–M18 milestone table in §36, Appendix D's
bootstrap, Appendix E's 40 pre-answered decisions, and Appendix F. The
response to that is *not* to guess at them. It is to build the one
subsystem the received text fully specifies and to name the gap. This
record is where the gap is named.

Known divergences from the received text, not yet acted on:

* **Node 22+** is now required; decision 002 pinned `engines >=20`.
* **§16.1 names fifteen cognitive jobs**; eleven exist. Missing:
  `page.extract`, `intent.parse`, `priority.score`.
* **§4.1** adds hard limits — files ≤400 lines, functions ≤50,
  complexity ≤10. These were already the lint configuration, which is
  why this change had to split `registry.ts`.
* **§31.2: Veo is eleven files.** The collision flagged in decision 001
  is still unresolved and still unraised with the user.

## Decision — the shape of an effect

An external effect is **two events, never one**:

1. `effect.intended` — written *before* the world is touched, carrying an
   idempotency key.
2. `effect.committed` — written after.

A crash between them leaves an intention with no commitment. That is the
entire point: the uncertainty becomes a row you can query rather than a
silence you cannot. `Outbox.pending()` is the post-crash question.

**The idempotency key is `sha256(tool@version | canonicalJson(input) | stepId)`.**
`stepId` is in it deliberately. Without it, a genuine follow-up message
with identical content would collide with the first and be swallowed.
With it, a *replay of one step* deduplicates and a *second intention*
does not.

**Arguments are never stored — only their digest.** An outbox row
outlives the run that wrote it, and arguments carry recipients, amounts
and occasionally secrets. A test asserts the recipient address appears
in neither the row nor the event payload.

## Decision — never blindly retry

This is the rule the mechanism exists to enforce. On reconciliation:

| what the probe says | state | may the caller retry? |
|---|---|---|
| found it | `committed` | no — it happened |
| definitely not there | `absent` | **yes, and only here** |
| could not check | `needs_attention` | no — a human decides |
| probe threw | `needs_attention` | no |
| **no probe for this tool** | `needs_attention` | no |

The last row is the one that matters. The tempting default — "no probe,
so assume it did not happen, so retry" — is how an agent emails someone
twice. Absence of evidence is routed to a person. `ProbeResult` encodes
this in the type (`{found}` vs `{unknown}`) rather than in a convention,
because a convention would eventually be violated by a connector author
who had a deadline.

`Outbox` performs nothing. It has no `Net`, no tool registry, no way to
send an email; the caller acts *between* `intend` and `commit`. That is
what makes a crash testable — a test simply declines to call `commit`.

## Decision — reopening the closed event union (amends 003)

Decision 003 closed `EventType` to a fixed union so that an unknown type
is a compile error rather than a silently-dropped projection. That
reasoning stands. It never meant the union could not *grow*; it meant it
could not grow accidentally.

Four types are added: `effect.intended`, `effect.committed`,
`effect.compensated`, `effect.reconciled`. The new specification names
the `effect.*` family explicitly, each has a strict Zod payload schema,
each is produced by exactly one module, and each is consumed by the
outbox projector. The union stays closed; it is four members longer.

Schema **v11** adds the `outbox` table, registered in `PROJECTION_TABLES`
and in `allProjectors()`. It is a projection like any other, so the
10 000-event rebuild-identity workload was extended to produce effects in
all five states — including one deliberately left open, because a rebuild
that lost an open intention would convert "we do not know whether this
was sent" into "nothing was ever attempted".

`registry.ts` crossed 400 lines under the new schemas. Rather than raise
the ceiling, the effect and egress payload shapes moved to
`events/effects.ts` and `events/egress-schema.ts`: a registry is a list
of bindings, and the shapes it binds can live next door.

## Consequences

* Non-idempotent effects can be attempted safely across a crash.
* There is now a queue only a human can drain (`needsAttention()`); the
  CLI and the web UI should surface it, which they do not yet.
* No connector currently implements a probe, so every real effect today
  would reconcile to `needs_attention`. That is the correct conservative
  default and the honest state of the build.
* 17 new tests; suite 725 across 53 files.
