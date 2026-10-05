# 008 — The onboarding interface is pulled forward, deliberately

**Status:** accepted
**Breaks:** strict M0→M10 ordering, and §61 "a subsystem is finished or not started"

## Context

The user asked for a Get Started surface — about the platform, a connector
catalogue you can add to, and a place to attach an LLM with "the model
workflow through everything" — with a Windows 11 Get Started page as the
visual reference.

That is L6 interface work (M7/M8) plus most of M4's Cognitive Jobs, arriving
immediately after M1. The spec is explicit that milestones run in order and
that later milestones are not scaffolded. So this is a real deviation and it
gets recorded rather than quietly absorbed.

## Decision

Build it, now, in **`server/web/`** served by a new `node:http` adapter at
`src/interface/http.ts`. Specifically:

1. **Nothing in Veo is touched.** §49's eleven-file budget is untouched and
   still has eleven files in it. This is a separate surface on a separate
   port, and the §49 collision flagged in decision 001 is still outstanding
   and still needs the user before M7.
2. **No new dependencies.** `node:http`, the existing `zod`, and hand-written
   HTML/CSS/JS with no framework and no build step. The two-dependency rule
   survives intact.
3. **M2 is paused, not cancelled.** `CURRENT.md` says so plainly, and the
   next concrete action after this is still M2's test list.
4. **The Cognitive Job layer is built properly rather than stubbed.** This is
   the part that justifies the deviation: "I will add the model later" is
   only true if the seam exists before the model does. Building the seam
   after a model is attached means retrofitting, and §59.17 would already be
   false by then.

## What "config-only" has to mean (§59.17)

Attaching a model later must touch configuration and nothing else. That
constrains the design more than it first appears:

- Every model-shaped function is a **job**, not a call site. There is no
  `if (model) … else …` anywhere outside the job runner. Eleven jobs, one
  runner, one decision point.
- Each job carries **two strategies**. The baseline is deterministic and
  ships working today. The model strategy is **fully written** — it builds a
  request and parses a response, both pure functions, both contract-tested
  against the same output schema as the baseline — and is **inert** only
  because no provider exists to carry the request.
- The runner picks a strategy from config. With no model configured it
  selects the baseline; it does not fall back, because a fallback implies an
  attempt, and there is nothing to attempt.
- **A baseline is not a placeholder.** Every one of the eleven does real
  work. `text.summarize` is extractive, `entity.resolve` does normalized
  token matching, `rule.induce` counts frequencies. The platform is useful
  at L1 and gets better at L2, which is the degradation ladder working as
  specified rather than an excuse.

The test that keeps this honest is `test/unit/jobs.test.ts`: it asserts that
for every job, baseline and model strategy declare the *same* output schema,
and that the only thing standing between the model strategy and a running
model is a provider.

## Consequences

- `doctor` keeps saying `model: none configured — L1, the intended state`,
  and now has something concrete to point at: eleven jobs, all served by
  baselines, all listed at `/api/jobs`.
- The connector catalogue is **honest about what works**. Local connectors
  are marked available; SaaS connectors are shown but locked, because OAuth
  and a network port do not exist and pretending otherwise would be the
  exact dishonesty §61 is about. Adding a locked connector records the
  intent and explains what is missing.
- A `FileStore` port finally exists (`src/substrate/files.ts`), which M0 had
  deferred. The static server needs to read files, and `node:fs` outside a
  port is banned, so the ban forced the right design.
- M2 inherits a real `memory.extract` and `memory.consolidate` baseline, so
  its surface is smaller than it would have been.
