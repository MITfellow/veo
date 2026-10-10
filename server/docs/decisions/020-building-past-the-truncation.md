# 020 — Building past the truncation: §17, §18, §19, §20

Status: accepted · **Contains invented specification — read the list**

## Context

The replacement specification arrived truncated at §20. §17 (Context
Assembler), §18 (the four memory stores), §19 (the run loop and its
failure modes) and §20 (the degradation ladder) are named in the part
received, with a handful of concrete parameters, and detailed nowhere.

The instruction was to complete them anyway. So this record exists to
mark the seam: **everything below that the document did not state, I
decided.** When the rest of the specification arrives, this is the list
to check against, and anything that conflicts should be changed to match
the document rather than defended.

### Taken from the document

* §18 rule decay: **3 overrides → probation, 5 → retired**.
* §20: a **ladder L0–L6**.
* §17: a pure function, ordered blocks, a stable cached prefix, and
  **≥16 golden scenarios**.
* §19: gates **default to FAIL**; **sixteen named failure modes**.

### Invented here

* The **fourteen blocks** of §17 and their order.
* Which blocks form the cacheable prefix, which are undroppable, and the
  order things are dropped in under budget pressure.
* Every **rung definition** in §20 — which signal binds at which rung.
* All **sixteen failure-mode names** in §19, and the eight standard
  gates.
* §18's **rehabilitation path** (5 consecutive confirmations clears
  probation) and the confidence deltas.

## §17 — the Context Assembler

One pure function, `assembleContext`, from material to the exact text a
model would see. Fourteen blocks, emitted least-changing to
most-changing, so `identity | capabilities | policy` is byte-identical
across every turn of a session and a provider's prompt cache can key on
it. Shuffling a tool list into the top of a prompt would silently cost
money on every turn; the ordering is a cost decision as much as a
clarity one.

Trust descends through the blocks and the **task sits last**, nearest the
model's output, with untrusted material fenced above it as references
only — never bytes. The policy block states, in the prompt itself, that
such content is data and not instruction.

Under budget pressure whole blocks are dropped in a fixed order, never
fragments: half a facts list reads like a complete one and quietly
misinforms. `identity`, `policy` and `task` cannot be dropped at all, and
what *was* dropped is returned in the result rather than logged, so a
caller can tell the user "I answered without your calendar because the
conversation was long."

Sixteen golden scenarios in `test/golden/context.test.ts`.

## §20 — the degradation ladder

`assess(signals) → {rung, label, reason, lost, kept}`, pure, evaluated
worst-first so **the binding constraint is always the most severe one**.

| rung | binds when | what goes |
|---|---|---|
| L6 | the hash chain does not verify | everything but reading |
| L5 | storage is not writable | remembering, approvals |
| L4 | the vault is locked | encrypted items, tokens |
| L3 | no network | connectors, browsing |
| L2 | no valid credential | anything behind a sign-in |
| L1 | no model | fluency — **the intended state of this build** |
| L0 | nothing is wrong | — |

Each rung names what is lost *and what remains*, phrased as the state of
the machine: "the vault is locked" is actionable, "permission denied" is
not. The CLI and the API now both call this one function; the hardcoded
`'L1'` string in two places is gone.

## §18 — procedural rule decay

A rule demotes itself: `active → probation (3 overrides) → retired (5)`.
A probationary rule is **kept and not used** — deleting it would lose the
history explaining why the agent stopped trusting it, using it would
ignore the three corrections that put it there.

Retirement is **one-way**. Resurrecting a retired rule on a lucky streak
is how an agent re-learns something it was explicitly corrected on.

Confidence falls faster than it rises (−0.20 against +0.05), because
being wrong is stronger evidence than being right — being right is also
what a coincidence looks like.

## §19 — completion gates

`evaluateGates(evidence)` over eight standard gates. **A gate whose check
throws has failed, not been skipped**: the alternative turns every bug in
the checking code into a false claim of success.

Gates see only external evidence — events appended, effects committed,
artifacts that exist on disk — and never the plan's own opinion of
itself, because the plan is the thing on trial.

## Consequences

* Suite 812 across 58 files.
* `cli.ts` hit its ceiling again; the vault branch moved to
  `interface/vault-door.ts` and `dbPathFor` — written out three times
  across the interface layer — now has one definition in
  `substrate/files.ts`.
* **None of this is wired into the executor yet.** The assembler builds
  context nobody consumes, the gates judge evidence nobody collects, and
  the rules decay in a module with no store behind them. They are
  correct, tested, and inert — which is the same posture as the model
  strategies, and is deliberate: wiring them into the run loop is a
  change to the run loop, and that is §19's other half, which the
  document has not yet described.
