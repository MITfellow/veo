# 037 — Metrics are computed from the log, not counted in the hot path

**Status:** accepted · **Milestone:** M9 · **Spec:** §8, §30, §32

## The ambiguity

§30 asks for "latency per stage, tokens, cost, tool success rate, memory
hit rate, context utilization, agreement rate, calibration error,
approval frequency". The ordinary way to produce those is a counter
object incremented at each call site. The ordinary way is wrong here.

## The decision

`GET /metrics` reads the event log and derives everything on the way out.
No counters, no in-memory aggregates, no metrics table.

Three reasons, in order of weight:

1. **The numbers survive a restart.** A counter resets; a log does not.
2. **A metric and a trace can never disagree.** They are the same data
   read two ways, so "the dashboard says 40 tool calls but the trace
   shows 38" is not a state this system can reach.
3. **Invariant 1.** Everything other than the log is a rebuildable
   projection, and a counter that cannot be rebuilt is a second source of
   truth with worse durability than the first.

The cost is that the report is a query rather than a lookup. Measured at
150k events it is ~200ms, which is fine for a page a person opens, and
the route takes a `days` window that defaults to 30 rather than all of
history.

Two stage timings have no natural event, so M9 adds one:
`perf.sampled { stage, ms }`, written by the runner around context
assembly. A timing is state — it is how the system behaved at an instant
— and the honest place for it is the same log as everything else.

## Found by doing it

The first 100k-event pass took **1.6 seconds**, because `read()`
materialises every row and `message.*` events are the bulk of a real log
while being used by no metric at all. Naming the twenty-four types the
report actually reads cut it to ~200ms, and the list doubles as
documentation of the report's input.

## Two definitions worth stating

- **Tool success rate** excludes denials from the denominator. A refused
  call is the capability layer working; counting it as a failure would
  make a well-defended agent look broken and would punish adding checks.
- **Memory hit rate** is `memory.used ÷ memory.offered`, both reported.
  Counting only recalls is how a retrieval system convinces itself it is
  working.
