# 022 — A FOREIGN-influenced step is refused, never escalated

**Status:** accepted · **Milestone:** M4 · **Narrows the spec:** yes

## The tension

§12.3 says:

> **Escalation requires a human.** A FOREIGN-influenced step that wants a
> higher capability must emit `policy.escalated` and obtain an explicit
> approval that shows the user *what content is asking for it*.

§33 says the injection corpus must be **fully refused**, with the prompt
fence removed.

Those pull in opposite directions. If a FOREIGN step can escalate, then the
attack "web page asks the agent to pay the attacker" does not end in a
refusal — it ends in an approval dialog. And an approval dialog is a refusal
only if the human reliably says no.

## The decision

Escalation is available at **TOOL trust and above**. A step whose effective
trust is **FOREIGN** is refused outright: no `policy.escalated`, no approval
row, no prompt.

## Why

The thing being protected is the user's attention, which is finite and which
the attacker gets to spend. A FOREIGN step can escalate as often as it likes
— every page fetch is a fresh opportunity — so the attacker's strategy writes
itself: generate plausible-looking approval requests until one is approved
out of habit. The fortieth dialog of the day is not consent, and the gate
that produced it was decorative.

TOOL trust is different in kind. It means an allowlisted source returned the
content: something the user already decided to trust, in a channel they
configured. Escalating from there is the case §12.3 is actually useful for —
"I looked up the invoice total and now I need to pay it" — and it is bounded,
because the set of allowlisted sources is bounded.

So the rule is: **the user is asked to adjudicate requests from things they
chose to trust, and is never asked to adjudicate requests from the open
internet.** For the latter the answer is no, and the machine can say it
without consulting anyone.

## What this costs

A genuine task that routes through a web page and then needs money will stop
rather than ask. The user has to start it themselves, from a trusted
instruction. That is a real cost, paid every time, in exchange for the
attacker never getting a dialog box.

If this proves too strict in practice, the right loosening is a per-host
allowlist that promotes specific sources from FOREIGN to TOOL — which is a
decision the user makes once, in settings, at leisure, rather than one they
make in a dialog while trying to do something else.

## Recorded as a deviation

§12.3 reads as though every FOREIGN step may escalate. This implementation
refuses those and escalates from TOOL upward. Written here rather than
silently implemented (§36), and the behaviour is pinned by tests in both
directions: `approvals.test.ts` asserts TOOL escalates; the injection corpus
asserts FOREIGN produces zero pending approvals.
