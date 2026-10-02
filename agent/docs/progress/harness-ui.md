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

## Deferred

- **An import flow.** `agent.importAll()` exists and `POST /import` is
  marked surfaced, but import refuses a non-empty install by design
  (decision 038), so the only honest home for a button is a first-run
  screen that does not exist. The method is wired; the button waits.
- **A live tail on the log.** `GET /events` is a tail slice with no
  cursor. A poll loop on top of it would re-fetch the window to find one
  row and paper over the gap rather than close it. Refresh is a button
  until the route can express "since".

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
| agent tests | 838 | 839 |
| web tests | 140 | 148 |
| e2e | 125 passed / 13 skipped | 137 passed / 13 skipped |

`tsc` clean on both projects, `npx oxlint src e2e` 0 warnings 0 errors.
