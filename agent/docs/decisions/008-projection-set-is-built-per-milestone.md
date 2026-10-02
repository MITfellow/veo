# 008 — The §10 projection list is built per milestone, not all at M0

**Status:** accepted · **Date:** 2026-10-02

## Context

§10 lists twelve projections: `sessions`, `runs`, `messages`, `facts`,
`entities`, `rules`, `episodes`, `approvals`, `queue`, `schedules`, `outbox`,
`artifacts`. M0's scope (§33) is "projections + `rebuild-identity`".

## Decision

M0 builds the six that have events to project today — `sessions`, `messages`,
`runs`, `entities`, `artifacts`, `facts`. The other six arrive with the
milestone that introduces their events:

| Projection | Milestone | Blocked on |
|---|---|---|
| `approvals` | M4 | `approval.*` flow and scopes |
| `outbox` | M3 | `effect.intended/committed` |
| `queue`, `schedules` | M8 | the queue and scheduler |
| `episodes` | M6 | completed runs with outcome signals |
| `rules` | M6 | procedural memory |

## Why not stub them now

An empty table whose projector has no events to consume is untested surface
area: `rebuild-identity` would pass over it trivially, and the shape would be
guessed before the events that fill it exist. The spec's own ordering (§33)
puts them in later milestones; building the table early only makes it likelier
to be the wrong table.

## The guarantee that must not slip

Each one is added **with its events and with its coverage in
`rebuild-identity`** in the same milestone. The test's fixture
(`test/fixtures/world.ts`) grows to emit the new event types at the same time,
so the byte-identical proof always covers every projection that exists.
