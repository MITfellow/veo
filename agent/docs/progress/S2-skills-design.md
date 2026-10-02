# S2 — More skills: remembering, tracking, converting

Written before any code, per §36. The test list at the bottom is the
acceptance criteria; it is written now so that the implementation cannot
quietly redefine what "done" means.

## Still no connectors

Same rule as S1 and same deviation statement: nothing here opens a
socket, holds a credential, or syncs with anything. Everything is the
agent's own state in its own event log, or pure computation.

## The complaint

S1 gave the agent a calendar, arithmetic, time and note lookup. Three
things are still obviously missing when you actually use it.

**It cannot remember a conversation.** This is the worst one and it has
been on the weak-points list since M6. `facts_fts` is the only full-text
table in the system — *messages are not indexed at all*. So if you ask
"what did we decide about the Lisbon trip", the agent can only answer
from whatever survived into its context window. Everything older is in
the log, unreachable. `history.expand` only reopens compacted blocks
inside one run. An agent you talk to every day that cannot search what
you said to it yesterday is not a personal agent, it is a chatbot with
a database it never reads.

**It has a calendar but no list.** Most of what a person wants to track
has no time attached: buy a new router, reply to Rui, renew the lease.
Putting those in a calendar means inventing a time, which makes the
calendar useless as a calendar.

**It still cannot convert anything.** "How many grams is 4 oz" is the
single most common thing a model gets quietly, confidently wrong —
same category as the arithmetic `math.eval` fixed.

## What S2 builds

### `conversation.search` — the agent can read its own past

Migration 015 adds `messages_fts`, an FTS5 table over the message text,
maintained by the existing messages projector. The projector's version
bumps, which is what makes an existing database re-project rather than
silently stay empty.

One tool: `conversation.search(query, sessionId?, limit?)` → matching
messages with the surrounding turn, ranked by FTS rank, newest first on
ties. `minTrust: DERIVED`, `risk: safe`, capability `memory:read`.

**No HTTP route and no UI**, deliberately. Veo already has message
search over its own IndexedDB copy, which is the one a *person* uses.
This is the agent's view of its own log — a different corpus for a
different reader. Adding a route would mean a second search box that
looks the same and returns different things, which is worse than not
having it. `wiring.test.ts` audits routes against the UI, so a tool with
no route adds no obligation.

**FOREIGN content is excluded from results.** A message carrying
`trust: 'FOREIGN'` is a fenced web page the agent read, not something
the user said, and §22 is explicit that foreign content is never
recallable. Search is a recall path.

### `tasks.*` — a list, event-sourced

`tasks.add`, `tasks.list`, `tasks.complete`, `tasks.drop`. Migration 016
(`tasks`), events `task.added` / `task.completed` / `task.dropped`, a
projector, a store, three HTTP routes and a `TasksPanel`.

Same shape as the calendar, and same trust split for the same reason:
**`add` and `complete` are DERIVED; `drop` is USER.** Completing
something is a statement about the world that is visible and reversible.
Deleting something you wrote down is not the agent's call.

A task has: title, optional due date, optional note, a done flag. It
does **not** have priority, tags, subtasks or projects. Those are how
list apps become project managers that nobody finishes setting up.

### `unit.convert` — pure, exact, no network

Length, mass, volume, temperature, data, time-duration, speed. Exact
scaled-integer arithmetic reusing `math-eval`'s decimal rendering, so
`4 oz` in grams does not come back as `113.39800000000001`.

**No currency.** A currency conversion needs a rate, a rate needs a
network call, and a *stale* rate is worse than no answer because it
looks like an answer. The tool refuses currency by name and says why.

## Five positions

1. **Search is a recall path, so §22's rules apply to it.** FOREIGN is
   excluded and the result carries the trust of what it found. The
   cheap version — "it's just SQL, return the rows" — would be a hole
   straight through the trust model, because the easiest way to get a
   fenced web page into the agent's reasoning is to let it search for
   one.
2. **The messages projector maintains the index, not a trigger.** SQLite
   triggers would be less code and would break `rebuild()`: a trigger
   fires on the projector's INSERT, so a rebuild would double-insert
   unless the reset clears FTS too. Keeping it in the projector keeps
   one rule — *the log is the truth, the projection is derived* — rather
   than two mechanisms that have to agree.
