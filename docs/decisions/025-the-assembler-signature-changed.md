# 025 — §21's signature wins over M2's promise

**Status:** accepted (M5) · **Related:** §21, §36

## Context

M2 shipped a three-block assembler and its header said the signature would
not need to change at M5. §21 specifies something different:

```ts
assembleContext({ principal, sessionId, budget, snapshot, policy, trust, now })
```

M2 took `{ system, situation, history, maxTokens, countTokens }` — no
snapshot, no policy, no principal, no trust.

## Decision

Adopt §21's signature. Delete M2's.

Three blocks fit through the old hole. Fourteen do not, and the ones that do
not are precisely the ones that need a policy: per-block budgets, per-model
shares, sensitivity filtering, trust-filtered tool listings. Keeping the old
signature would have meant smuggling the policy in through a global or a
module import, which is the thing §36 warns about, or quietly dropping the
parts of §21 that did not fit.

§36 also says: if the spec is wrong once in the code, say so explicitly
rather than silently deviating. Here *the code* was wrong about the spec. So
this note is the saying-so.

## Consequences

- `runner.ts` and the golden files changed with it; nothing else imported the
  assembler, so the blast radius was two files.
- M2's single golden file was replaced by twelve scenario goldens (§21 asks
  for about twelve). The old one tested a shape that no longer exists.
- The unit tests that encoded the M2 contract were rewritten against the new
  shape, property for property: purity, the budget ceiling, whole-item
  eviction, eviction reporting, the fence. **No property was dropped** — each
  one is asserted in `test/unit/context-assembly.test.ts` against the
  fourteen-block assembler, plus the ones the old signature could not
  express.
