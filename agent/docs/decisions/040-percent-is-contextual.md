# 040 — `250 + 8%` means 270, not 250.08

**Status:** accepted (S1)

## The ambiguity

`math.eval` has to decide what `%` means, and there are two defensible
answers that disagree on the same input:

- **Literal:** `%` is "divide by 100", always. Then `250 + 8%` is
  `250 + 0.08` = `250.08`.
- **Contextual:** in `a + b%` and `a - b%` the percent is taken *of `a`*.
  Then `250 + 8%` is `270`.

The spec says nothing about this; §20 only says a tool's description must
let a model choose it correctly.

## The decision

Contextual, for `+` and `-` only.

The reason is who is asking. Nobody types `250 + 8%` into a calculator
wanting `250.08`. They are adding tax, or a tip, or a raise. Every
pocket calculator, every spreadsheet's `%` key and every phone calculator
reads it the contextual way, so the literal reading would be a wrong
answer that is also *surprising* — the worst combination, because the
person has no reason to check it.

The literal reading stays everywhere else, because nothing else is
ambiguous: `50%` alone is `0.5`, `17% of 250` is `42.5`, and `8% * 2` is
`0.16`. The contextual rule applies only when the entire right-hand
operand of a `+` or `-` is a bare percent literal — `isBarePercentSpan`
checks exactly that, so `250 + 8% * 2` goes back to the literal reading
rather than guessing.

## What this costs

An expression like `250 + 8% * 2` now reads differently from
`250 + (8% * 2)` in a way a careful reader might not predict, and
`a + b%` is not the same as `a + (b%)`. That is a real wart. It is
accepted because the alternative is being confidently wrong about a
restaurant bill, and because the agent reports the expression alongside
the answer (`250 + 8% = 270`), so the reading it used is visible rather
than hidden.

## Related

The same file carries a second decision not worth its own note:
`-2^2` is `-4`, not `4`. Exponentiation binds tighter than unary minus,
which is the convention in mathematics and in Python, and the opposite of
Excel's. It was caught by test 4 of the S1 list — the first draft of the
grammar had `power()` call `unary()` for its base, which produced `4`.
