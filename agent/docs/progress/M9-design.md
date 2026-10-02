# M9 — Hardening & portability: design note and test list

Written before the code, per §36. M9 is the last milestone, and it is the
only one whose subject is the whole system rather than a layer of it. §33
lists eleven things: *persona API, remaining endpoints, SSE resume, trace
endpoint, replay command, metrics, export/import, automated backup-restore
verification, chaos suite, 100k-event performance pass, failure-mode
documentation.* §34's thirteen-point definition of done is the real exit
criterion, so this note is organised around proving those points rather
than around the eleven features.

---

## What is already true

Ten of §34's thirteen are already asserted somewhere:

| §34 | Claim | Where it is proven today |
|-----|-------|--------------------------|
| 2 | Drop projections → rebuild → byte-identical | `test/integration/rebuild-identity.test.ts` |
| 3 | A tool plugin touches `src/tools/` + one line | `test/integration/plugin.test.ts` |
| 4 | Swap provider by config alone | `providers/`, composition root |
| 6 | No secret outside the vault, under fuzzing | `test/adversarial/secret-leakage.test.ts` |
| 7 | Injection corpus refused with the fence removed | `test/adversarial/injection-corpus.test.ts` |
| 8 | Read/edit/pin/destroy every belief; shred is provable | `test/integration/shred.test.ts`, M6 UI |
| 9 | Bitemporal both ways | `test/integration/bitemporal.test.ts` |
| 10 | Honesty/bias probes, calibration in threshold | M7 suite |
| 11 | 200 turns assembled in <100ms | `test/integration/context-perf.test.ts` |
| 12 | Offline, deterministic, <60s | the suite itself |

Three are **not**, and they are the spine of this milestone:

- **§34.1 — chaos.** Kill at any point across 200 randomized runs → every
  run resumable or cleanly failed, zero corrupt state, zero duplicated
  external effects. `approval-restart` and `outbox` test one path each;
  nothing randomizes the kill point.
- **§34.5 — `replay <runId>` reproduces any historical run with zero
  context diff.** No replay command exists.
- **§34.13 — for any sentence, a stored trace explains the context,
  memories, trust levels and tool results behind it.** `/runs/:id/trace`
  returns raw events; §30 asks for something a person can read.

Everything else in M9 exists to make those three honest, plus the
endpoints §29 lists that no milestone has needed yet.

---

## Shape

Nine pieces. Layers as always — nothing new reaches inward.

```
src/cognition/persona/        store.ts  template.ts   (L4)
src/observability/            trace.ts  metrics.ts    (L5)
src/portability/              export.ts import.ts backup.ts  (L5)
src/interface/http.ts         + persona, vault, export/import,
                                backup/verify, metrics routes
scripts/replay.ts             the replay command
test/chaos/                   randomized kill points
docs/failure-modes.md         what breaks, how it shows, what to do
```

`src/substrate/storage/schema/012-persona.ts` is the only new migration.
Export/import and the trace read the log and existing projections; they
add no tables, deliberately — a portability layer that needs its own
state is a portability layer that can disagree with the thing it exports.

---

## Positions

**1. Persona is voice, not rules — and it goes in the kernel block.**

§29 requires `GET/PUT /persona` and §5's layout has `cognition/persona/`,
but no section defines it and §21's fourteen blocks have no slot for it.
That is a gap, so it gets a decision note rather than a silent guess
(036). The position: the **constitution** is what the agent may and may
not do; the **identity card** is who the *user* is; the **persona** is how
the agent sounds — the name it answers to, how it addresses the person,
formality, length, whether it uses emoji, which language. It renders as a
handful of sentences appended to block 1, capped at `PERSONA_TOKENS=120`,
because voice that can be evicted is voice that changes under pressure,
and a person noticing their agent get colder as the context fills would
be right to call that a bug.

Persona is **user-editable only**. The agent cannot write its own voice;
that is the same reasoning as decision 035.

**2. The trace is rendered, not dumped.**

`GET /runs/:id/trace` keeps its JSON shape and gains `?format=text`, which
returns the thing §30 actually asks for: the assembled context with
per-block token counts, every model request and response, every tool call
with its result and timing, every recall with its component scores, the
trust level in force, and the cost. It is built from the log alone, so it
works for a run that finished a year ago, and it is the answer to "why did
it say that?" without a debugger.

