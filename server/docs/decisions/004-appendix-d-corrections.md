# 004 — Three corrections to Appendix D, found by running it

**Status:** accepted
**Date:** 2026-10-04

§24 of Appendix E and §61 both say: if the specification is wrong once you are
in the code, say so with reasoning and proceed with the alternative. These are
three places where Appendix D does not work as written. All are mechanical;
none change the architecture.

## 1. `bin` points at a path the build never produces

Appendix D.1 declares `"bin": { "arish": "./dist/interface/cli.js" }` and D.2
declares `"rootDir": "."` with `"include": ["src", "test"]`.

With `rootDir: "."`, `tsc` preserves the `src/` prefix, so the compiler emits
`dist/src/interface/cli.js`. The declared `bin` path does not exist after a
clean build, and `npx arish` fails with a module-not-found error.

**Decision:** correct the three affected paths (`bin`, `start`, `dev`) to
`dist/src/interface/cli.js`. The alternative — setting `rootDir: "src"` — would
match the spec's `bin` path but exclude `test/` from the program, which breaks
typechecking of the test suite. Keeping the strict typecheck over the tests is
worth more than the shorter path.

## 2. `lint` globs a directory that must not exist yet

D.1 declares `"lint": "eslint src test examples --max-warnings 0"`. ESLint 9
treats a non-matching pattern as a hard error, and `examples/` cannot exist in
M0 — §61 forbids scaffolding a later milestone's directory, and `examples/`
belongs to M2.

**Decision:** `"lint": "eslint . --max-warnings 0"`, with `dist/`,
`node_modules/` and the two config files ignored in the flat config. This lints
strictly more than the original (it will pick up `examples/` automatically the
moment M2 creates it) and does not require an empty placeholder directory.

## 3. The `dev` script needs Node 22

Covered separately in decision 002.

## Consequences

`npm run check` is green on the scaffold, which D.5 calls the first milestone
gate. `npx arish doctor` runs. None of this touches the layer rules, the
banned-globals rules, or the two-dependency budget, which are the parts of
Appendix D that carry architectural weight.
