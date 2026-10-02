# S1 — Skills: things the agent can actually do, with nothing plugged in

Written before the code, per §36.

## The deviation, stated out loud

The original scope said **no calendar** and no integrations. That rule
was about *connectors* — Google Calendar, Outlook, an OAuth dance, a
third party holding the data. The user has asked for a calendar that
needs none of that.

A calendar the agent owns, in its own event log, is not an integration.
It is the same shape as memory, schedules and persona: events in,
projection out, rebuildable from the log. So S1 builds it, and this
paragraph is the record that the earlier "no calendar" line was
narrowed deliberately rather than forgotten. **Still excluded:** any
sync with an external service, any network call, any credential to a
third party.

## The complaint

The agent has eleven tools. Seven are `memory.*`, one reads the clock,
one expands history, two touch notes, one lists vault names. Nothing it
can do is *useful on its own*. Ask it what is on today and it has no
idea what "on" means; ask it to add seventeen percent to a number and it
does what every language model does, which is guess confidently.

A skill here means: deterministic, local, no network, and correct
whether or not a model is attached.

## What S1 builds

### Calendar — the agent's own, event-sourced

Four tools: `calendar.add`, `calendar.list`, `calendar.find`,
`calendar.cancel`.

- Migration **014**, table `calendar_events`.
- Event types `calendar.added`, `calendar.cancelled`.
- Projector `calendar`, registered with the rest.
- `CalendarStore` in `src/cognition/calendar/store.ts`.
- `GET/POST/DELETE /calendar` + a `CalendarPanel` in the UI, because the
  reverse wiring audit (decision 039) fails a route no UI can reach —
  which is the point of having written it.

### Arithmetic — `math.eval`

A real recursive-descent parser over `+ - * / % ^`, parentheses and a
short function list. **No `eval`, no `Function`, no regex-and-hope.** A
tool that can execute arbitrary strings is an RCE with a friendly name,
and this one takes input from a model that takes input from the web.

### Time — `time.convert`, `time.until`

Timezone conversion and duration arithmetic from the injected clock.
The scheduler already does DST correctly by wall clock; this exposes the
same reasoning to the model instead of making it do date maths in prose.

### Notes — `notes.list`, `notes.search`

`notes.read`/`notes.write` have existed since M2 and there is no way to
discover a note's name. A store you can only read by guessing the key is
a store you cannot use. `FileStore.list(prefix)` already exists.

## Five positions

1. **Every skill is deterministic and replayable.** No skill reads
   `Date.now()`, a random source, or the network — they take the
   injected clock, as `clock.now` does. A tool that is not replayable
   silently breaks §30's replay guarantee for every run that used it.

2. **The calendar is events, not rows.** It would be faster to write a
   table and `INSERT`. Then "what did my calendar look like in March"
   becomes unanswerable and `rebuild()` loses data, breaking invariant 1.
   `calendar.cancel` closes an event rather than deleting the row, the
   same way `memory.superseded` closes valid time.

3. **`calendar.add` is `caution`, not `safe`, and `calendar.cancel`
   needs USER trust.** Writing to someone's calendar on a model's say-so
   is the sort of thing that should leave a trace and be refusable.
   Cancelling something the user put there is worse, so DERIVED cannot
   do it — the same reasoning as decision 035 for schedules.

4. **`math.eval` returns an exact decimal string, not a float.** `0.1 +
   0.2` answering `0.30000000000000004` is correct IEEE and a wrong
   answer to the question asked. Integer-scaled arithmetic, with the
   scale carried, and a documented precision limit.

5. **No reminders in S1.** A calendar that can fire a notification needs
   `clock.schedule` (deferred since M8) plus a trust rule for who may
   create one. Worth doing; worth doing separately, with its own design
   note, rather than smuggled in behind "calendar".

## Tests

### Unit — `math.eval` (12)
1. Precedence: `2 + 3 * 4` is 14.
2. Parentheses override it.
3. Right-associative `^`: `2^3^2` is 512.
4. Unary minus, including `-2^2`.
5. `0.1 + 0.2` is exactly `0.3`.
6. Division by zero is a refusal, not `Infinity`.
7. Percentages: `17% of 250`.
8. The function list: `min`, `max`, `abs`, `round`, `sqrt`.
9. A malformed expression is `invalid_input` with the position.
10. **An attempt to call a JavaScript global is refused** —
    `constructor`, `process`, `require`.
11. A 10,000-character expression is refused rather than parsed.
12. Deep nesting is refused rather than blowing the stack.

### Unit — time (6)
13. `time.convert` across a DST boundary.
14. An unknown IANA name is `invalid_input`, not a crash.
15. `time.until` in days/hours/minutes for a future instant.
16. A past instant reads as "ago" rather than negative.
17. Both read the injected clock, proven with `FakeClock`.
18. Rendering is a sentence, not a JSON dump.

### Unit — notes (4)
19. `notes.list` returns names only.
20. `notes.search` matches content, case-insensitively.
21. Search returns a snippet around the hit, not the whole file.
22. Neither can escape the sandbox prefix.

### Unit + integration — calendar (14)
23. `add` writes a `calendar.added` event and projects one row.
24. `list` is ordered by start time.
25. `list` windows by `from`/`to`.
26. `find` matches title and location text.
27. `cancel` closes the event and it leaves `list`.
28. A cancelled event is still in the log and still in `allEvents`.
29. **Rebuild from events alone reproduces the calendar exactly** —
    invariant 1, the test that makes position 2 real.
30. An end before its start is `invalid_input`.
31. An all-day event has no time component.
32. DERIVED trust may `add` but not `cancel`.
33. Overlap is reported, not refused — it is the user's calendar.
34. `GET /calendar` windows and returns the same rows as the store.
35. `POST /calendar` then `GET` round-trips through HTTP.
36. `DELETE /calendar/:id` cancels.

### Integration — the tool contract (3)
37. All nine new tools appear in the registry with schemas.
38. Each is trust-filtered: the FOREIGN tool list excludes the writers.
39. `plugin-contract.test.ts` still passes — adding tools changed
    nothing outside `src/tools/` plus registration.

### e2e (3)
40. Adding an event in the UI shows it in the agenda.
41. It survives a reload, because the agent owns it.
42. Asking the agent "what is on today" calls `calendar.list` and
    answers from the result, offline.

## Not built

- Reminders and notifications (needs `clock.schedule`).
- Recurring events. `RRULE` is a genuinely large specification and the
  scheduler's cron already covers "every weekday at 9"; mixing the two
  models badly is worse than having one.
- Invitees, free/busy, anything multi-person — that is a connector by
  another name.
- `conversation.search`. Wanted, but there is no FTS index over
  messages (only `facts_fts`), so it needs its own migration and a
  projector change. Next.

---

## Outcome

All 42 tests exist and pass. See `S1-skills.md` for what was built, the
five defects the tests found, and what was deliberately left out.

Two additions to the plan, both forced by the system rather than chosen:

- `calendar:read` and `calendar:write` had to be added to the trust
  ceiling in `src/security/trust.ts`. The plan assumed existing
  capabilities would do; nothing fit, and reusing `fs:write` for a
  calendar write would have been a lie to the policy engine.
- `calendar.cancel` needed a `dryRun()`. The tool contract refuses to
  register a `dangerous` tool without one, which is the contract working.