**3. Replay is a diff, not a re-run.**

`npm run replay <runId>` rebuilds the context the run *would* assemble
today from the stored snapshot, compares it to the `context.assembled`
payload recorded at the time, and prints a block-by-block diff. Tool
results come from the log; the model is `FakeModel`, fed the recorded
responses. A zero diff means cognition has not drifted. A non-zero diff
exits 1 and prints what moved — that is the whole value: refactoring the
assembler is safe because the command tells you what you changed.

**4. Export is the log plus the sealed vault; import refuses to merge.**

`POST /export` writes one JSON document: every event with its hash chain,
the schema version, the persona, the constitution, and the vault's
**ciphertext** with its wrapped keys. Secret plaintext is not in it — §13
holds across the portability boundary, which means an export is useless
to a thief without the passphrase, and also means an import without the
passphrase restores everything except the ability to use secrets.

`POST /import` refuses to run against a non-empty log. Merging two event
logs means reconciling two hash chains and two ULID orderings, and a
half-merged personal agent is worse than a failed import. Into an empty
database it verifies the chain, replays the events, rebuilds every
projection, and compares the resulting projection digest to the one in
the export. Mismatch → nothing is written.

**5. "An untested backup is a rumor" (§13.5) is a route, not a README.**

`POST /backup/verify` copies the live database to a temp file, opens it as
a fresh substrate, verifies the hash chain, rebuilds all projections from
zero and compares the digest to the live one, reads back one known fact,
and reports. It runs on demand from the UI and is also what the chaos
suite calls after each kill.

**6. Metrics are computed from the log, with no counters in the hot path.**

`GET /metrics` derives everything from events: latency per stage, tokens,
cost, tool success rate, memory hit rate, context utilization, agreement
rate, calibration error, approval frequency. No in-memory counters, so the
numbers survive a restart and cannot drift from the record. §32's budgets
are attached to the latency numbers so the response says whether each one
is being met, not just what it is.

**7. The chaos suite kills in the only place a kill matters.**

Not `process.exit()` — a real kill cannot be observed from inside the
process it kills. Instead, the substrate is **closed** at a randomized
instruction boundary inside a run (between step persistence and the next
model call, mid-tool-invocation, between outbox intend and commit, …),
then reopened from the same file and the invariants checked: the chain
verifies, projections rebuild byte-identically, the run is either resumable
or cleanly failed, and every effect key appears **exactly once** in the
committed set. 200 iterations, seeded, so a failure is reproducible from
the seed printed in the message.

**8. The 100k pass runs, but not in the 60-second suite.**

§32 wants 100k events / 50k facts with no query above 100ms; §34.12 wants
the whole suite under 60 seconds offline. Both are real, so the big pass
lives in `npm run perf` (and a nightly CI job), while the suite keeps the
10k regression detector it already has. The alternative — one slow suite —
is how a team stops running its tests.

**9. The debts M7 and M8 wrote down get paid here, or get written down
again with a reason.**

- `effectsCommitted` is `[]` in the governance evidence. The outbox has
  the committed set; the runner can read it per step. Paid.
- `governance.contradicting` is `[]`. The recall path already computes a
  contradiction bonus; threading it through is small. Paid.
- `revise` is detected and reported but never executed. **Not paid, and
  deliberately**: a remedy that silently rewrites the model's words is a
  harder thing to make honest than it looks, and shipping it late in the
  last milestone is how you get an agent that edits itself badly. The
  reasoning goes in the progress note, not in a comment.

---

## Test list

Fifty-four tests. Grouped by what they protect, numbered for the commit
messages.

### Persona (unit, `test/unit/persona.test.ts`)

1. A fresh install has a default persona, and it is the plainest one.
2. `PUT /persona` validates: unknown fields rejected, lengths capped.
3. The persona renders as sentences, not JSON, and under 120 tokens.
4. An over-long persona is truncated at a sentence boundary, reported.
5. Persona is written as an event and survives a rebuild.
6. The agent cannot write its own persona (no capability, no tool).
7. Changing the persona bumps the context digest — voice is part of the
   contract, so the change is visible in the trace.
