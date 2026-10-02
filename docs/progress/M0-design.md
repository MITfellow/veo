# M0 — Substrate: design note and test list

Written before the code, per §36. Covers only M0 (arish.md §33).

## What M0 must deliver

> repo, strict TS, config, ports + fakes, SQLite + migrations, event log with
> hash chain, bitemporal schema, ULIDs, injected clock, redaction, upcasters,
> projections + `rebuild-identity`.
> *Done when:* 10k events, drop all projections, rebuild, byte-identical.

Nothing else. No model calls, no tools, no HTTP, no memory scoring. Those are
M1–M6 and building them early would couple them to a substrate that has not yet
been proven.

## Shape

```
src/substrate/
  ports.ts              every port interface in one file — the seam list
  clock.ts              SystemClock + FakeClock (advance by ms/days/months)
  ids.ts                monotonic ULID + seeded deterministic fake
  config.ts             one zod schema, parsed once, frozen
  log.ts                structured logger carrying correlationId
  hash.ts               canonical JSON + sha256 (Hashing port impl)
  events/
    types.ts            closed EventType union + per-type payload schemas
    envelope.ts         the Event record, canonicalisation, hashing rules
    redact.ts           secret registry + pattern rules, deep walk
    log.ts              EventLog: append (txn), read, verifyChain
    migrations/         upcasters: (type, fromVersion) -> payload transform
  storage/
    sqlite.ts           better-sqlite3 adapter for the Storage port
    memory.ts           (not built — sqlite in-memory IS the fake, see D-003)
    dialect.ts          the few SQL fragments that differ per engine
    migrate.ts          schema migrations runner
    schema/001-init.ts  tables: events, projections, bitemporal facts
  projections/
    registry.ts         projector interface + apply/rebuild orchestration
    sessions.ts runs.ts messages.ts facts.ts entities.ts artifacts.ts
    snapshot.ts         deterministic serialisation of all projection tables
```

## Decisions taken here (expanded in docs/decisions/)

- **D-001 Node 20, not 22.** The sandbox runs Node 20.20. Nothing in M0 needs a
  22-only API (`node:sqlite` is deliberately not used — we need FTS5 and
  better-sqlite3's synchronous transactions). Engines field says `>=20.11`.
  If the deployment target is 22+, nothing changes.
- **D-002 Storage port is a typed SQL executor, not a repository-per-entity.**
  A port that hides SQL entirely would be a second ORM; a port that leaks a
  `better-sqlite3` statement object would not be swappable. The middle: the port
  executes parameterised SQL and owns transactions, every SQL string lives in
  `storage/schema/` and the projection modules, and the handful of dialect-
  specific fragments live in `dialect.ts`. A Postgres adapter is then the
  adapter plus one dialect object.
- **D-003 The fake Storage is SQLite in-memory.** A hand-written in-memory fake
  would be a second implementation of SQL semantics and would drift. `:memory:`
  is deterministic, fast (10k events in well under a second) and exercises the
  real adapter, which is what the tests should be exercising.
- **D-004 Hashing uses `node:crypto.createHash`, not webcrypto.** §6 says
  webcrypto for *crypto*; the chain hash must be computed synchronously inside
  the same transaction as the append, and webcrypto's digest is async. Same
  primitive (SHA-256), different API shape. Encryption in M1 will use webcrypto
  as specified.
- **D-005 Bitemporal columns exist in M0, the memory *logic* does not.** The
  facts projection is driven by `memory.*` events and answers both timelines.
  Scoring, extraction and consolidation are M6. Building the schema now is
  required because retrofitting bitemporality is a rewrite (§11).

## Invariant → mechanism map

| Invariant (§35) | Mechanism in M0 |
|---|---|
| 1 log is the only truth | every projection derives from `apply(event)`; `rebuild-identity` test |
| 2 nothing mutates history | `events` table has no UPDATE/DELETE path; triggers block both |
| 4 assembly pure/logged | not M0 (M5), but `context.assembled` type reserved |
| 5 every fact has provenance | `facts.sources` is NOT NULL and non-empty, enforced by schema + check |
| 6 trust never increases | `TrustLevel` ordered enum + `minTrust()` used by the envelope |
| 7 secrets never outside vault | redaction runs inside `append()`, not at call sites |
| 9 kernel knows no tool names | nothing in `src/substrate` references a tool |

## Test list (written before the implementation)

**unit/ulid**
1. monotonic within the same millisecond
2. lexicographically sortable across milliseconds
3. 26 chars, Crockford alphabet, decodes to the right timestamp
4. seeded fake is reproducible across runs

**unit/clock**
5. FakeClock.advance moves `now`; `advanceDays`/`advanceMonths` land on the
   right wall-clock instants (DST-safe arithmetic is M8; here: UTC)

**unit/canonical-hash**
6. canonical JSON sorts keys at every depth and is stable for equal objects
7. key order in the input does not change the hash
8. `undefined` vs missing key hash identically; `null` differs
9. unicode and large ints survive a round trip

**unit/redaction**
10. a registered secret value is replaced everywhere it appears: top level,
    nested, inside an array, inside a string that *contains* it
11. patterns catch `sk-…`, `ghp_…`, `Bearer …`, private key blocks
12. redaction is applied by `append()` itself — a caller cannot skip it
13. the redacted placeholder names the label, never the value
14. a secret split across two fields is still caught per-field
15. fuzz: 500 random payloads with a planted secret → zero leaks

**unit/event-schemas**
16. every `EventType` has a payload schema (exhaustiveness test over the union)
17. appending a payload that fails its schema throws before any write
18. unknown event type is rejected at the type level and at runtime

**unit/upcasters**
19. a v1 fixture payload reads as v2 through the upcaster
20. upcasters compose across two versions (v1→v2→v3)
21. a payload at the current version is returned untouched (identity)
22. reading never writes: the stored row is still v1 afterwards

**integration/event-log**
23. append assigns seq monotonically with no gaps under 1k appends
24. append is transactional: a projector throwing rolls back the event too
25. hash chain links each event to its predecessor
26. `verifyChain` passes on a clean log
27. `verifyChain` detects a tampered payload, a tampered hash, and a deleted row
28. reads by seq range / session / run / type / correlation / trust
29. the `events` table rejects UPDATE and DELETE (trigger-enforced)

**integration/projections**
30. **rebuild-identity**: 10k events, snapshot, drop all projections, rebuild,
    byte-identical snapshot
31. rebuild is idempotent: rebuilding twice gives the same bytes
32. a projector added later can rebuild from historical events alone

**integration/bitemporal**
33. "where does he work now" → current valid-time row
34. "where did he work in March" → valid-time query returns the old row
35. "what did you believe in March" → transaction-time query returns what was
    recorded then, even though it was later superseded
36. superseding keeps both rows; neither is deleted
37. a fact recorded late about an earlier period (backdated `validFrom`) is
    ordered correctly in both timelines

**integration/performance**
38. 10k appends in < 5s and 100k-row projection queries < 100ms (budget §32)

Total: 38 tests. All offline, all deterministic, target < 10s for M0's share of
the 60s budget.
