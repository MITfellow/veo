# 003 — The fake Storage is SQLite in-memory

**Status:** accepted · **Date:** 2026-10-02

## Context

§8 wants fakes for every port. For storage, a literal in-memory fake would mean
reimplementing enough SQL semantics to satisfy the projections.

## Decision

`:memory:` SQLite *is* the test double.

## Why

- A hand-written fake would be a second implementation of SQL, and would drift
  from the real one. Tests would pass against a thing nobody ships.
- It is already deterministic and fast: 10k events with full projections in
  ~2s, the whole suite in ~14s against a 60s budget.
- Constraints, triggers and FTS5 behave identically, so tests actually exercise
  the invariants the schema enforces.

## Consequences

Every test touches a real database. Accepted — the cost is milliseconds, and in
exchange the `rebuild-identity` test is a statement about the production
storage engine rather than about a mock.
