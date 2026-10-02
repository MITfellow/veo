# 026 — Shares are a cap; the surplus is split by share, not by priority

**Status:** accepted (M5) · **Related:** §21

## Context

§21: *"Budgets are declared per block as a share of the model window, in
config, per model."* It also gives a survival priority order for the fourteen
blocks. It does not say how the two interact when a block uses less than its
share.

The first implementation walked survival order and let each block take
"everything the blocks below it do not strictly need".

## Decision

Three passes: everyone gets up to their declared share; the unclaimed
surplus is split **in proportion to share** among blocks that still want
more; rounding crumbs go down survival order.

## Why it changed

A golden file caught it. In the `near-overflow` scenario at a 2,400-token
window, the first implementation gave retrieved memories 1,003 tokens — 42%
of the window against a declared share of 16% — and evicted eleven live
conversation turns to pay for it. Neither number was predictable from the
config.

The mistake was treating one question as two. They are not the same:

- **who dies when there is not enough room** — survival priority (§21)
- **who gets the slack when there is room to spare** — the declared shares

§21's table ranks memories above conversation for *survival*, and under real
pressure that is still exactly what happens. It does not follow that a
higher-priority block should exceed its own declared share while a lower one
goes unmet — that makes the share decorative, and a budget nobody can predict
from the config is not a budget.

After the change, the same scenario keeps all 60 conversation turns and drops
5 of 30 memories.

## Consequences

- An empty block still releases its whole share, which is the point: a cold
  start spends the memory share on conversation rather than holding it open
  for memories that do not exist.
- Shares are now meaningful as written, so tuning them has predictable
  effects.
- This is the second time a golden file has changed a decision rather than
  merely recording one. That is the argument for keeping twelve of them.
