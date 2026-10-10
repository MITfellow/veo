# 019 — Fifteen cognitive jobs, the human queue, and a frame budget

Status: accepted · Amends 003's sibling rule on `JOB_NAMES`

## Context

Three gaps were closable without inventing anything the replaced
specification does not say. §16.1 names fifteen cognitive jobs and eleven
existed. §13's outbox was built last turn but nothing showed it to a
person. The mesh capped frame *size* from the start and never capped the
*rate*.

## Decision — the list grows to fifteen

`JOB_NAMES` was closed at eleven and is now closed at fifteen. Closed
never meant frozen; it meant a new entry is a decision, and this is it.

| job | what the baseline does | trust |
|---|---|---|
| `page.extract` | strips markup, keeps the highest-scoring sentences in document order | **FOREIGN** |
| `intent.parse` | ordered keyword/shape rules, verbatim entity spans, `unknown` when unsure | DERIVED |
| `priority.score` | transparent weighted sum, every contribution named in `reasons` | DERIVED |
| `thread.summarize` | extractive but weighted towards the end of the thread | DERIVED |

Two of these carry an argument worth stating plainly.

**`page.extract` is the second job ever to output FOREIGN.** The previous
test asserted `quarantine.extract` was the only one, and that assertion
had to change rather than be worked around. Extraction does not launder a
web page: shortening something a stranger wrote leaves it something a
stranger wrote, and a DERIVED output here would let page text reach a
planner as though the agent had reasoned it out.

**`thread.summarize` is not `text.summarize` with a loop.** A conversation
has a property a passage does not — the last word is disproportionately
the point. Ranking a thread by term frequency alone surfaces whatever was
discussed longest, which is usually the part that got resolved and
dropped. So the baseline applies a recency prior and reports unanswered
questions separately.

Across all four, the baselines prefer admitting ignorance to guessing.
`intent.parse` returns `unknown` with low confidence on anything indirect,
and §15's ladder reads that confidence: an unknown intent cannot clear the
floor for an effect, so a misread sentence stalls instead of acting.

## Decision — the outbox gets a face

`arish effects list|pending|attention|reconcile`, a read-only
`GET /api/effects`, a `/effects.html` page, and two numbers in
`arish status`.

**There is no `retry`, in any of them.** Not a CLI verb, not a button.
Retrying is only ever safe from `absent` — a provider confirming it never
happened — and that is a decision for the code that owns the tool, not for
a person clicking on a page they left open yesterday. The CLI help says so
in as many words, and a test asserts the subcommand does not exist.

Reconciling is deliberately terminal-only for the same reason: it is the
one operation here with consequences in the outside world.

The probe table is **empty and honestly so**. No connector implements a
probe, so every pending effect reconciles to `needs_attention`. That is
the correct conservative answer rather than a gap being papered over.

## Decision — a per-peer frame budget

A token bucket per peer: 40 frames of burst, refilling at 120/minute from
the injected clock rather than a timer, so it is tested by advancing time
and holds nothing that would keep a process alive.

**It is charged on the frame's claimed sender, before the seal is
opened.** This is a real trade-off and worth recording as one: metering
only what authenticates leaves the expensive path — an AEAD open per
frame — unmetered, which is the whole thing being defended. The cost is
that someone who can write to the socket can spend a legitimate peer's
budget and lock it out. A device that can inject frames can already deny
service by saturating the socket, so this buys a cheaper refusal at the
price of a weaker guarantee, rather than giving anything away.

Over-budget frames are **dropped, not answered**: replying is itself work,
and an attacker would happily take a refusal as a service.

## Consequences

* `registry.ts` and `types.ts` now describe fifteen jobs; `doctor` checks
  the count against `JOB_NAMES.length` rather than a literal, so the next
  addition cannot forget it.
* `cli.ts` was at 398 of 400 lines, so the help text moved to
  `interface/help.ts` — it is the one part of the CLI that grows every
  milestone and contains no logic.
* Suite 765 across 55 files.

## What this does not do

Nothing here touches §17 (Context Assembler), §18 (the four memory
stores), §19 (the run loop and its sixteen named failure modes) or §20
(the degradation ladder, queue and scheduler). Those are specified in the
part of the document that **was not received** — the paste ends at §20
and Appendices A–H are missing. Building them would mean inventing the
spec, which is the one thing worse than leaving them unbuilt.
