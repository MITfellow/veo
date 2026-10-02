# Connecting the whole harness to the whole UI

Design note and test list: `harness-ui-design.md`, written first.

## Built

**The audit itself.** `test/integration/wiring.test.ts` now runs in both
directions: every route the agent serves must be reachable from the Veo
client, or named in `UNSURFACED` with a written reason (decision 039).
It found **thirteen** unreachable routes, twelve on the first run and
`/memory/identity-card` on the run after the first eleven were wired.

**The vault (§13), which had no UI at all.** `VaultPanel` — state,
create/unlock/lock, the one-time recovery code, add/rotate/destroy a
secret, and panic behind the literal sentence the server demands. The
consequence of the gap was concrete and had been mistaken for a config
quirk: no way to store a model API key except an environment variable,
which is why every install anyone ran sat at L2 on the offline fallback.
A value is write-only in the UI by construction — `SecretView` has no
`value` field to render even if a server started sending one, and an
e2e test greps the whole DOM for the plaintext it just typed.

**The log (§30).** `EventLogPanel` — the event log, grouped filters
(conversation / model / tools / memory / safety), one-line summaries,
the payload on expand. Everything else on the settings screen is a
projection of these rows and none of them could be checked against their
source.

**"Why did it say that?" (§30).** `TraceSheet`, opened from the bubble it
explains — the join is `Message.runId`, one optional field, so nobody
has to match run ids by eye. Shows the context block by block with a bar
per block, what was recalled, what the model was asked, what tools ran,
what was approved, what the constitution said, and the full text form on
demand. Both renderings come from the same events server-side, so they
cannot tell different stories.

**Stopping a run (§29).** `POST /runs/:id/cancel` had existed since M2
and nothing called it. The composer now shows a stop button while a run
is in flight, driven by `runningRun(chatId)` on the store.

**Four stream frames the client parsed and threw away.** `step-done`,
`cancelled`, `resumed` and — the one that mattered — `degraded`. §27's
whole argument is that the agent says so when it is working with less; a
UI that drops the frame turns that into a comfortable lie. A degradation
now writes a system line into the transcript, next to the answer it
affected, where it stays.

**Dead letters are replayable.** `SchedulePanel` reads
`/jobs/dead-letter` (which carries the error and the death time that the
jobs row does not) and offers "Try it again" per letter. Failed-but-
retrying jobs are now reported separately from dead ones.

**The identity card's budget.** `/memory/identity-card` states the cap
the context actually applies; `MemoryPanel` shows "N of 400 tokens", so
a person reading their identity card knows they are seeing all of it.

**Twelve client methods, four handlers, 16 unit tests, 6 e2e tests.**

## Found

- **The vault panel lied for a moment.** It rendered "No vault yet"
  before the first response came back, which an e2e test caught by
  acting on it. Fixed with an explicit `loaded` state — "Checking…"
  until it has actually asked. The same bug would have shown a user the
  create-a-vault form over a vault that already existed.
- **A literal in an older test encoded an assumption that stopped being
  true.** `schedules.spec.ts` asserted the degradation banner reads
  `L2`. §27 defines the level as the maximum over live signals, so that
  only held while the model was the only degraded thing — and it stopped
  holding the moment the UI could create a keyring (a locked vault is
  L4). Not weakened: the test now asserts the banner agrees with
  `/degradation`, which is order-independent and a stronger claim,
  because it catches the UI and the ladder disagreeing.
- Two routes I was prepared to wire and did not: see UNSURFACED.

## The cursor, and the live tail it was blocking

The deferral above did not survive the day, which is the right outcome:
the honest fix was the route, not a timer around it.

`GET /events` now takes **`sinceSeq`**, exclusive, and returns
`{ total, events, nextSeq, hasMore }`. The server hands the cursor back
rather than making every client derive `max(seq)` of a possibly empty
page — the thing everyone gets wrong once. A cursor is the natural shape
for an append-only log: `seq` is monotonic, so a page can never shift
under a reader the way an offset into a mutable table can.

Paging also moved into SQL. The route used to read **every** matching
row and slice the array in JavaScript. `EventLog` gained
`count(query)` — the existing no-argument `count()` widened rather than a
second method — and `read`/`count` now share one `filter()` so their
WHERE clauses cannot drift.

Measured at 150,000 events, through the HTTP route:

| | before | after |
| --- | --- | --- |
| newest page (limit 100) | ~1.6s | **6.1ms** |
| cursor tick, nothing new | not possible | **3.1ms** |
| cursor tick, 100 new | not possible | **3.3ms** |
| filtered page | ~1.6s | **4.3ms** |

That is what makes following honest: a tick on an idle agent is one
query that matches nothing. `EventLogPanel` has a **Follow** toggle
polling every 2s from the cursor, capped at 400 rows in the DOM, with a
dropped tick ignored rather than bannered — the cursor has not moved, so
the next tick recovers and nothing is lost. An e2e test switches it on,
posts a real turn through the proxy, and waits for rows to arrive with
no reload and no refresh click.

Seven integration tests cover the cursor, including the property that
matters: **paging start to finish yields every event exactly once**, no
gap and no repeat, whatever the page size.

## Deferred

- **An import flow.** `agent.importAll()` exists and `POST /import` is
  marked surfaced, but import refuses a non-empty install by design
  (decision 038), so the only honest home for a button is a first-run
  screen that does not exist. The method is wired; the button waits.

## Unsure

- The trace sheet renders eight sections and most runs populate three.
  It may read as mostly-empty on a simple turn. The alternative — hiding
  sections that are empty, which it already does — risks a user thinking
  a stage never ran when it merely produced nothing. Currently erring
  toward showing less; worth watching once a real model is attached and
  runs get longer.
- The stop button replaces the send button rather than sitting beside
  it. It is the right target size and the right place for the hand, but
  it means you cannot queue the next message while a run finishes. That
  may be the wrong trade for a fast model.

## Numbers

| | before | after |
| --- | --- | --- |
| agent routes reachable from the UI | 36 of 50 | 46, + 4 exempted with reasons |
| stream frames handled | 7 of 11 | 11 |
| agent tests | 838 | 846 |
| web tests | 140 | 159 |
| e2e | 125 passed / 13 skipped | 139 passed / 13 skipped |
| `GET /events` at 150k events | ~1.6s | 3–6ms |

`tsc` clean on both projects, `npx oxlint src e2e` 0 warnings 0 errors.

### One number that is out of budget, and it is not the code

The agent suite now runs in **65s** against the spec's 60s. It is not
this work: the box was rebuilt mid-session (dependencies had to be
reinstalled twice) and everything DB-heavy got ~30% slower with it.
`test/chaos/kill-points.test.ts` is the control — untouched by any of
this, recorded at 1.8s in M9, now 2.3–2.6s. The seven new tests add
about 30ms between them. Flagged rather than fudged; the budget is real
and should be re-measured on a quiet machine before anyone trims a test
to meet it.

### A latent flake this surfaced

`first-run.spec.ts` asserted the persisted envelope 300ms after load.
The save is debounced, so on a loaded machine it could read an
unflushed store and see no chats — it failed once in a full run and
passed alone every time. Now it polls for the write instead of assuming
a duration. The claim is unchanged (`chats === ['c-agent']`, no
messages); only the timing assumption is gone.
