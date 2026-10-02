# 007 — Two event types added to §9's closed set: `entity.upserted` / `entity.merged`

**Status:** accepted · **Date:** 2026-10-02 · **Kind:** addition to the spec

Per §36 I am flagging this rather than deviating quietly.

## Context

§9 lists the closed set of event types. It does not include anything under
`entity.*`. But two other parts of the spec require entities to exist as
durable, rebuildable state:

- §10 names `entities` as one of the projections that must implement
  `rebuild()`;
- §22.2 requires a typed entity graph and says entity resolution — merging
  "Priya", "my sister", "P." — must be **explicit, reversible, and logged**.

A projection can only be rebuilt from events. With no `entity.*` event, the
entity graph would have to be derived as a side effect of `memory.written`,
which breaks all three of §22.2's requirements at once: the merge would be
implicit, irreversible, and unlogged.

## Decision

Add exactly two types:

```
entity.upserted   { entityId, kind, name, aliases }
entity.merged     { from, into, reason }
```

`entity.merged` is what makes resolution reversible: the merge is a row in the
log, so undoing it is another event rather than an archaeology exercise.

## Alternatives rejected

- **Derive entities from `memory.written` subjects.** Cheapest, and wrong:
  §22.2's "explicit, reversible, logged" is three separate failures.
- **Reuse `memory.written` with a special predicate.** Overloads one event type
  with two meanings, and makes the facts projection responsible for the entity
  graph. §9 says add types deliberately — that is what this is.

## Consequences

The closed set is now 51 types. Nothing else changes: both are ordinary events,
schema-validated, hash-chained, and covered by `rebuild-identity`, which
exercises them (the 10k-event fixture creates and merges entities).

If the intent was for entity state to live outside the log entirely, this
decision is wrong and the `entities` projection in §10 should be struck —
but then §22.2's "logged" cannot be satisfied, so I do not think it was.
