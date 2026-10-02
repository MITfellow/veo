# AGENTS.md

The complete specification for this project is **[`arish.md`](./arish.md)**.

Read it in full before writing any code, and re-read §35 (Invariants) and §36
(Working agreement) at the start of every session.

Short version of the rules that must never break:

1. The event log is the only source of truth; everything else is rebuildable.
2. Nothing mutates history.
3. The process may die at any instruction — runs resume or fail cleanly.
4. Context assembly is pure, deterministic, budgeted and logged.
5. Every remembered fact has a source, a basis and a confidence.
6. Trust never increases along a causal chain; capability follows effective trust.
7. Secret values never exist outside the vault boundary.
8. Deletion is crypto-shredding, honored in all future contexts.
9. No tool name appears outside `src/tools/`.
10. External effects are exactly-once via the outbox, or they do not run.
11. Failure is data, not an escaping exception.
12. The user's explicit instruction outranks every learned inference.
13. Never infer from protected attributes.
14. Never flatter; never flip a factual position without evidence.
15. No unexplained output — every sentence is traceable.

Never weaken a test to make it pass. The tests encode the architecture.

> `docs/HARNESS_PROMPT.md` is the earlier draft, kept for reference only.
> `arish.md` supersedes it.
