# 028 — Unmerge is a merge into yourself

**Status:** accepted · **Milestone:** M6 · **Spec:** §9 (closed event set), §22.2

## The ambiguity

§22.2 requires entity merges to be **explicit and reversible**: "two Priyas
are two entities until someone says otherwise, and a wrong merge must be
undoable." The event set has `entity.merged` and nothing for the reverse.

Decision 027 had already added eight memory events, and adding a ninth for
this would have been the third time in one milestone that a set §9 calls
closed was widened. At some point the honest thing is to ask whether the
existing payload can say it.

## The decision

`entity.merged` with `from === into` means **unmerge**.

An entity merged into itself cannot coherently mean anything else, so the
sentinel is not ambiguous — it is a degenerate case with exactly one sensible
reading. The projector maps it to `merged_into = NULL`, and the event's
`reason` string records which direction it was in words a person can read
("unmerged: the user said they are two different Priyas").

## Why not the alternatives

**A ninth event (`entity.unmerged`).** Cleanest to read, and I nearly did it.
Rejected because the cost is not the enum entry — it is that every event
added to a "closed" set makes the next addition easier to justify, and this
one buys nothing the existing payload cannot express.

**A nullable `into`.** Would require an upcaster for an event type that has
existed since M1, to encode the same information the sentinel already
encodes.

## What this costs

A reader of the projector has to know the convention. That is a real cost and
it is paid once, in a comment at the only place it matters. The alternative —
a schema change rippling through an upcaster — is paid by everyone who reads
the event type afterwards.

## What would change my mind

If unmerge ever needs to carry information a merge does not (which entity
keeps which aliases, say), the sentinel stops being expressive enough and
this becomes a real event with a real payload.