3. **`tasks.drop` is USER; `tasks.complete` is DERIVED.** Marking a
   thing done is reversible and visible. Deleting it is neither. This is
   decision 035's reasoning again, and the third time it has applied, so
   it is now the house rule rather than a one-off.
4. **No due-date notification.** Same deferral as S1's reminders and for
   the same reason: firing a notification is a transfer of authority
   that needs the worker and a design for what happens when the thing
   moves. A due date here is a *sort key and a label*, nothing more, and
   the panel says so rather than implying an alarm that will not come.
5. **`unit.convert` refuses rather than approximates.** Unknown unit,
   incompatible dimensions ("3 kg in metres"), or currency: all
   `invalid_input` with a sentence explaining it. A converter that
   guesses the dimension is a converter that returns a plausible
   number for nonsense.

## Tests

### Unit — `unit.convert` (10)

1. Length: `4 in` → cm, exact.
2. Mass: `4 oz` → g, no floating-point tail.
3. Temperature: 100 °F → °C, and the offset is handled (not just a ratio).
4. −40 °C is −40 °F — the fixed point that catches a ratio-only implementation.
5. Volume: 1 US cup → ml.
6. Data: 1 GiB → MiB, and GB ≠ GiB.
7. Round-trips: converting there and back returns the original.
8. Incompatible dimensions are refused, naming both.
9. An unknown unit is refused and does not guess.
10. Currency is refused *by name*, saying a rate needs a network call.

### Unit — `tasks` store and tools (10)

11. `add` writes `task.added` and projects one row.
12. `list` shows open tasks, soonest due first, undated last.
13. `complete` stamps `completed_at`; the task leaves the open list.
14. A completed task is still in the log and in `list({includeDone})`.
15. `drop` is distinct from `complete` — different event, different meaning.
16. Rebuild from events alone reproduces the task list exactly.
17. One principal cannot see or drop another's tasks.
18. `complete` on an unknown id is `not_found`, not a silent success.
19. `tasks.drop` is `minTrust: USER` with a `dryRun`; `complete` is DERIVED.
20. Renders as a list a model can read, not a JSON dump.

### Unit + integration — `conversation.search` (11)

21. Finds a message by a word in it.
22. Ranked by relevance, not just recency.
23. Returns the neighbouring turn, so a hit has context.
24. Scoped to a session when `sessionId` is given.
25. Searches across sessions when it is not.
26. **FOREIGN messages never appear in results.**
27. The result's trust is the **minimum** of what it found. *(Written
    as "max" in the first draft of this note and corrected during
    implementation — see `trustOf`. A result set is one blob; labelling
    it with its most trusted member launders the rest.)*
28. An empty query is refused rather than returning everything.
29. The limit is clamped, so a model cannot ask for the whole log.
30. **Rebuild repopulates the index** — delete `messages_fts`, rebuild,
    search still works. This is the one that catches a trigger-based
    implementation.
31. The projector version bump re-projects an existing database.

### Integration — HTTP + registry (6)

32. `GET /tasks` lists, `POST /tasks` creates, `DELETE /tasks/:id` drops.
33. `PATCH /tasks/:id` completes and un-completes.
34. A bad task is 400 at the boundary, never a 500.
35. The routes need the bearer token.
36. All eight new tools are in the registry with schemas.
37. The FOREIGN tool list gains `unit.convert` and nothing else.

### e2e (3)

38. A task added in the UI appears in the list.
39. Completing it moves it, and it survives a reload.
40. Asking the agent about an old message finds it via search.

## Not built, and why

- **Reminders / due-date alarms.** Deferred again, same reason as S1.
  Note that §28's `schedules` with `kind: 'once'` already covers "tell
  me at 9am on Tuesday" — what is missing is a reminder *attached to* a
  task or event, which has to answer "what happens when it moves".
- **Currency.** Needs a network call. Out of scope by the standing rule.
- **Priorities, tags, subtasks, projects.** See above.
- **Semantic search over messages.** Needs an embedder, and there still
  is not one (permanent L1 degradation). FTS is lexical; it will miss
  paraphrase. Stated here rather than discovered later.
