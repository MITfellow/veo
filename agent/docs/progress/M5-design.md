# M5 — Context Assembler: design note and test list

> §36: the design note and the test list come before the code.

**The bar (§33):** a 200-turn session stays in budget with no loss of
coherence, and assembly is under 100ms.

That second clause is the one that shapes the design. Under 100ms for a
200-turn session rules out "re-read the whole log, re-render every block,
re-count every token, every turn". So the question M5 actually has to answer
is: *how do you make a pure function fast without making it stateful?*

---

## 1. What is already true

M2 shipped the contract — pure, deterministic, budgeted, reports eviction —
with three blocks. M5 keeps every word of that contract and replaces the
implementation with §21's fourteen blocks.

M2's header says the signature will not need to change. **That was wrong,
and I am saying so rather than quietly bending §21 to fit it** (§36). §21
specifies `assembleContext({principal, sessionId, budget, snapshot, policy,
trust, now})` — a *snapshot* gathered beforehand, plus a *policy*. M2's
signature takes loose `system`/`situation`/`history` arguments with no
policy and no principal. Three blocks fit through that hole; fourteen do
not, and the ones that do not fit are exactly the ones that need policy
(per-block budgets, per-model shares, sensitivity rules).

M5 adopts §21's signature. The call site in `runner.ts` and the golden file
change with it, and that is the whole blast radius.

## 2. Shape

```
gather (impure, L5)            assemble (pure, L4)             log
───────────────────            ───────────────────             ───
Snapshotter.gather()  ──────►  assembleContext(input)  ──────►  context.assembled
  reads log, memory,             fourteen blocks                 digest + blocks
  tools, approvals               budgets, evicts                 + drops + policy
                                 renders templates                version
```

Everything that touches the world lives in `Snapshotter` (orchestration).
`assembleContext` receives a frozen `StateSnapshot` and returns an
`AssembledContext`. The seam is what makes 12 golden scenarios possible:
each is a literal snapshot object checked into `test/fixtures/snapshots/`.

### Files

```
src/cognition/context/
  types.ts        StateSnapshot, ContextPolicy, AssembledContext, blocks
  policy.ts       per-model block shares; resolveBudgets()
  assemble.ts     the pure function
  digest.ts       stable content digest (what context.assembled points at)
  templates/
    index.ts      TEMPLATES registry: name → {version, render}
    kernel.ts     blocks 1,2,3,4   — who the agent is and what it may not do
    situation.ts  blocks 5,6,7     — now, owed, unknown
    memory.ts     blocks 8,9       — pinned, retrieved (with epistemics)
    working.ts    blocks 10,11,12  — artifacts, conversation, compacted
    tools.ts      block 13         — schemas, filtered by trust
    foreign.ts    block 14         — the fence
src/cognition/compaction.ts        structured summaries + CompactionStore
src/cognition/tokens.ts            counting + the memo cache
src/orchestration/snapshot.ts      Snapshotter (impure gather)
src/tools/history-expand.ts        history.expand
```

## 3. The fourteen blocks, and the squeeze

Survival priority is §21's table, verbatim, as a frozen array. The order
blocks are *rendered in* (the message order the model sees) is **not** the
order they are *evicted in*, and conflating those two is the bug I most
expect to write. Two explicit arrays, `RENDER_ORDER` and `SURVIVAL_ORDER`,
and a test that asserts they are different and that both name all fourteen.

Eviction: walk `SURVIVAL_ORDER` from the back, dropping **whole items**,
never partial structures. A block that loses items emits an `Eviction` and,
where the block supports it, a visible in-context marker:

> *3 older messages summarized above.*

A silent drop is the assembler lying to the caller; a drop the model cannot
see is the assembler lying to the model. Both are bugs.

Blocks 1–4 are **unevictable**. If the kernel instructions, the
constitution, the identity card and the hard constraints do not fit in the
budget, assembly does not quietly ship an agent with no taboos — it throws
`ContextTooSmallError`. A context budget too small to hold "never contact
this person" is a configuration error, not a runtime condition to paper
over.

## 4. Budgets live in config, per model

§21: *"Budgets are declared per block as a share of the model window, in
config, per model. No magic numbers in code."*

```ts
ContextPolicy {
  version: string;                       // logged with every assembly
  model: string;
  window: number;                        // model's context window, tokens
  reserveForOutput: number;
  shares: Record<BlockName, number>;     // fraction of the window
  minTokens: Partial<Record<BlockName, number>>;
}
```

Shares are a *claim*, not a reservation: a block under its share releases
the remainder to the blocks below it in survival order. Otherwise a cold
start with no memories would waste a third of the window on nothing while
evicting conversation turns.

`policy.version` goes into `context.assembled`, so "why did it say that?"
can be answered with the exact budget split in force that day.

## 5. Under 100ms for 200 turns

Measured, not asserted: a test builds a 200-turn session and fails over
100ms. Three things make it hold.

1. **Token counts are memoized by content, not by position.** A turn's
   token count is a pure function of its text; a session re-assembled 200
   times re-counts the same 199 strings. `tokens.ts` carries a `TokenCache`
   (a `Map<string, number>` keyed by text) passed in through the policy.
   The cache is an *argument*, so the function stays pure: same input, same
   output, cache or no cache. A test asserts that assembling with a cold
   cache and a warm cache produce byte-identical output.
2. **The snapshot is built once per turn, not once per block.** Blocks read
   fields; they never scan.
3. **Compaction bounds the input.** Past `compactAfterTurns`, the oldest
   contiguous chunk is already a stored summary, so the assembler is never
   handed 200 raw turns in the first place.

