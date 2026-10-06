# CURRENT

The file Appendix F asks for. Read this first; it is the only place that
claims to say where things stand.

**Last verified by running:** `npm run check` → **451 tests, 36 files, 16.2s**
(60s budget), `tsc --noEmit` exit 0, `eslint . --max-warnings 0` clean.
`./docs/progress/M2-demo.sh` green against the built binary, eight steps.

---

## Where we are

| Milestone | State |
| --- | --- |
| **M0 — Substrate** | **Complete.** Committed `dbbc465`. |
| **M1 — Security** | **Complete.** Committed `862c919`. |
| **Onboarding + Cognitive Jobs** | **Complete, out of band.** Decision 008 — the milestone order was broken deliberately and recorded. See `ONBOARDING.md`. |
| **Browser use** | **Complete, out of band.** Decisions 009 + 010. See `BROWSER.md`. HTML stack, agent view, sealed plan, 15-shape attack corpus, a browser UI, and a full audit trail. |
| **Tool audit trail** | **Complete.** Decision 010 — browsing is a run, an action is a tool call. Schema v6, `tool_calls` projection. Proven at **100 sessions**: replay is byte-identical, the chain holds, no run dangles. |
| **M2 — Memory** | **Complete.** Schema v7, two new projections, the bitemporal store, entities, items, ingestion, consolidation, recall, `arish memory`. Decision 011. See `M2.md`. |
| M3 — Tools and effects | **Not started. Next.** |
| M4 → M10 | Not started, not scaffolded (§61). |

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

**Begin M3 — Tools and effects, by writing its test list before any
implementation.**

Nothing is outstanding ahead of it. M2 closed both of the notes this file
had been carrying since M1: item content has a home (`item_blobs`, sealed,
not a projection), and every extractor now runs inside the quarantine when
its input is FOREIGN.

Three things M3 inherits and should not rebuild:

1. **The tool-call audit trail already exists.** `tool.invoked /
   succeeded / failed / denied` have schemas, a `tool_calls` projection and
   100 sessions of proof (decision 010). M3 generalises the browser's use
   of it; it does not invent a new shape.
2. **The Rule of Two gate is built and swept** (891 cases). M3 wires more
   tools into it rather than writing another check.
3. **`ItemStore.shred` has no CLI door**, because there is no
   `arish vault unlock` by design. If M3 wants one, that is a daemon
   question and belongs to M7.

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
bash docs/progress/BROWSER-demo.sh # sealed plan, injection, Rule of Two
bash docs/progress/M2-demo.sh      # two timelines, forgetting, FOREIGN facts
npm start -- serve                 # 127.0.0.1:8787 — Get Started, and
                                   # /browser.html for the browser surface
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
  and a model page that echoed a pasted API key back. The browser work then
  shipped five more into a green suite — a plan that could never take its
  first step, a click that escaped an origin pin, `<button>` mis-tiered as
  an interaction, a page title that was always empty, and an approval
  checkbox that never showed whether you had approved. Then the audit
  trail shipped one more into a green suite — a refusal written onto the
  *previous* action's row, which four `curl`s against a real server found
  immediately. Drive the thing.
- **A projection added to `PROJECTION_TABLES` must be fed by the 10k
  workload.** The M0 gate asserts every table has rows *before* comparing,
  precisely so a new empty table cannot pass by comparing emptiness to
  emptiness. It has now caught a real problem twice.
- **`.toThrow()` with no argument asserts almost nothing.** A browser test
  that proved a click could not leave its origin was passing because the
  static driver happened not to hold the target page. The hole it was
  guarding was real and open. Assert the refusal *text*.
- **A floor and a scale are not the same number.** M2 scaled a FOREIGN
  fact's confidence *before* comparing it to the confidence floor, so every
  web-page fact was silently dropped and FOREIGN ingestion was dead code —
  while every trust test still passed, because they described what a stored
  FOREIGN fact looks like without checking one ever arrived. Assert that the
  thing *arrives*, not only that it looks right if it does.
- **A tool that cannot be piped into `head` is not a Unix tool.** `grep -q`
  closing the pipe killed the CLI with an unhandled EPIPE. Both output
  streams now ignore it.
- **Verify by running.** `npm run check` is the only thing that gets to say
  something works. Two of M1's genuine defects — the readline buffering hang
  and the quarantine passthrough leak — were invisible to review and obvious
  to execution.
