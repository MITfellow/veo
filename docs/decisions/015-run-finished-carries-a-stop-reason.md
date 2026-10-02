# 015 — `run.finished` carries an explicit stop reason

**Status:** accepted · **Milestone:** M2

## Context

§26 lists the run loop's stop conditions. The `run.finished` schema written at
M0 recorded `steps`, `tokens` and `costCents` but not *why* the loop ended. A
run that stopped at the step cap and a run that stopped because the model was
finished are very different events, and from the log they looked identical.

Invariant 15 — no unexplained output — applies to the system's own records,
not only to what it says to the user.

## Decision

Add `reason` to `run.finished`, a closed enum: `stop`, `step-cap`,
`token-cap`, `time-cap`, `cost-cap`, `tools-unavailable`, `loop-detected`.

It is declared with `.default('stop')` rather than as a bare required field,
so payloads written before the field existed still validate on replay. §9's
event schemas are append-compatible by construction; this is the first use of
that property and it is worth noting that it worked.

## Consequences

- "Why did it stop?" is answerable from one field, forever.
- The enum is closed, so a new stop condition cannot be added without
  appearing here and in the places that render it.
- `tools-unavailable` is honest scaffolding: M2 parses tool calls but cannot
  execute them, so it says exactly that instead of pretending the run
  completed. M3 removes it from the reachable set.
