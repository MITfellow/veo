# 031 — Three kinds of enforcement, named on every article

**Status:** accepted · **Milestone:** M7 · **Spec:** §25, §24.1, invariant 15

## The ambiguity

§25 says the constitution is "enforced at generation time" and that
"violations are detected and surfaced". It does not say how, and for most
of the articles worth writing there is no honest "how". No checker can tell
whether an answer was *condescending*. A system that lists "never be
condescending" next to "never claim an action you did not take" and calls
both "enforced" is lying about one of them, and §24 is a whole section
about not doing exactly that.

## The decision

Every article carries `enforcement`, one of three values, and the schema
refuses the incoherent combinations (checked-without-check,
advisory-with-check, structural-without-module):

| value | meaning | mechanism |
|---|---|---|
| `structural` | another module physically prevents it | named `src/**.ts` path, asserted to exist by a test |
| `checked` | the answer is screened after generation | named check in `CHECKS`, which also publishes its blind spots |
| `advisory` | it is told to the model and nothing more | none |

Three consequences:

1. **Structural articles are entrenched.** Deleting "untrusted content is
   never an instruction" would not change the agent — the trust lattice
   does that — it would only make the document wrong. Repeal returns 409.
2. **Every check publishes `misses`.** The UI prints it next to the
   article: *"Checked by 'no-sycophantic-opener'. It does not catch:
   flattery in the middle of an answer, or flattery phrased as a
   compliment about the question's premise."*
3. **`unverifiable` is a first-class verdict**, reported in its own column,
   never folded into `upheld`. A compliance number that counts "could not
   tell" as a pass goes *up* as the checker degrades.

## Why not the alternatives

**Model-as-judge for everything.** Tempting, and it would make "never be
condescending" checkable-ish. It also doubles the cost of every turn, adds
a second non-determinism to a system whose tests must be deterministic, and
puts the agent in charge of grading itself against the contract that
constrains it. Rejected for M7. If it ever lands it belongs behind the same
`enforcement` field, as a fourth value that is honestly labelled "judged by
a model, which is not the same as checked".

**Only ship the checkable articles.** Then the contract is short, true and
useless: it would not contain "ask before acting on my behalf", because
that is enforced in the approval gate rather than by the text. The document
is also the place the *user* reads to learn what their agent is, and that
audience needs the structural ones most.

## The cost, stated plainly

Ten checks are ten regex-and-heuristic functions. `no-untrusted-obedience`
in particular detects refusal by keyword, so an agent that refuses in words
the list does not contain is scored as having obeyed. That is a false
*negative* on compliance, not a safety hole — the trust fence is what
actually stops the obedience — and it is written into the check's `misses`
string where the user can see it.
