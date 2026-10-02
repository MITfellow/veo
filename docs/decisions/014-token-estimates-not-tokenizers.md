# 014 — Token counts are stable estimates, not exact tokenizer output

**Status:** accepted · **Milestone:** M2

## Context

§32 budgets context assembly and the run loop in tokens. Exact counts need a
per-model tokenizer: `tiktoken` for OpenAI, a different one for Anthropic,
another for local models. Each is multiple megabytes of WASM or data tables,
each is a dependency that must track model releases, and each would have to be
loaded before the first token could be budgeted.

## Decision

The `ModelProvider` port exposes `countTokens`, and the kernel uses
**characters / 4** as the default estimate. The estimator is **injected** into
`assembleContext` rather than imported, so a provider that *does* have a cheap
exact tokenizer can supply it without changing the assembler.

Budgets are set with headroom appropriate to an estimate.

## Consequences

- No multi-megabyte dependency, no per-model data to keep current, and
  assembly stays pure and synchronous.
- The estimate is wrong by roughly ±10–15% for English prose and worse for
  code or CJK. Mitigation: budgets carry headroom, and overflow is handled
  (M5 adds overflow → compact → retry). An estimate that is stable is more
  useful here than one that is exact but unavailable at assembly time.
- Cost reporting uses the provider's **reported** usage, never the estimate.
  Money is never computed from a guess.