8. A persona that tries to contain instructions ("ignore your
   constitution") is still only rendered as voice, below the kernel's own
   rules, and the constitution still wins.

### Trace (integration, `test/integration/trace.test.ts`)

9. `?format=json` keeps the existing shape (nothing downstream breaks).
10. `?format=text` renders blocks with token counts.
11. …every model call, with tokens and cost.
12. …every tool call, with duration, trust level and ok/failed.
13. …every recall with its component scores.
14. A run with an approval shows the suspension and who decided it.
15. A trace for a run that was never streamed still renders (log-only).
16. 404 for an unknown run; no information leak in the body.
17. The trace of a run containing a secret reference shows the reference,
    never the value.
18. §34.13: for a sampled sentence from a finished run, the trace contains
    the context, the memories, the trust levels and the tool results
    behind it — asserted structurally, not by eyeballing.

### Replay (integration, `test/integration/replay.test.ts`)

19. Replaying a finished run produces zero context diff.
20. A deliberate template change makes the diff non-empty and names the
    block that moved.
21. Replay uses recorded tool results — no tool is actually invoked.
22. Replay never writes to the log it is replaying.
23. Replaying an unknown run id fails cleanly with a message.
24. Replaying a suspended run replays up to the suspension and says so.

### Metrics (integration, `test/integration/metrics.test.ts`)

25. Every §30 metric is present and typed.
26. Latency percentiles are computed from the log, not from counters.
27. Each §32 budget is reported as met / not met with its threshold.
28. Metrics on an empty install are zeros and nulls, never NaN.
29. Tool success rate counts denials as denials, not as failures.
30. Memory hit rate is recalls-used over recalls-offered, and says so.

### Export / import (integration, `test/integration/portability.test.ts`)

31. Export → import into an empty database → projection digests match.
32. The export contains no secret plaintext, under the leakage fuzzer.
33. Import into a non-empty database is refused, with the reason.
34. A tampered export (one byte in one payload) fails chain verification
    and writes nothing.
35. An export from an older schema version imports and migrates.
36. Round-tripping preserves memory, the constitution, persona and
    schedules — asserted per-store, not by file size.
37. Import is atomic: a failure mid-way leaves an empty database.

### Backup verification (integration, `test/integration/backup.test.ts`)

38. `POST /backup/verify` on a healthy database reports healthy, with
    counts.
39. It rebuilds projections from zero and compares digests.
40. A corrupted copy is reported as corrupt, with the first bad seq.
41. Verification never mutates the live database.
42. It works while the agent is running (no exclusive lock).

### Chaos (`test/chaos/kill-points.test.ts`)

43. 200 seeded iterations, each killing at a different instruction
    boundary: the chain verifies every time.
44. …projections rebuild byte-identically every time.
45. …every run is resumable or cleanly failed — never "running" with no
    process.
46. …no effect key is committed twice (§34.1, §34.10).
47. A kill between `effect.intended` and the effect itself leaves the
    effect uncommitted and reconcilable.
48. A kill during a schedule fire does not double-fire the slot.
49. The seed is printed on failure so the case is reproducible.

### Endpoints (integration, extends `test/integration/http.test.ts`)

50. Vault routes: list returns names and metadata only, never values.
51. `POST /vault/lock` then any secret use fails with `LockedError`
    surfaced as 423, not 500.
52. `POST /vault/panic` is irreversible and says so before it happens.
53. SSE resume: disconnect mid-run, reconnect with `Last-Event-ID`, no
    output lost and no frame duplicated.
54. Every route in §29 either exists or is listed in the progress note
    with a reason — asserted by a test that walks the spec's own list.

---

## What is deliberately not built

- **No merge on import.** Covered above.
- **No remote backup.** §13.5 is about verification, not about shipping
  the database somewhere; a sync target is a product decision and a new
  threat model.
- **No metrics push / Prometheus endpoint.** `GET /metrics` returns JSON
  for the UI. A scrape format is a deployment concern for a system that
  is not deployed.
- **No `revise` execution.** Reasoned above.
- **No multi-worker chaos.** One worker exists; killing two is a test of
  code that is not written.
