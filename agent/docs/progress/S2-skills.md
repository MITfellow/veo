# S2 — More skills: remembering, tracking, converting

Design note and 40-test list written first (`S2-skills-design.md`). All
40 exist and pass.

## Built

Eight tools. Still no connector, no socket, no credential.

| Tool | Trust | Risk | What it is for |
| --- | --- | --- | --- |
| `conversation.search` | DERIVED | safe | Search everything ever said, both ways |
| `tasks.add` | DERIVED | caution | Put something on the list |
| `tasks.list` | DERIVED | safe | What is left to do, soonest deadline first |
| `tasks.complete` | DERIVED | caution | Tick it off |
| `tasks.drop` | **USER** | dangerous | Remove it without claiming it was done |
| `unit.convert` | FOREIGN | safe | oz→g, °F→°C, GiB→MB; no currency |

Supporting work: migrations `015-messages-fts` and `016-tasks`; the
messages projector now maintains `messages_fts` (**version bumped 1→2**,
which is what re-projects an existing database); `task.added` /
`task.completed` / `task.dropped` events; `tasksProjector`; `TaskStore`;
`MessageSearch`; two new capabilities (`tasks:read`, `tasks:write`);
four HTTP routes; four client methods; `TasksPanel`.

**Counts:** agent **947 / 87 files** (was 902 / 83), web 159 / 15,
**e2e 151 passed + 13 skipped** (was 145), `tsc` clean both, oxlint 0/0.

## The headline: the agent can read its own past

`facts_fts` was the only full-text table in the system, so the agent
could search what it had *concluded* and not what was *said*. Anything
older than the context window was in the log and unreachable —
`history.expand` only reopens compacted blocks inside one run, and
`memory.recall` returns conclusions. "What did we decide about the
Lisbon trip" had no answer. Now it does.

Because search is a **recall path**, §22 binds it:

- FOREIGN messages are excluded **in the SQL**, not filtered afterwards,
  and the same exclusion applies to the neighbouring turns pulled in for
  context. A quarantined web page that arrives as "context" has still
  arrived.
- The result is labelled with the trust of its **weakest** member.

## I got one of my own design decisions wrong

The design note said the result's trust should be the **max** of what
was found. That is backwards, and it is written down here rather than
quietly fixed because §36 asks for exactly that.

A search result is one blob of text containing several messages. Label
it with its most trusted member and every weaker thing inside it has
been laundered up to that level — which is precisely the move the trust
model exists to stop. `trustOf` takes the minimum. The design note has
been corrected in place with a note saying it was corrected.

## What the tests found

1. **`dueLabel` said "Today" for a task due yesterday.** It compared
   instants, so 23:59 yesterday was under a day behind "now" and rounded
   to zero — while the same row was already painted overdue. Two parts
   of one screen disagreeing. Now compares calendar days. (e2e 40.)
2. **Dropped tasks reappeared under "Show finished".** Removing
   something and then seeing it again makes Remove look broken. Finished
   means finished; dropped is gone.
3. **`Date.now()` during render**, caught by oxlint's `react(purity)`.
   Fixed properly rather than silenced: the panel captures the clock
   when the data *loads*, so "overdue" is judged against the age of the
   data and an unrelated re-render cannot change what the list says.
4. **A pre-existing e2e locator broke.** `constitution.spec.ts` used an
   unscoped `getByRole('button', {name: 'Add'})`, which was only ever
   right by accident; the to-do list added a second one. Scoped to
   `.con-add`. This is the third time the shared Settings column has
   caused this — the rule is now: **every locator names its panel.**

## Positions worth re-reading

- **`complete` is DERIVED, `drop` is USER.** Third application of
  decision 035's reasoning, so it is now the house rule rather than a
  judgement call: *visible and reversible* the agent may do; *destroys
  something a person wrote down* it may not.
- **A due date is a deadline, not an alarm.** Nothing fires, and the
  panel says so in those words. Implying a notification that never comes
  is the kind of broken promise that costs trust in the whole system.
- **`PATCH /tasks/:id {done:false}` returns 409, not silence.** There is
  no `task.reopened` event in S2, so un-ticking genuinely cannot be
  expressed. Refusing with a reason beats a tick-box that pretends.
- **`completed_at` and `dropped_at` are separate columns.** "I did it"
  and "this stopped being worth doing" answer different questions, and
  collapsing them would destroy the only interesting thing you can ask
  of an old list.
- **No currency in `unit.convert`.** A rate needs a network call and a
  stale rate looks like a good answer. Refused *by name*, so the model
  learns it is deliberate rather than a gap in a table.

## Not built

- **Reminders.** Deferred a second time, same reason. Worth noting that
  §28's `schedules` with `kind: 'once'` already does "tell me at 9am
  Tuesday"; what is missing is a reminder *attached to* a task or event,
  which has to answer "what happens when the thing moves".
- **`task.reopened`.** Would make the 409 above unnecessary. One event,
  one projector branch — small, but it is a change to the log's
  vocabulary and belongs with reminders.
- **Currency, priorities, tags, subtasks, projects.**

## Unsure

- **FTS is lexical.** `conversation.search` will not match paraphrase —
  searching "hotel" will not find "the place we're staying". The fix is
  an embedder, and there still is not one (permanent L1). This is the
  largest remaining gap in recall.
- **The neighbour query runs per hit.** Two extra point lookups per
  result, 25 results max, so 50 indexed reads — fine now, and the first
  thing to batch if search ever gets slow.
- **No cursor on `/tasks`**, same as `/memory`, `/schedules`, `/jobs`.
  The list is capped at 200 and that will be wrong for someone.
