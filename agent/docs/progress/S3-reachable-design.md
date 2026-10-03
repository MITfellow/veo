# S3 — Making the skills reachable

Written before the code, per §36.

## The complaint

S1 and S2 built seventeen tools. Running the app showed the problem:
**you cannot get at most of them by talking to the agent.**

Two separate causes, and it is worth keeping them apart.

1. **No model key → L2 degradation.** The agent answers from the
   offline fallback. That is the user's to fix and no amount of code
   here changes it.
2. **The offline fallback can only call tools that take no arguments.**
   This one is ours. `src/providers/offline.ts` has one line:

   ```ts
   if (required.length > 0) continue;
   ```

   So `clock.now`, `calendar.list`, `tasks.list` and `notes.list` are
   reachable, and `conversation.search`, `unit.convert`, `calendar.add`,
   `tasks.add`, `calendar.find` and `notes.search` — every tool that
   takes an argument — are not. More than half the skills are dead on
   the default configuration, which is also the configuration every
   new user starts in.

Plus two loose ends named in the S2 note: the `409 not_reopenable`
wart, and reminders, now deferred twice.

## What S3 builds

### 1. Schema-driven slot filling in the offline provider

The provider must stay **name-blind**. A provider that says
`if (tool.name === 'calendar.add')` has put a hole straight through
invariant 9, and this file sits below L5. So the filler is driven
entirely by the JSON schema the registry already hands it — which
§36 insists is the single definition of a tool's arguments, and which
until now the offline path ignored completely.

The rules, in order, per required property:

- `type: 'string'` with a `description` containing a quoted example →
  look for that shape in the question; otherwise fall back to the
  user's own words with filler stripped.
- `type: 'number'` → the first number in the question.
- `enum` → the first enum member whose text appears in the question.
- Anything else, or nothing found → **give up on the whole call** and
  answer in text. A half-filled call fails zod validation, and a tool
  error is a worse answer than "I cannot do that offline".

This stays dumb. It is not an attempt to be a model. It is the
difference between "the path is proven for four tools" and "the path is
proven for seventeen".

### 2. `task.reopened`

S2 returned `409 not_reopenable` on `PATCH {done:false}` because the
log had no vocabulary for it. Adding the event is one type, one
projector branch and one store method, and it removes a wart the user
meets the first time they tick the wrong box.

### 3. Reminders

Deferred in S1 and again in S2. The reason given both times was real —
firing a notification is a transfer of authority, and it has to answer
"what happens when the thing moves". So:

**A reminder is a one-shot schedule owned by a calendar event or a
task.** §28 already has the scheduler, the queue, catch-up and the
worker; building a second timer beside it would be the mistake.

- `reminders` table (017) linking `owner_id` → `schedule_id`.
- Setting a reminder creates a `kind: 'once'` schedule whose payload is
  the prompt the agent will act on.
- **When the event moves, the reminder moves.** The calendar store
  cancels and recreates the schedule on change.
- **When the event is cancelled or the task is completed or dropped,
  the reminder is deleted.** This is the question that justified the
  deferral and it gets an answer: a reminder for a thing that is no
  longer happening is strictly worse than no reminder.
- Catch-up is `fire-once`: three missed reminders for the same dentist
  appointment is noise, and §28 already has the policy.

**Trust:** setting a reminder is `schedule:create`, which decision 035
puts at USER/SYSTEM only. So the *tool* is USER-only, and the agent can
suggest a reminder but cannot give itself a standing slot to speak in.
That is the rule working, not a limitation to route around.

## Positions

1. **The offline filler is name-blind or it is not worth having.** The
   moment it special-cases a tool, the plugin contract is a lie and
   §20's "adding a tool touches one file" stops being true.
2. **A partial fill is a refusal.** Guessing two of three arguments
   produces a zod failure the user reads as a crash. Better to say
   plainly that the offline model cannot do it.
3. **Reminders reuse §28 or they do not ship.** A second scheduler
   means two things that can fire, two catch-up policies and two
   answers to "what happened while the laptop was shut".
4. **A reminder dies with the thing it is about.** Cancel the meeting,
   lose the reminder. No orphans.
5. **The agent may suggest a reminder, not set one.** `schedule:create`
   is USER-only by decision 035 and reminders are schedules.

## Tests

### Offline provider (12)

1. Fills a single required string from the question.
2. Fills a required number.
3. Fills an enum by matching a member in the question.
4. Refuses the call when a required slot cannot be filled.
5. Still prefers a zero-argument tool when one scores higher.
6. Never calls a tool whose score is below the floor.
7. **Knows no tool name** — asserted by scanning the source.
8. A tool added at runtime with a string argument is callable, with no
   provider change.
9. The filled value round-trips through the real zod schema.
10. Picks the better of two plausible tools by normalised score.
11. A tool-result turn never triggers a second call (no loops).
12. `conversation.search` is reachable end to end on the offline model.

### `task.reopened` (5)

13. Reopening a completed task clears `completed_at`.
14. It is a distinct event in the log.
15. `PATCH {done:false}` now returns 200, not 409.
16. A dropped task cannot be reopened — it was removed on purpose.
17. Rebuild reproduces a complete → reopen → complete sequence.

### Reminders (13)

18. Setting one creates a one-shot schedule.
19. The schedule's fire time is the reminder's, in the right zone.
20. Moving the event moves the reminder.
21. Cancelling the event deletes the reminder.
22. Completing a task deletes its reminder.
23. Dropping a task deletes its reminder.
24. A reminder in the past is refused rather than fired immediately.
25. Catch-up is `fire-once`.
26. Rebuild reproduces the reminder links.
27. The tool is USER-only (decision 035).
28. The agent can read reminders but not create one at DERIVED.
29. `GET /calendar` and `GET /tasks` report the reminder.
30. Deleting the owner leaves no orphan schedule.

### e2e (3)

31. A reminder set in the UI shows on the row.
32. It survives a reload.
33. Cancelling the event removes the reminder from Standing instructions.

## Not built

- **Semantic search.** Still needs an embedder. Still L1.
- **Recurring reminders.** A recurring *event* does not exist yet
  either; both wait for RRULE.
- **Notification delivery.** A reminder fires a run, which speaks in
  the conversation. Push/desktop notification is Veo's existing
  `notifications` setting and a separate concern.
