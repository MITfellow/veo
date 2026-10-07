# The Personal World Model (Phase 1–2)

**Status:** built and tested. `src/capability/world/{contracts,claims,graph}.ts`,
25 tests in `test/integration/world.test.ts`, full suite 560 green.

---

## The decision that shaped everything else

**A relation is a bitemporal fact, not a new table.**

The repository already had a store of statements about things with valid
time, transaction time, supersession, retraction, confidence, trust scaling
and a byte-identical rebuild guarantee. A relation is a statement about two
things. Building a `relations` table beside it would have created:

- a second place to forget supersession,
- a second thing to keep replayable,
- and two possible answers to "what do we believe about X".

So a relation is a fact whose predicate lives in a reserved namespace
(`rel:WORKS_ON`) and whose object is an entity id. It inherits everything.
`WorldGraph.count().edges` is a `WHERE predicate LIKE 'rel:%'` over a table
that already existed, and the world model survived the projection rebuild
test on the day it was written, without a line of new projection code.

**No migration was required.** Scope, basis and source are encoded into the
existing `basis` column by `encodeBasis`/`decodeBasis` in `claims.ts` — the
only two functions that know the encoding. A fact written before this phase
decodes as `OBSERVATION / UNKNOWN`, which is true of it.

## The three things the fact table could not express

| Added | Why it could not be inferred |
|---|---|
| **kind** | `person`, `project`, `meeting`, `commitment`… The entity registry knew five kinds; the world needs twenty-six. Unknown kinds are stored as `thing` there and carry their real kind as a claim, so nothing lies to the old column. |
| **scope** | `PERSONAL / WORK / COMPANY / PROJECT / TEAM / SHARED / PUBLIC / UNKNOWN`, enforced at retrieval. |
| **basis** | `INFERENCE < OBSERVATION < USER_ASSERTION < VERIFIED`. The field that decides which claim wins. |

## The rule that makes this a world model and not a diary

```
winner(a, b): basis first, then valid time.
```

**Basis first is the entire point.** The brief's §140 — memory says the
meeting is Friday, the calendar says Monday — is not solved by recency,
because "the user said Friday on Monday" is *more recent* than a calendar
read on Sunday. The two claims are different kinds of knowing. A verified
reading of the world beats a remembered sentence, and an explicit user
statement beats an inference drawn from behaviour (§14).

`current()` returns the winner **with the losers named**:

> `'Monday' (verified, work), over 1 other ('Friday' (user assertion, work))`

An assistant that resolves a contradiction without mentioning it is the same
assistant that will one day resolve it the other way.

## Trust cannot be bought by writing confidently

`BASIS_TRUST_CEILING` is applied with `meetTrust`, so:

- an **inference** holds `DERIVED` at most, even if the caller asked for `USER`;
- an **observation** holds `TOOL` at most;
- an observation **of a web page** stays `FOREIGN`.

Tested directly: `relate({basis: 'INFERENCE', trust: 'USER'})` produces an
edge at `DERIVED`.

## UNKNOWN is a value, not a null

`scopePermits('WORK', 'UNKNOWN') === false`. An unclassified thing is not
visible to every question — it is a prompt to resolve. A wildcard here is
exactly how a personal file reaches a work thread.

## What this cost, and what it found

**A real bug, found by the §141 forget test.** A node's `kind` and `scope`
claims were written at `SYSTEM` trust. Trust is monotonically non-increasing,
so a `USER`-trust retraction could not touch them — meaning *the only person
entitled to say "forget this person" was the one person who could not*. The
world's bookkeeping about a node now belongs to the user whose world it is.

That is the kind of defect this architecture is supposed to surface, and it
surfaced because the trust lattice was already real rather than advisory.

## What is deliberately absent

- **No node is created by inference.** Nothing auto-creates a person from a
  name in a sentence. §27: never merge uncertain identities silently.
- **No path longer than three hops** is reported as a connection. Six hops
  apart in a personal graph is a coincidence, and presenting it as context is
  how an assistant confidently involves the wrong person.
- **No scope guessing.** A scope resolution engine (§7, Phase 4) is the next
  phase; until it exists, unclassified is `UNKNOWN` and says so.
- **No populated world.** This is the shape; there is no connector to fill
  it. See the forensic document — that is the open decision.
