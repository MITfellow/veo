# 027 — Eight new event types for memory, including `memory.rejected`

**Status:** accepted · **Milestone:** M6 · **Spec:** §9 (closed event set), §22.3, §22.5, §22.7

## The ambiguity

§9 presents the event set as closed, and §35's invariant 1 makes the log the
only source of truth. §22 then requires three things the closed set cannot
express:

1. "Rules that keep getting overridden decay and retire automatically …
   retired **with an event**" (§22.3). There is no `rule.*` event.
2. Consolidation (§22.7) must be idempotent and must record its bias-audit
   metrics. There is no event for a consolidation pass, so "did this already
   run tonight?" would have to be answered by a side table — a second source
   of truth, which invariant 1 forbids.
3. Episodes (§22.1) are "derived from the log", but the *outcome signal*
   (satisfied / corrected / abandoned) is a judgement made later, not
   something any existing event carries.

Decision 024 set the precedent: `history.compacted` was added because the
alternative was recomputing a summary on every boot. The same reasoning
applies here, and the same obligation — say so out loud (§36) rather than
quietly widening a set the spec calls closed.

## The decision

Eight additions:

| event | why it cannot be expressed with the existing set |
|---|---|
| `rule.learned` | §22.3's rules have no creation event |
| `rule.applied` | the `applied` counter must be reconstructible |
| `rule.overridden` | the override counter *is* the decay mechanism |
| `rule.retired` | §22.3 says "retired with an event", verbatim |
| `episode.recorded` | the outcome signal is a later judgement |
| `memory.consolidated` | idempotency needs a durable "already ran" marker |
| `memory.rejected` | see below |

## `memory.rejected`, and why it is the important one

§22.5 gates writes aggressively: no source span, hypothetical framing,
third-party content, transient state, "don't remember this", protected
attributes, FOREIGN trust. Seven ways to say no, and the spec records none of
them.

A refusal that leaves no trace is indistinguishable from an extraction that
never ran. Three consequences, all bad:

- **"Why don't you know that?" has no answer.** The user told the agent
  something, the gate dropped it, and there is nothing to point at. §22.8
  promises the user can see what the agent knows; they also need to see what
  it *refused* to know.
- **The gate cannot be audited for over-rejection.** A gate that rejects
  everything passes every test in §22.5. The only way to notice is to count
  rejections against writes over time, which requires them to be in the log.
- **"Don't remember this" needs a receipt.** §22.5 says to "reject and record
  the refusal". Record it *where*, if not in the log?

The payload deliberately carries the reason and the predicate but **not the
rejected value**. Refusing to store something and then writing it verbatim
into an append-only log would be theatre — and for the protected-attribute
case it would be exactly the harm the rule exists to prevent. The subject is
reduced to a hint (an entity id or `self`), which is enough to answer "why
don't you know where I work?" and not enough to reconstruct what was dropped.

## What this costs

The event set grows from 54 to 62. Every one is schema-validated like the
rest, and all eight are consumed by projectors or by the memory read path —
none is write-only decoration. The upcasting story is unchanged: new types,
no modified payloads.

## What I rejected

**Folding rules into `memory.written` with `predicate: 'rule'`.** Tempting —
no new events — but a rule is not a fact about the world; it has a trigger, an
override counter and a lifecycle a fact does not have. Squeezing it into the
fact schema would have meant either a loose `object` blob (losing the DB-level
`CHECK`s that make the fact table trustworthy) or widening the fact schema
for a shape only one caller uses. The table is separate in §22 for a reason;
the events should be too.

**Keeping rejections in a side table only.** Faster, and it is still a
projection — but then the rejection history would not survive a projection
rebuild, and "what did you refuse to learn last March?" would quietly become
unanswerable after any schema change. The log is the only thing in this system
that is allowed to be the truth.
