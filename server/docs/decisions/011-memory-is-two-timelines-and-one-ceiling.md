# 011 — Memory is two timelines and one trust ceiling

**Status:** accepted · **Milestone:** M2 · **Supersedes:** nothing

## The decisions

### 1. `supersede` and `correct` are different methods, not a flag

M0 built the bitemporal table. M2 had to decide what the store above it
exposes. The temptation is one `update(factId, newValue, { corrected: true })`,
because the two paths share most of their code.

They are not the same operation and must not share a name:

- **supersede** closes *valid* time. "I moved to Berlin." The old belief was
  correct and stays believed; a query dated before the move must still say
  Acme.
- **correct** closes *transaction* time. "I never worked there, you
  misheard." Valid time is untouched, because we are not claiming the world
  changed.

A boolean flag makes the distinction invisible at the call site, and the
call site is exactly where the judgement is being made. Two methods, two
event types, two projector branches.

### 2. Trust is checked on *mutation*, not only on *assert*

The browser work (009, 010) spent a lot of effort making sure a page cannot
plan. All of it is worthless if a page can instead write into memory, because
a fact is replayed into the privileged path every time it is recalled. A
poisoned memory is a prompt injection with a delay fuse.

So `supersede`, `correct` and `retract` all run `requireTrust`: the trust of
the input must be permitted against the trust of the row it is changing. A
FOREIGN extraction cannot touch a USER fact, and the refusal names the meet
that would have resulted.

### 3. The job's output ceiling applies on the way in

`meetTrust(sourceTrust, 'DERIVED')`. Every cognitive job is capped at DERIVED
(§20) because an extraction is inference, not testimony. So:

| source | stored trust |
| --- | --- |
| what the user typed | DERIVED |
| a tool's output | TOOL |
| a web page | FOREIGN |

A fact is never stored as USER by the pipeline. Only a human acting directly
— `pin`, `correct`, the CLI — writes at USER.

### 4. FOREIGN text goes through the quarantine, or it does not go in

`ingest` refuses a FOREIGN source when no `Quarantine` was supplied, rather
than falling back to reading the bytes on the privileged path. A missing
dependency must not silently downgrade into a missing defence.

This required `Quarantine.admitAsync`, because a Cognitive Job is async — one
day a model will serve the extraction, and a model reading FOREIGN bytes is
precisely the case the channel exists for. Forcing the sync signature would
have pushed that call *outside* the channel, which is how a boundary quietly
stops being one. `admit` and `admitAsync` share `hold` and `release`, so there
is one ordering and one passthrough check, not two.

### 5. Confidence and the trust floor answer different questions

Found by running the demo, not by a test. The first version scaled a FOREIGN
fact's confidence by 0.5 and *then* compared it to the 0.5 floor, so every
web-page fact landed at 0.45 and was dropped. FOREIGN ingestion was dead code
and every trust assertion in the suite still passed, because they asserted
what a stored FOREIGN fact looks like without checking that one ever arrived.

The two numbers mean different things:

- the **extractor's** confidence: is this really what the sentence said?
- the **stored** confidence: how much do we credit it, given who said it?

The floor is checked against the first. The scale is applied to the second.

### 6. `item_blobs` is not a projection

Item content is sealed under its own key and parked in a table no projector
writes and `rebuild` does not drop. The event log carries the metadata — that
an item exists, its label, its sealed size — and never the content.

Forgetting therefore destroys the key and leaves the ciphertext. The history
stays honest: the log still says the item existed and still says it was
shredded. A system that could erase the record of a deletion could erase the
record of anything.

### 7. Consolidation proposes; the store decides

The job returns a plan. Two rules are enforced *outside* it, in
`cognition/memory/consolidate.ts`, so they hold whichever strategy ran:

1. a **pinned** fact is never superseded — a human said it matters;
2. a contradiction is **raised**, never resolved — two different values for
   the same thing is either a change or an error, and nothing in the facts
   themselves can tell you which.

A model will one day produce that plan. The thing that writes to the log must
not be the thing the model controls.

`supersedeBy` exists for the same reason: consolidation points an old fact at
an *existing* winner instead of asserting a copy, because a copy would give
the next run fresh work and idempotence is what makes this safe to schedule
in M7.

## What this cost

- A new method (`supersedeBy`) that looks redundant next to `supersede`.
- Two admit paths on the quarantine.
- An optional `reason` on `fact.superseded`.

## What was rejected

- **One `update` with flags.** See 1.
- **Creating an entity when a mention does not resolve.** A wrongly created
  duplicate splits a person's history in two and nobody notices for months;
  an unresolved mention is stored as plain text and is recoverable.
- **Letting consolidation settle a contradiction by confidence.** Confidence
  measures how sure the extractor was, not which statement is current.
- **Deleting shredded blobs.** Keeping them is the proof that the key, not
  the row, is what was destroyed.
