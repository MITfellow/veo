# 003 — The event type union is closed in M0; payload schemas arrive with their milestone

**Status:** accepted
**Date:** 2026-10-03

## Context

§15 requires that every event validate against a schema at append time, and
that the set of event types be closed. The specification lists roughly sixty
types across twenty families, nearly all of which belong to subsystems that
M0 is forbidden to scaffold (§61: "a subsystem is finished or not started").

Writing all sixty payload schemas now would be writing M5's and M8's data
model during M0, with no tests to constrain it and no implementation to
correct it.

## Decision

Two separate things, with different lifetimes:

* **The type union is complete and closed in M0.** All sixty-odd names are
  declared now, as a `const` tuple that the `EventType` type derives from.
  A later milestone cannot invent a type without editing this one list.
* **The payload registry starts nearly empty.** It maps type → zod schema and
  covers only the families M0 emits. `append()` throws a typed
  `unregistered_event_type` error for any type with no schema.

## Consequences

* A milestone that emits a new event family fails on its first append until
  it registers a schema. The failure is immediate, loud, and at the right
  place — rather than a payload silently stored unvalidated and discovered
  to be malformed three milestones later.
* The closed union gives the exhaustiveness checking that makes a missing
  projector case a compile error.
* The cost is that `EventType` names types that cannot yet be appended. This
  is the intended asymmetry: naming is cheap and the names are design, while
  schemas are implementation and belong with their implementation.
