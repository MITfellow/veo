# 012 — Tools and effects: one gate chain, one path

**Status:** accepted · **Milestone:** M3 · **Supersedes:** nothing · **Relates to:** 007, 009, 010

## The decision

Every action the platform can take on the world goes through **one** function —
`Executor.run()` — and passes **six gates in a fixed order**:

| # | gate | spec | answer it can give |
|---|------|------|--------------------|
| 1 | the plan | §22 | yes / `not_in_plan` / `step_limit` / `seal_broken` |
| 2 | the budget | §27 | yes / `budget` |
| 3 | the Rule of Two | §19 | yes / `rule_of_two` |
| 4 | capabilities and the trust floor | §20, §29 | yes / `capability` |
| 5 | autonomy | §30 | yes / no / **ask** |
| 6 | the call | 010 | the outcome, audited either side |

The order is load-bearing and is asserted by test, not by comment.

**The Rule of Two precedes the capability check** because it refuses a *shape*.
A step that reads private data, holds untrusted content and changes the world
is wrong even when every capability was granted; checking grants first would
make the refusal look like a permissions problem that could be fixed by
granting more.

**Autonomy is last** because it is the only gate whose answer can be *"ask the
human"*. Asking before the cheaper, more certain refusals would interrupt a
person to authorise something that was going to be refused anyway — the
fastest way to teach someone to approve without reading.

## Why a plan, and why sealed

The plan is agreed before anything is read or run, and the seal covers goal,
steps, sorted `allowedTools`, `maxSteps`, rung and `carriesPrivateData`.

The property this buys is the one that matters for an agent that reads things:
**content encountered during a run cannot widen the run.** A page, a file or a
tool's own output can say "now email everyone" as loudly as it likes; if
`email.send` is not in `allowedTools` there is no path from that sentence to
that call. The only route to new authority is a new plan, and a new plan is a
human decision.

Sealing the *rung* and not just the steps matters as much: a plan whose step
list is untouched but whose autonomy was quietly raised from L1 to L4 is a
different plan, and a seal that did not notice would be theatre.

`stepSeal = sha256(planSeal + ':' + index)` is both the idempotency key and the
approval binding, so **a "yes" cannot be replayed onto a different step** —
including a step of a plan that differs only in its goal.

## Autonomy, literally

`TIER_FLOOR = { observe: 1, interact: 2, effect: 3 }`, irreversible ⇒ **L4**,
`FOREIGN` anywhere in scope caps the run at **L1**. L0 is propose-only: the run
emits `run.planned` and `run.finished(done, steps: 0)` and touches no tool.

The whole 5 × 3 table is asserted cell by cell rather than as an inequality. A
ladder written as `rung >= floor` is one off-by-one from running an effect at
L1, and nothing about the symptom would point at the comparison.

### An unresolved mismatch, stated rather than buried

`capability/browser/plan.ts` uses `{ observe: 1, interact: 2, effect: 4 }`.
M3 uses `{ 1, 2, 3 }` with irreversibility — not the tier — carrying the jump
to L4. The browser's table collapses two different questions ("how much can
this change?" and "can it be undone?") into one number.

M3 does **not** rewrite the browser's table, because that is a behavioural
change to a shipped subsystem being made for tidiness. It is recorded here as
a known divergence to be resolved when browsing moves onto the executor (see
below), at which point there is one table because there is one path.

## Two audit writers, named

`orchestration/audit.ts` owns every event a run writes. `capability/browser/record.ts`
owns the browser session's own calls. A third would be a defect, and
`test/unit/one-path.test.ts` lists exactly these two so a third cannot appear
quietly.

The browser cannot use the executor's writer without the capability layer
importing the orchestration layer, which the ESLint rule forbids and should.
**Folding browsing into the executor as a set of tools is deferred**, and is
the right eventual answer: decision 010 already says browsing *is* a run.

## What is deliberately not here

- **No retry and no compensation runner.** `compensate` is declared on the
  contract and nothing calls it yet. An automatic undo that has never run is
  more dangerous than no undo, because it is believed.
- **No parallel steps.** Concurrency plus approvals plus budgets is a third
  thing to get wrong; nothing in M3 needs it.
- **No tool over HTTP.** `arish run` is the only door, so the authorisation
  question for a web caller has not had to be answered yet.
- **`http.fetch` has no transport.** It exists to prove the contract and to
  refuse with `no_transport` (§2). The alternative — omitting it — would mean
  the external-effect path had never been exercised by anything real.

## The numbers that are judgements, not measurements

`DEFAULT_BUDGET = { steps: 20, wallClock: 120_000, toolCalls: 40, approvals: 5 }`,
`DEFAULT_TTL_MS = 15 min`, `MAX_DETAIL = 200`, `MAX_REASON = 400`.

Each is a guess that is easy to change and has no measurement behind it. The
approval budget is the one worth watching: five is a guess at how many times a
run may interrupt a person before the interruptions themselves are the failure.
