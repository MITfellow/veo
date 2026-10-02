# 024 — A summary is an event, and the default summarizer is not a model

**Status:** accepted (M5) · **Supersedes:** nothing · **Related:** 021, invariants 1, 2, 4

## Context

§23 requires compaction: summarize the oldest contiguous chunk, keep event-id
pointers, never destroy the originals. §9 lists a closed set of event types
and compaction is not in it.

## Decision

Two parts.

**1. `history.compacted` is a new event type.** A deliberate addition to §9's
list, the same way `egress.allowed` was (decision 021).

The alternative is to recompute summaries from the raw turns whenever they
are needed. That fails three ways. It costs money every restart if a model
writes them. It is nondeterministic, so the context becomes a function of
*when you asked* rather than of what happened, which breaks invariant 4. And
it makes the pointers meaningless: the span a summary covers is a decision
somebody made at a moment, not a property of the log.

**2. The default summarizer is extractive and pure, not a model call.**

The obvious implementation asks the model. That puts a network call, a
latency spike and a failure mode on the path *while the user is waiting*, and
makes the result vary run to run. The extractive summarizer pulls decisions,
open threads, questions and proper nouns out of the turns themselves: every
string it emits is a substring of something that was actually said, so it
cannot hallucinate a fact about the user's life.

It writes visibly worse prose than a model would. It is also the version I
would rather debug in year three, and §23's requirement is *structure*, not
fluency.

A model summarizer can be injected (`new Compactor({ summarize })`), and the
summarizer's name is recorded on every summary so you can always tell which
one wrote a given line.

## Consequences

- Compaction is free, offline, deterministic and testable.
- Summaries are terse and slightly mechanical. Acceptable: they exist to
  preserve *retrievability*, and `history.expand` gets the real text back.
- One more event type. 54 now.
- When a model summarizer does arrive, old summaries stay valid and
  distinguishable rather than being silently mixed with new ones.
