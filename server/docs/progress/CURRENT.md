# Where this is

**M0, M1, M2 and M3 are complete.** The browser-use subsystem and the Get
Started onboarding UI ship alongside them (decisions 008–010).

Last verified by running, not by assuming:

```
npx tsc --noEmit     clean
npm run lint         clean (0 disables in the project)
npx vitest run       43 files, 535 tests, 16.8 s
bash docs/progress/M3-demo.sh   runs end to end
```

## The next concrete action

**M4 — the security envelope in anger**, per the spec's milestone list. Before
writing any of it:

1. Write `docs/progress/M4-tests.md` first, as every milestone has.
2. Re-read §20, §21 and decision 007: M4 is where the quarantine's dual-path
   channel meets the executor, and where `capture.*` events stop being
   M2-shaped.

## Two things to raise with the user

1. **The §49 Veo collision (decision 001) must be raised before M7.** The spec
   allows exactly eleven Veo files to be touched; three of them
   (`MemoryPanel.tsx`, `store.tsx`, `seed.ts`) already exist with other
   content, and the dev proxy is on **7777**, not the 8787 the spec names.
   A twelfth file means stop and report — so this needs an answer, not a
   guess.
2. **Nothing is pushed.** The repo is **6 commits ahead** of
   `MITfellow/veo` `main` (M0, M1, onboarding+jobs, browser use, audit trail,
   M2 — plus M3 when it lands). The user has confirmed the same PAT may be
   reused; it is never written to disk.

## Standing rules for this repo

- `server/` never imports from `../src` or `agent/`.
- No model, no provider SDK, no network inference call, ever. Every
  model-shaped function is a Cognitive Job with a deterministic baseline and
  an inert, contract-tested `ModelStrategy`. Attaching a model is config-only.
- A test list is written **before** the implementation, every milestone. Never
  weaken, skip or `.only` a test. If a test fails, the implementation is
  wrong until proven otherwise.
- Ports, not globals. `Date.now`, `Math.random`, `crypto.randomUUID`, `fetch`,
  `process.env` and `node:fs` appear only in `substrate/` and `test/fakes/`,
  and a structural test re-checks it independently of ESLint.
- A lint ceiling is a design signal. Nine have been hit; all nine dissolved
  into a better shape. Still zero `eslint-disable`.
- Git identity is not persisted in this sandbox:
  `git -c user.name="Veo" -c user.email="veo@local" commit`.
