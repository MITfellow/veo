# 006 — ULID is implemented in-tree rather than taken as a dependency

**Status:** accepted · **Date:** 2026-10-02

## Context

§8 forbids `Date.now()` and `Math.random()` in kernel code; ids must come from
an injected port so a seeded run is reproducible. Every published ULID package
calls both globals internally.

## Decision

~60 lines in `src/substrate/ids.ts`, taking a `Clock` and a `RandomSource`.

## Why

- Determinism is not optional here: `rebuild-identity` and the golden context
  tests compare bytes, and bytes include ids.
- The wrapping we would need (monkey-patching the package's time source) is
  larger and more fragile than the implementation.
- It let us add a property the libraries do not have: if the clock steps
  *backwards*, we keep the previous timestamp and increment the random part, so
  an id can never sort before one already issued. An NTP correction would
  otherwise silently break log ordering.

## Cost

We own the Crockford base32 encoder. It is covered by six tests including a
timestamp round-trip and a monotonicity check over 1000 ids in one millisecond.
