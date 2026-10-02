# 030 — The constitution is structured articles, not a block of prose

**Status:** accepted · **Milestone:** M7 · **Spec:** §25, §21.2

## The ambiguity

§25 describes the constitution as "a short, user-editable behavioural
contract that outranks learned behavior", and §21 block 2 renders it as a
text block. Read literally, that is a textarea: the user types a paragraph,
the paragraph goes into the prompt, done. That is also how every "custom
instructions" box in the industry works.

But §25 also asks for three things a paragraph cannot provide:

- that user rules **outrank** founding ones — precedence needs two
  identifiable things to order;
- that the user can see **when** behaviour changed and why — versioning
  needs an identity per rule, not per document;
- that violations are **detected** — a check has to attach to something.

## The decision

An article is a record: `{id, text, origin, kind, enforcement, check,
remedy, subject, stance, entrenched, cites}`. The document is an ordered
list of them plus a hash. Precedence is `entrenched → user → founding →
learned`. Conflict detection is lexical and deliberately shallow: same
non-`general` `subject`, opposing `require`/`forbid`.

The user still only ever types a sentence. Everything else is inferred or
defaulted — an article created through the API is `advisory`, `general`,
`require`, with the user's own text as its `cites`.

## Why not the alternatives

**Free prose.** Then "your rules win" can only be implemented by putting the
user's paragraph after the agent's and hoping. There is no way to show the
overridden default, no way to count compliance per rule, and no way to
refuse to delete the four rules the code actually enforces.

**Ask a model to structure the prose.** It would work most of the time. The
failure mode is that the document describing what the agent may do is itself
produced by the agent, which is the one place in the system where that is
unacceptable.

**Let the user write the structured form.** Nobody is going to fill in a
`stance` dropdown to tell their assistant to stop being smarmy.

## The cost, stated plainly

Shallow conflict detection misses real conflicts. "Be concise" (subject
`style`) and "always explain your reasoning" (subject `general`) contradict
each other and this system will not notice. The honest position is that the
precedence machinery is for the conflicts it *can* see, and the model is
told to say so out loud when it spots one the machinery missed — which is a
weaker guarantee and is labelled as one in the panel.
