# 020 — Tool parameters are derived from the zod schema, not hand-written

**Status:** accepted · **Milestone:** M3

## What was wrong

`ToolRegistry.specsFor` advertised every tool to the model as
`parameters: { type: 'object' }`. Technically true, operationally useless: the
model had to guess argument names, guessed wrong, and the call failed input
validation. The schema existed and did no work at the one boundary where it
would have prevented the error.

It also violated §36's "schemas are the single definition" — the real
definition was in zod, and the model was shown something else.

## The decision

A ~120-line `jsonSchemaOf()` in `src/capability/schema-json.ts` converts the
tool's input schema to JSON Schema at describe time. Field descriptions
(`.describe(...)`) travel into the prompt. Fields with `.default()` are not
marked required, because the default is the point. `additionalProperties` is
`false`, so a typo'd argument is visibly rejected rather than silently dropped.

## Why not `zod-to-json-schema`

§36: no dependency without justification. The package is good and general; we
need the dozen constructs our own tools actually use, in a file we can read in
one sitting, with no transitive surface and no version coupling to zod's
internals beyond what we already have. Anything the converter does not
recognise degrades to `{}` — unconstrained in the prompt, still fully
validated at runtime. The failure direction is "the model gets less help",
never "an invalid call gets through".

Revisit if tool schemas start using recursion or `z.lazy`.
