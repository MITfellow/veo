# 002 — The Storage port is a typed SQL executor, not a repository layer

**Status:** accepted · **Date:** 2026-10-02

## Context

§6 requires SQLite behind a `Storage` port so the engine can be swapped. There
are three ways to draw that line.

1. **Repository per entity** (`saveSession`, `findFactsBySubject`, …). Hides SQL
   completely, but becomes a hand-rolled ORM: every new query is a new port
   method, and the port grows a method per question anyone ever asks.
2. **Leak the driver.** Swappability is a fiction the moment a caller touches a
   `better-sqlite3` `Statement`.
3. **Typed SQL executor.** The port owns execution, binding and transactions;
   SQL text lives with the module that owns the table.

## Decision

Option 3. `Storage` exposes `exec/all/get/run/transaction/inTransaction/close`.
Dialect differences live in one `dialect.ts`.

## Consequences

- A Postgres adapter is one file plus a dialect object, not a rewrite.
- SQL is visible next to the schema it queries, which is where you want it when
  a query is wrong.
- The port cannot stop a caller writing engine-specific SQL. Mitigation: the
  only SQL in the codebase lives in `storage/schema/` and the projections, both
  small enough to audit, and the dialect-sensitive fragments are named.