The carried M4 weakness — `trustForStep` and `historyFor` scanning the log
every step — is in scope here, because it is the same 100ms. The snapshotter
reads the session's events **once per turn** and hands both the history and
the trust floor to the step.

## 6. Compaction (§23)

- Summarize the **oldest** contiguous chunk, never the newest.
- Summaries are structured, not prose: `{decisions[], openThreads[],
  entities[], unresolvedQuestions[], span: {fromEventId, toEventId,
  turnCount}}`, validated by zod like everything else.
- Originals are never destroyed. A summary is a **new event**, not an edit
  (invariant 2). New event type `history.compacted` — a deliberate addition
  to §9's closed set, with the reason written down in a decision note: a
  summary that is not in the log would have to be recomputed on every
  restart, which costs money and is nondeterministic.
- `history.expand(fromEventId, toEventId)` is a tool in `src/tools/`
  returning the verbatim originals, so the model can get the detail back.
  Compaction is a view.

**Overflow → compact → retry.** A provider `context_overflow` error triggers
one compaction pass and **exactly one** retry at a reduced budget, then
fails as data (invariant 15). Not a loop: an overflow that survives one
compaction is a bug in the budget, and retrying it forever is how a $400
night happens.

## 7. Epistemics are rendered, not stripped (§21 + invariant 5)

Every memory renders with its basis, confidence, date and source count:

```
- prefers tea over coffee  (observed, 0.92, 4 sources, last seen 2026-09-30)
- probably lives in Pune   (inferred, 0.41, 1 source, 2026-03-02)  ⚠ low confidence
```

And §24.4: when the profile is thin the context *says so*, in words, and
instructs the agent to behave like someone who has met this person three
times. A cold-start golden file locks that in. A new user must never be
shown fabricated intimacy, and the only way that stays true in two years is
if a golden file breaks when it stops being true.

## 8. The fence is block 14 and stays belt, not braces

FOREIGN content renders last, lowest priority, explicitly delimited (M2's
`FENCE_OPEN`/`FENCE_CLOSE`). The injection corpus keeps running with
`fence: false` and keeps passing. M5 must not make the fence load-bearing;
the M4 corpus is the regression test for that.

---

## Test list (written before the code)

### Unit — `test/unit/context-policy.test.ts`
1. shares that sum over 1.0 are rejected at parse time
2. an unknown block name in `shares` is rejected
3. `resolveBudgets` splits the window by share, minus `reserveForOutput`
4. a block under its share releases the remainder to lower-priority blocks
5. `minTokens` is honoured even when the share rounds below it
6. a window too small for blocks 1–4 throws `ContextTooSmallError`
7. two different models yield different splits from the same snapshot

### Unit — `test/unit/context-blocks.test.ts`
8. `RENDER_ORDER` and `SURVIVAL_ORDER` both name all fourteen blocks exactly once
9. they are not the same order (the distinction is load-bearing)
10. blocks 1–4 are marked unevictable
11. every block has a template with a name and a version
12. the identity card is clamped to 400 tokens (§21) and says it was clamped

### Unit — `test/unit/context-assemble.test.ts`
13. pure: same input twice → byte-identical output (deep equal, incl. digest)
14. never exceeds `maxTokens`, over 200 random snapshots (property-style, seeded)
15. eviction drops whole items, never partial ones
16. every eviction is reported with block, id, reason, tokens
17. a conversation that loses turns renders "N older messages summarized above"
18. pinned memories are never evicted, even at the tightest budget that fits 1–4
19. `secret`-sensitivity facts are excluded unless policy allows
20. tool schemas are filtered to the trust level (FOREIGN sees fewer)
21. FOREIGN turns are fenced; `fence:false` removes the wrapper and nothing else
22. the digest changes when any block content changes, and only then
23. cold token cache and warm token cache produce identical output
24. thin profile → the honest-ignorance paragraph is present
25. rich profile → it is absent

### Unit — `test/unit/compaction.test.ts`
26. summarizes the oldest contiguous chunk, never the newest
27. the summary validates against the structured schema
28. originals are untouched; the summary is an append
29. event-id pointers round-trip through `history.expand`
30. compaction is idempotent — running it twice adds nothing the second time
31. a chunk that is already summarized is not re-summarized

### Integration — `test/integration/context-runner.test.ts`
32. a run logs exactly one `context.assembled` per step, with a digest
33. the logged blocks/drops match what the assembler returned
34. `context_overflow` → compact → exactly one retry at a reduced budget
35. a second overflow after the retry fails as data (`run.failed`), no loop
36. `history.expand` returns the verbatim originals a summary points at
37. a restarted process reassembles the same context from the log alone

### Performance — `test/integration/context-perf.test.ts`
38. **a 200-turn session assembles in under 100ms** (the §33 bar)
39. a 200-turn session stays within budget and keeps the last turn verbatim
40. assembly cost is sub-linear in session length once compaction kicks in

### Golden — `test/golden/context/*.txt` (§21 asks for ~12 scenarios)
41. cold start (nothing known) · 42. long session · 43. memory-dense ·
44. tool-dense · 45. post-compaction · 46. near-overflow · 47. degraded mode ·
48. FOREIGN content present · 49. low-confidence profile · 50. pinned memories ·
51. hard constraints present · 52. everything at once

Each golden is a checked-in snapshot fixture plus its rendered output. A diff
is a deliberate behavioural change and gets reviewed as one.

### Adversarial — appended to the existing corpus
53. the M4 injection corpus still passes with `fence: false` after the rewrite
54. FOREIGN content cannot evict a hard constraint by being long
55. a FOREIGN turn containing the literal fence delimiters cannot close the
    fence early and escape (delimiter injection)
