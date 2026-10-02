# S1 — Skills: what the agent can now actually do

The design note (`S1-skills-design.md`) was written first, with the 42
tests listed before any code. All 42 exist and pass. This note records
what was built, what was found on the way, and what was not built.

## Built

Nine tools, no connectors, no network, no third-party credential.

| Tool | Trust | Risk | What it is for |
| --- | --- | --- | --- |
| `calendar.add` | DERIVED | caution | Put something in the calendar |
| `calendar.list` | DERIVED | safe | What is on, for a day or a range |
| `calendar.find` | DERIVED | safe | Find it by a word, when the date is unknown |
| `calendar.cancel` | **USER** | dangerous | Take something out, with a preview |
| `math.eval` | FOREIGN | safe | Exact arithmetic |
| `time.convert` | FOREIGN | safe | A time, in another zone, across DST |
| `time.until` | FOREIGN | safe | How long until, or since |
| `notes.list` | DERIVED | safe | What notes exist |
| `notes.search` | DERIVED | safe | Which note said that |

Supporting work: schema `014-calendar`, `calendar.added` /
`calendar.cancelled` events, `calendarProjector` (registered in
`ALL_PROJECTORS`), `CalendarStore`, two new capabilities
(`calendar:read`, `calendar:write`) in the trust ceiling, three HTTP
routes (`GET`/`POST /calendar`, `DELETE /calendar/:id`), three client
methods, and `CalendarPanel` in Settings.

**Counts at the end of S1:** agent 902 / 83 files (was 846 / 79), web
159 / 15, e2e 145 passed + 13 skipped (was 139), `tsc` clean both sides,
oxlint 0/0.

## The deviation, restated

The spec's "no calendar" rule is about *connectors*: no Google account,
no CalDAV, no OAuth token, nothing that syncs. A calendar the agent owns
inside its own event log is a different object, and the user asked for
it explicitly. It is built on the same substrate as memory and
schedules, which is why `rebuild()` reproduces it (test 29) and why it
appears in an export. Nothing in S1 opens a socket.

## What the tests found

Five real defects, all caught by tests written before the code was run
and all fixed in the code rather than in the test:

1. **`-2^2` returned `4`.** The first grammar had `power()` call
   `unary()` for its base, making it `(-2)^2`. Exponentiation binds
   tighter than unary minus. The wrong answer looked exactly like an
   answer, which is the whole category this tool exists to prevent.
2. **`Date.parse('next tuesday-ish:00Z')` returns 2000-01-01.** V8 falls
   back to a lenient implementation-defined parser rather than failing,
   so a date the agent could not understand would have been filed
   twenty-six years in the past. `zonedToUtc` now matches a strict ISO
   wall-clock pattern first.
3. **`CalendarStore.get()` ignored the principal**, and `cancel()` was
   built on it — so anyone who could guess an id could cancel someone
   else's appointment. Now scoped, with a test that tries it.
4. **`MAX_LENGTH` lived only in the zod schema**, so the exported
   `evaluate()` would happily parse a ten-thousand-character expression.
   The limit is enforced in the evaluator too.
5. **`calendar.cancel` had no `dryRun`**, which the tool contract caught
   at registration — `risk: 'dangerous'` requires one. The preview now
   names the event and its date, because "cancel C-01J8…" is not
   something a person can meaningfully approve.

One ambiguity went to `docs/decisions/040-percent-is-contextual.md`:
`250 + 8%` means 270, not 250.08.

## Positions worth re-reading

- **`add` is DERIVED, `cancel` is USER.** The agent may put something in
  your calendar — visible and reversible. Removing something you put
  there is not its call. This is decision 035's reasoning
  (DERIVED cannot create a schedule) applied to a weaker case.
- **Overlaps are reported, never refused.** Double-booking is sometimes
  deliberate, and a calendar that forbids it is one people work around.
- **Nothing is deleted.** `cancel` stamps `cancelled_at`. "What was on
  my calendar in July" stays answerable after the thing is called off.
- **Every skill reads `ctx.now()`.** A tool that reads the real clock
  passes its tests today and breaks §30 replay silently. Test 17 asserts
  it by running the same input at two different injected nows.

## Not built

- **Reminders.** A calendar that can fire a notification needs
  `clock.schedule`, a worker that owns it, and a decision about what
  happens to a reminder for an event that moved. Deferred deliberately,
  not forgotten — it is the obvious next thing and it is a milestone of
  its own, not a tail end of this one.
- **Recurrence (RRULE).** "Every second Tuesday" is a parser, an
  expansion strategy and an exception model. `schedules` already has
  cron for the agent's own recurring work; a user-facing recurring
  *event* is different and bigger.
- **Invitees and sharing.** Both imply sending, which implies a
  connector.
- **`conversation.search`.** Still wanted, still blocked on its own
  migration: `facts_fts` is the only FTS table and messages are not
  indexed. Tracked in `failure-modes.md`.

## Unsure

- **The two-week horizon in `CalendarPanel`** is a guess. It is the
  range most people can act on, but it is not grounded in anything
  measured, and a month view may turn out to be wanted.
- **`find` is `LIKE`, not FTS.** Fine at the scale of one person's
  calendar; it will not rank, and it will not match stems. If the
  calendar ever gets big this becomes the slow path.
- **All-day events are stored as a 24-hour span in a stated zone.** That
  is right for "a holiday where I am" and subtly wrong for "a holiday,
  everywhere" — a distinction the model will eventually hit.
