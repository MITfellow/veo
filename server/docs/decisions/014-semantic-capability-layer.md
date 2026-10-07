# 014 — The model asks for an objective, not a tool

Status: accepted
Date: 2026-10-07
Supersedes: nothing. Narrows 012 (the gate chain) at its input end.

## The decision

Three files, `src/capability/semantics/{ontology,manifest,broker}.ts`:

1. **Ontology** — nine *objectives* (`SEND_EXTERNAL_MESSAGE`,
   `READ_CURRENT_STATE`, `RECALL_KNOWLEDGE`, …), grouped into families.
   An objective is a thing the user wants to be true, with no connector
   in it.
2. **Manifest** — what each of seven connectors claims it can do, which
   provider scopes that costs, how the result can be verified, and
   explicitly **what it cannot do**.
3. **Broker** — given an objective and the live context, returns a
   **route** (connector + operation + account + why), or a **refusal**
   with a remedy.

## Why objectives rather than tools

A tool list makes the caller the integrator. It has to know that mail is
`gmail` and that the calendar is `gcal` unless Google is down, in which
case it is the `.ics` file — and that knowledge gets baked into whatever
is doing the asking, where it cannot be tested and cannot be changed
when a connector is added.

An objective moves that knowledge into one place that *can* be tested.
`test/integration/broker.test.ts` asserts the fallback from `gcal` to
`calendar-local` in three lines; with a tool list there would be nothing
to assert, because the fallback would live in a prompt.

It also makes refusal possible. `gmail.send` failing is an error;
"I can't send from your work account — it needs signing in again, and
nothing else here can send mail" is an answer. The second is only
available to something that knew what was being attempted.

## The field that does the work: `whenNotToUse`

Every capability sounds applicable when described on its own. A
description of `SEARCH_PERSONAL` reads like the answer to any question.
So every objective carries negative knowledge, and a test enforces that
it is non-empty — this is §22, and it is the highest-leverage field in
the ontology.

`SEND_EXTERNAL_MESSAGE.rollback` is the same idea pointed at honesty:

> none. A follow-up message is not a rollback.

## The manifest is the only source of model-facing prose

`describeForModel(manifest, health)` generates the text a planner sees.
There is no second description anywhere — Rule of Two (§19) applied to
documentation. A connector's capabilities and the sentence describing
them cannot disagree, because the sentence is computed from them. When a
connector is `AUTH_REQUIRED` the generated text says *do not plan work
that needs it*, rather than listing it as though it worked.

## A route is a value, not a call

`route()` returns a plan for how to act and performs nothing. That buys:

- "Why this connector?" (§158) is answerable, because the answer existed
  before the call did, and is stored with it.
- A route can be shown to a human for approval, which is M3's gate chain.
- Routing is testable with no connector implemented — which is the
  situation this build is actually in.

**Nothing is ranked before it is eligible.** Enabled, healthy, in scope,
identified — then score. A score can never promote what policy excluded,
and history (§150) can only reorder candidates that already passed.

Score: `0.5·verification + 0.35·past success + 0.15·speed`. Latency is
weighted least on purpose: a slow correct answer beats a fast
unverifiable one. `calendar-local` is `MODERATE`, not `STRONG`, because
an exported file is stale the moment it is written.

## The harness picks the account (§6)

An identity is never chosen by the caller. When two accounts both fit,
the broker refuses with *two accounts could do this; ask which* rather
than taking the first. A coin flip here means mail sent from the wrong
address, and there is no rollback.

One correction found by the tests: a connector that declares **no**
identity providers authenticates nothing, so it must route with a null
identity even for an objective marked `identity.needed: 'any'`. The
first implementation demanded an account from every candidate, which
made the offline calendar unreachable at exactly the moment the online
one was down — the fallback was unusable precisely when it mattered.

## Not done

- No connector behind any manifest is implemented. Seven manifests
  describe seven things that do not yet dial out; the ontology and the
  broker are honest about this only because `health` comes from outside.
- No OAuth, so every non-local manifest is `AUTH_REQUIRED` in practice.
- Score weights are guesses (`docs/progress/CURRENT.md`, unsure list).
- `successRate` has no writer yet; the executor should feed it.
