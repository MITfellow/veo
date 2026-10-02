# 005 — Supersession closes valid time; only a correction closes transaction time

**Status:** accepted · **Date:** 2026-10-02 · **Found by:** a failing test

## Context

The first implementation of `memory.superseded` stamped both `valid_to` and
`superseded_at`. The bitemporal test immediately failed: "where did Maya work
in March?" returned nothing.

## The distinction

Two different things can happen to a belief, and they belong on different axes.

| What happened | Example | valid_to | superseded_at |
|---|---|---|---|
| **The world changed** | Maya moved to Globex in April | April | stays NULL |
| **We were wrong** | We misheard; she never worked at Acme | unchanged | now |

Stamping `superseded_at` on a world-change retracts a record that is still
true. The Acme row is a correct statement about Feb 2024 – Apr 2026; it does
not stop being correct when April arrives. Only the *period* ends.

Conversely, a correction must not touch `valid_to`: we are not saying the
employment ended, we are saying we never should have recorded it.

## Decision

- `memory.superseded` → sets `valid_to` and `superseded_by`. Transaction time
  is untouched.
- `memory.corrected` → sets `superseded_at` and `status='retired'`. Valid time
  is untouched.

## Why this matters beyond the schema

This is what separates "I was out of date" from "I was wrong", and the agent is
required to be able to tell a user which one happened (§24, §28). Conflating
them makes every stale answer indistinguishable from a mistake, which either
destroys trust or hides real errors. It is also why the test for this is three
queries with three different expected answers rather than one.
