# S5 + S6 — the `revise` remedy is executed, and the agent can be named

Two slices, shipped together because a transcript you sent showed they were
the same defect seen from two angles: the agent said things about itself
that were not true, and nothing in the system stopped it.

## Where this came from

S5 was already chosen as the last carried weak point where **the system
says something untrue about itself**: §25's `revise` remedy was recorded as
applied and the violating draft was sent unchanged.

S6 came from your transcript. The relevant turn:

> **user:** use name jacky
> **agent:** I don't have the ability to set or change my own name… I can
> remember that you'd like to call me Jacky, but I cannot adopt that name
> for myself.

That sentence contains an unbacked action claim ("I can remember that") —
which F2 forbids, and F2's remedy is `revise`, which until S5 did nothing.
So the transcript is a live demonstration of the S5 bug, and the thing it
was lying about is the S6 feature.

## Built — S5

**The gate withholds.** `GovernedProvider` no longer records `revise` and
then yields the buffer. On a `revise` verdict it suppresses the draft and
finishes with a new reason, `revision-required`, handing the caller the
instruction it should use. The existing revision prompt already told the
model "the user never saw it" — that is now true.

**The runner pays.** Exactly one rewrite per run. The instruction is
injected as a SYSTEM message and the retry spends the same step, token and
wall-clock budget as any other step — which is why it lives in the runner
and not in the gate, where a provider re-entering itself would escape all
three, plus the cancellation signal. `step.finished` gained the outcome
`revision`, so the cost is visible in the log.

**A failed rewrite is disclosed.** The second violation is not suppressed
and not escalated into a refusal: the text is sent with an annotation
naming the article, and logged as `remedy: 'revise-failed'`. The reasoning
is in decision 042 — the article's author chose `revise` over `block`, and
turning a failed rewrite into a refusal substitutes my severity for theirs.
If the runner has no instruction to work with, it ends the run with
`revision-failed` and an explanation rather than an empty bubble.

**The runner does not know what a constitution is.** The composition root
carries the instruction between gate and runner through a new optional
`revisionInstruction(runId, stepId)` port. The map is capped and entries
are deleted on read.

14 tests in `test/integration/revision.test.ts` (53–66).

## Built — S6

**`persona.name`**, a tool with two fields: what the agent is called, and
what it calls you. "your name is Jacky" now works from the chat.

It needs a new capability, `persona:write`, granted to **USER and SYSTEM
only**. That is the entire safety argument and it is a mechanism rather
than a promise: effective trust is the minimum over a run, so a turn that
has read a web page, a file or a foreign tool result is already below USER
and cannot reach this tool. Decision 043 explains why this narrows decision
036 rather than overturning it — 036's injection argument is about *voice*,
and tone, length, emoji, language and notes are all still UI-only.

It is `risk: 'caution'`, not `safe`. That keeps it off the offline
provider's argument-filling path (which only fills for safe, non-external
tools), so a greeting can never be parsed into a rename, and it puts the
change on the trust rail where you can see it happened.

**The name is visible.** The persona already rendered into the **kernel**
block, which is unevictable, so a named agent is always told its name. What
was missing was the other direction: the conversation header still said
"Agent". It now follows the persona, via the same four-line
publish/subscribe the reminders use (`agent.personaChanged()`), fired both
by the Settings editor and by the runner seeing `persona.name` execute — so
the header changes while you watch instead of on the next reload.

**One wording fix.** The kernel header said "How you sound (set by the
person)". Since the agent can now set two of those lines itself, that was a
small untruth in the one block that can never be evicted. It now reads
"How you sound:", pinned both positively and negatively by test 7.

12 tests in `test/integration/persona-name.test.ts` (67–78).

## What I found in your transcript and did *not* change

**"My name is Sameer Choudhary and what about you!" → saved correctly.** I
checked this against the real extractor rather than assuming. It yields
`name = "Sameer Choudhary"`; the trailing clause is stripped by
`cleanValue`. That claim was true.

**"hi" → "I don't know your name. Hi."** I could not reproduce this as a
code defect, and I am not going to claim a fix I cannot demonstrate. The
client is not at fault: it paints the server's committed `message.agent`
verbatim, and the server appends one agent message per run. The most likely
explanation is model output — the previous turn in context was that exact
sentence, and the constitution tells it to open with the answer and not to
greet. If you see it again, the run id on the bubble will let me pull the
exact context that produced it, which is the one thing that would settle
it.

**The Settings field was always there** — "How it sounds" → "It is called",
inside the Proof panel. I have left it where it is rather than hoisting it,
because after S6 the chat is the primary way to set it and the field is now
a mirror of that. Say the word if you want it promoted.

## Two bugs found by running it, neither of them in the feature

**A latent data-loss path in the browser's persistence.** The page-hide
escape hatch called `saveToLocal`, which on quota throws away attachment
`src` and writes the shrunken copy with a *newer* `savedAt` — so the next
load prefers it over the intact account in IndexedDB and the photos are
gone. It was invisible because nothing dirtied the store during that
window; a boot-time rename was simply the first thing that ever did. Any
message sent with a large account loaded would have got there eventually.
The escape hatch now writes nothing rather than something worse, and
`shrinkOnQuota` stays true only for the case where localStorage genuinely
is the only store there is. Two tests in `src/lib/persist.test.ts`.

**And the reason the rename dirtied the store at all was my own design
error**, caught by the same test. I had mirrored the agent's name into the
persisted contact card, having written in the comment above it that the
card "is never the source of truth". The name now lives in React state and
is merged into the contact directory at read time, so it never enters the
saved account — which is both correct and the thing that makes the write
race impossible.

**A projection-rebuild mismatch that turned out not to be a bug.**
`POST /backup/verify` reported "the rebuilt projections DIFFER from the
live ones" on my development database: `facts.use_count` was 25 live and 23
rebuilt, and 23 is the number of `memory.used` events in the log, so the
rebuild was right and the live row was wrong. It is residue from before
that counter became an event — a database written by the old code and
never rebuilt since. Nothing in the current code can produce it, and a
fresh database verifies clean. Worth knowing before someone re-opens it as
a live defect.

## Not built, deliberately

- **No `persona.tone` / `persona.notes` tool.** Decision 036's argument
  survives intact for those fields.
- **No second rewrite.** A governance loop that can run away is worse than
  the thing it governs.
- **No UI for the revision itself.** A withheld draft shows as a step on
  the trust rail with outcome `revision`; it does not yet say "it rewrote
  this once" in the bubble. That is a disclosure design question and I did
  not want to guess at it.

## Unsure

- Whether `revision-failed` should be a distinct stop reason in the UI's
  own copy, or collapse into the generic failure text. It is distinct in
  the log either way.
- Whether a rename should also rewrite the agent's **initials** when the
  name is one word — it currently takes the first letter, which gives "J"
  for Jacky. Fine, but untested against a long name with punctuation.

## Numbers

Agent **1035 / 92 files**, web **167 / 16**, **e2e 163 passed / 13
skipped**, `tsc` clean both, oxlint 0/0.
Agent suite ~69s against the 60s budget — still over, and still not a
reason to delete a test.
