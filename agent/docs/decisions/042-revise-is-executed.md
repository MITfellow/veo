# 042 — `revise` actually revises, and a failed revision discloses

## The bug

§25 lets a constitutional article pick a remedy: `none`, `annotate`,
`revise` or `block`. Three of those worked. `revise` did this:

```ts
if (violations.length > 0 && judgment.remedy === 'revise') remedyApplied = 'revise';
for (const chunk of buffer) yield chunk;
```

It recorded that it had revised, and then **sent the violating draft
unchanged**. The event log said `remedy: 'revise'` on a turn where no
revision happened and the user read the text the article had just
objected to.

The failure-modes doc carried this as a known gap ("`revise` is
reported, never executed") with the reasoning that a silent
self-editor was riskier than the hole. That reasoning was about not
*building* the feature. It does not justify the log claiming the
feature ran. Of everything on the weak-points list this was the only
entry where the system says something untrue about itself, so it goes
first.

There is a second, sharper tell. The revision instruction has existed
since M7 and reads:

> Do not apologise for the draft; the user never saw it.

The user had seen it.

## Why the gate could not fix it alone

The gate wraps the provider. Regenerating from inside means a provider
that re-enters itself: it would bypass the step budget, the token cap,
the wall-clock limit and the cancellation signal, all of which live in
the runner. That was the right call and it stands. The gate decides
*what the verdict is*; the runner decides *whether to spend another
step on it*. The missing piece was never the policy, it was the
channel between them.

## The decision

Three parts.

**1. A violating draft under a `revise` remedy is suppressed, not
sent.** The gate buffers it anyway (that is what `mustBuffer` is for),
so nothing has reached the user yet. It now yields no text and
finishes with a new reason, `revision-required`.

**2. The runner spends exactly one more step.** It injects
`revisionPromptFor(...)` as a system message, sets
`governance.revisionAttempt = 1`, and runs the step again. The retry
costs a step, tokens and wall-clock from the same budget as any other
step, which is precisely why it belongs here and not in the gate. If
the budget is already exhausted, no retry happens and part 3 applies.

**3. A second violation is disclosed, not hidden and not blocked.**
When `revisionAttempt > 0` and the output still violates, the gate
sends the text *with an annotation saying the revision was attempted
and did not clear it*, and records `remedy: 'revise-failed'`.

Part 3 is the only genuinely arguable one, so:

- **Not block.** The article's author chose `revise` over `block`.
  Those are different severities and the whole point of having four
  remedies is that they mean different things. Escalating to a refusal
  because the model failed twice substitutes my judgment for the
  article's.
- **Not silently send.** That is the bug being fixed.
- **So: send and say so.** The person gets the answer, plus one plain
  sentence saying it still conflicts with article X and why. That
  respects the chosen severity and keeps the system honest about its
  own state, which is the property the original bug violated.

## Consequences

- `FINISH_REASONS` gains `revision-required`. A caller that is not the
  runner — a test, a future surface — sees a finish reason it can
  handle rather than a silently empty stream.
- The event payload's `remedy` enum gains `revise-failed`, so the log
  distinguishes "revised successfully" from "tried and could not".
  `remedy: 'revise'` in the log now means a revision really happened.
- The runner gains one optional port, `revisionInstruction(runId,
  stepId)`. It does not gain a dependency on the constitution module;
  the composition root, which already holds both ends, wires them.
- One retry, never two. A model that cannot satisfy an article twice
  will not satisfy it on the sixth attempt, and a governance loop that
  can run away is worse than the thing it is checking.

## What would change my mind

If real use shows that `revise` articles are usually satisfied on the
second attempt but occasionally need a third, the attempt count could
become a per-article setting. It should not become a global default —
the cost of a runaway governance loop is paid by the user, in latency,
on every turn.
