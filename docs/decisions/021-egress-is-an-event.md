# 021 — Outbound requests are events, not a counter

**Status:** accepted · **Milestone:** M4

## The problem

§19 requires a **daily** egress-bytes budget. M3 bounded egress per run with
an in-memory counter on the scoped Net, which dies with the process and is
invisible to anything else. There was no durable record of a single byte the
agent sent anywhere.

§9's event type list is closed, and says: "add deliberately, never ad hoc".

## The decision

Added one type, `egress.allowed`, carrying `{tool, host, method, bytes,
requestBytes, status}`.

## Why an event and not a counter column

Invariant 1: the event log is the only source of truth, and everything else
is a projection that can be thrown away and rebuilt. A counter column cannot
be rebuilt — it is the *only* copy of its own history, it drifts the first
time the process dies between the send and the increment, and once drifted
there is no way to detect it. The daily ledger therefore sums events, which
is slower and cannot be wrong.

## Why it earns a place in a closed list

Two things were unanswerable without it:

1. **"How much has this agent sent today?"** — §19's budget.
2. **"What did my agent talk to?"** — §14's audit question. Denials were
   already logged as `policy.denied`; the allowed requests, which are the
   ones that actually moved data, left no trace at all. An audit log that
   records only refusals describes the attacks that failed.

It is logged **per redirect hop**, because a chain that moves bytes moved
them, and a record showing only the final URL hides where the data went.

Also added, same milestone, same reasoning: five stop reasons
(`egress-cap`, `tool-cap`, `daily-cap`, `denied`, `approval-expired`).
`STOP_REASONS` is a closed enum with a default (decision 015), so adding
members is additive and old payloads still parse.
