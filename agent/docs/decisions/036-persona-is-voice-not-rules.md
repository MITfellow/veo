# 036 — Persona is voice, and it lives in the kernel block

**Status:** accepted · **Milestone:** M9 · **Spec:** §5, §21, §29

## The ambiguity

§29 requires `GET/PUT /persona` and §5's directory layout has
`cognition/persona/`. No section of the spec says what a persona *is*,
and §21's fourteen context blocks have no slot for one. Three things in
this system already describe a person, so a fourth needs a sharp
boundary or it becomes a dumping ground.

## The decision

- the **constitution** is what the agent may and may not do;
- the **identity card** is who the *user* is;
- the **persona** is how the agent sounds.

Six fields: the name it answers to, what it calls the person, formality,
length, emoji, language, plus a short free-text note. Rendered as
sentences — "Be warm, but never flattering" rather than
`{"formality":"warm"}` — because a model that is told a thing does not
have to infer it, and because the person whose agent it is can read the
result.

It renders **inside block 1, the kernel**, as a second item. Not a new
block, because inventing a fifteenth block is a change to §21 that this
milestone has no reason to make; and not an evictable one, because voice
that disappears under context pressure is an agent that gets colder as
the conversation gets longer, which a user would rightly report as a bug.

The cost is bounded by the field lengths rather than by truncating at
render time: the editor refuses the 41st character of a name, instead of
the agent quietly dropping a sentence later. `PERSONA_MAX_TOKENS = 200`
is what the largest persona the schema permits actually costs, and a test
asserts it so it cannot drift upward unnoticed.

## User-editable only

There is no persona tool and no capability that reaches this event. The
reasoning is decision 035's, one step further: an agent that can restyle
itself in response to content it has read has a tone that is an injection
surface. The store writes `persona.updated` at USER trust regardless of
its caller.

## What this rules out

A persona cannot contain rules. A user who writes "never mention
confidence levels" in the notes field gets it rendered — hiding what the
user typed would be its own dishonesty — but the constitution renders
*after* it, carries the sentinel the enforcement gate checks, and is what
the checks actually read. Test 8 asserts exactly that ordering.
