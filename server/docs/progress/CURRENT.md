# CURRENT

The file Appendix F asks for. Read this first; it is the only place that
claims to say where things stand.

**Last verified by running:** `npm run check` → **244 tests, 25 files, 10.5s**
(60s budget), `tsc --noEmit` exit 0, `eslint . --max-warnings 0` clean.

---

## Where we are

| Milestone | State |
| --- | --- |
| **M0 — Substrate** | **Complete.** Committed `dbbc465`. |
| **M1 — Security** | **Complete.** Committed `862c919`. |
| **Onboarding + Cognitive Jobs** | **Complete, out of band.** Decision 008 — the milestone order was broken deliberately and recorded. See `ONBOARDING.md`. |
| M2 — Memory | **Not started. Next.** |
| M3 → M10 | Not started, not scaffolded (§61). |

No model is configured, and none can be. `arish doctor` asserts this as a
check rather than a comment, and now has something concrete behind it:

```
ok    jobs         11 cognitive jobs, all on deterministic baselines
ok    connectors   5 ready, 7 blocked on network/OAuth
ok    model        none configured — L1, the intended state of this build
```

Attaching a model is one config object plus one function
(`ModelProvider = (request) => Promise<string>`). The prompts, parsers,
schemas and budgets for all eleven jobs exist and are tested, including
against a fake provider.

## The next concrete action

**Begin M2 — Memory, by writing its test list before any implementation.**

The onboarding detour is closed. M2 now inherits working `memory.extract`,
`memory.consolidate` and `entity.resolve` baselines, so its surface is
smaller than it was.

M2 owns the bitemporal fact store on top of M0's `facts` projection, entity
resolution, and the memory lifecycle. Two things from M1 feed straight into
it and should be settled while writing the list:

1. **Item content belongs to M2 but item keys belong to M1.** `vault.sealItem`
   / `openItem` / `shred` exist and are tested, with no store above them. M2
   is what makes `arish vault forget` reachable from the CLI, and the key id
   convention (`note:diary` in the demo) needs deciding properly.
2. **Decision 007 constrains every extractor M2 writes.** An extraction may
   carry bounded scalars, never a span of its source. `memory.extract` is a
   Cognitive Job whose baseline must respect this, because its model
   strategy in M4 certainly will not do so unprompted.

## Before M7, stop and ask

**Decision 001 flags a real collision and it has not been raised yet.**

§49 lists eleven Veo files that may be touched. Three of them already exist
with different contents (`MemoryPanel.tsx`, `store.tsx`, `seed.ts`), and
`vite.config.ts` proxies to **7777**, not the 8787 the spec names. A twelfth
file means stop and report (§49), so this must be put to the user **before
M7 begins**, not discovered during it.

## How to check any of this yourself

```bash
cd server
npm install
npm run check                      # the gate: typecheck, lint, 195 tests
npm run build
bash docs/progress/M0-demo.sh      # 10k events, rebuild, tamper, SIGKILL
bash docs/progress/M1-demo.sh      # vault, shredding, chain tamper
npm start -- serve                 # the Get Started UI on 127.0.0.1:8787
```

Both demos run the real built binary against real SQLite files in `/tmp`.

## Standing rules I keep having to re-read

- **Never weaken, skip or `.only` a test.** When an M0 test failed because
  M1 registered the schema it asserted was absent, the fix was to repoint it
  at an M5 event type, not to delete it. The assertion still has a job.
- **A structural test needs a negative control.** `containment.test.ts` had
  a regex typo that made it match nothing and pass forever. It now tests its
  own detector first.
- **A green suite is not a working feature.** The onboarding work shipped
  three bugs that review missed and the browser found in seconds: a fact
  extractor that matched nothing, an `innerHTML` that swallowed `<name>`,
  and a model page that echoed a pasted API key back. Drive the thing.
- **Verify by running.** `npm run check` is the only thing that gets to say
  something works. Two of M1's genuine defects — the readline buffering hang
  and the quarantine passthrough leak — were invisible to review and obvious
  to execution.
