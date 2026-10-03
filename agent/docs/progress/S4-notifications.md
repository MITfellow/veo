# S4 — a reminder you actually see

The design note is `S4-notifications-design.md`, written before the
code, per §36.

## Why this was next

S3's own progress note said:

> A fired reminder starts a run in its own session, which is where the
> text lands. Nothing pops up; if the app is closed, you see it next
> time you open it. This is honest but thin.

"Thin" was generous. Every mechanism worked — the scheduler fired, the
worker ran, the agent spoke — and the chain ended in a conversation
nobody had open. A reminder that does not reach the person is a row in
a table. It was the biggest hole in the product and I had put it
there, so it went first.

## Built

### Seen is an event

Migration 018 adds `seen_at` to `reminders`; `reminder.seen` is a new
event; the projector goes to version 2. The client does not set a
flag — it appends a fact, so dismissing survives a reload and the log
can answer "was I ever actually told?". That pairs with S3's "fired,
and ignored anyway": `fired_at` and `seen_at` are different questions
and now have different answers.

`ReminderStore.markSeen` refuses to mark something that never fired or
was already seen, so a double-click does not append twice.
`ReminderStore.unseen` is the badge's query — fired, not cancelled,
not seen, newest first.

### `GET /notifications`, `POST /notifications/:id/seen`

**Only fired reminders.** Not "everything the agent said while you
were away". A reminder is something the person explicitly asked to be
told at a moment they chose, and that request is what earns an
interruption; anything else is the agent deciding to interrupt. The
first time a badge shows something nobody asked for is the day people
stop looking at badges. A general feed can come later and should reuse
this surface.

Each notification carries the session its text landed in, so the
client can open that conversation. The id of that session is now
computed by one exported function, `scheduleSessionId()`, used by the
worker that creates it and the route that points at it — it was about
to be written in a second place, which is how two places drift.

### The bell

`src/components/NotificationBell.tsx`, prefix `ntf-`, in the sidebar
title bar. Three deliberate restraints:

- **Absent when there is nothing.** No zero-badge to check and be
  disappointed by.
- **Absent when the agent is not running.** Not an error in the window
  chrome: the messaging app works perfectly well with no agent.
- **Polled every 30 seconds**, not streamed. This happens a few times
  a day; holding a socket open to hear about it costs more than it
  saves.

### Reminders on calendar events, with relative presets

The calendar row gets the same Remind control as a task, offering *10
minutes before*, *an hour before*, *a day before*, *the evening
before* — resolved against the event's own start time, in the client.

That closes S3's first deferred item without weakening anything:
`reminders.set` still takes an absolute instant, because a tool that
accepted "an hour before" would have to guess which event you meant.
Its contract always said the caller resolves the offset. This is that
caller, and it is the only place the start time is actually known.

Presets already in the past are disabled rather than hidden, so the
set does not jump around as time passes.

## Found while building

**Two panels owned the same list.** The calendar sets a reminder on an
event; the to-do panel lists every pending reminder two inches below.
Setting one left the other stale — caught by e2e 69, not by reasoning.
Fixed with a four-line publish/subscribe in `lib/agent`
(`remindersChanged` / `onRemindersChanged`): they are siblings in one
sheet, so neither can own the other's state, and lifting the list into
a context used by exactly two components would be more machinery than
the problem deserves.

**`.sidebar-top .icon-btn').first()` broke — the fourth time this
shape has broken a test here.** The bell is now the first icon button
in that row when something is outstanding, so a positional locator
that was only ever right by accident started clicking the wrong
control. Both occurrences now name the button. The standing rule after
three strikes was "every e2e locator names its target"; this is the
reminder that it applies to the app chrome too, not just panels.

**A 30-second poll is not something to race in a test.** The first
version of e2e 67 waited for the bell and sometimes found a badge left
by an earlier run, then failed looking for its own text inside. It now
clears outstanding notifications first, waits on the *API* for the
reminder to actually fire, and reloads to force the fetch. Waiting on
the real condition rather than sleeping.

**A `Date.now()` crept into the calendar panel's render** to decide
which presets were still in the future — the same impurity S2 fixed in
the task panel. oxlint did not catch it this time; I did. The clock is
captured when the data arrives, so an unrelated re-render cannot
change which buttons are available.

**Test 47 was written wrong and the code was right.** I expected
cancelling a fired reminder to clear it from the badge. It does
nothing, and that is correct: an interruption that already happened
cannot be retracted — the person has been told. Only looking at it
clears it. The test now pins that.

## Numbers

| | after S3 | after S4 |
|---|---|---|
| agent tests / files | 997 / 90 | **1009 / 90** |
| web tests / files | 159 / 15 | **165 / 16** |
| e2e | 155 passed / 13 skipped | **161 / 13** |
| migrations | 17 | **18** |
| routes | 60 | **62** |

`tsc` clean in both projects, oxlint 0/0 across 100 files. Agent suite
74s against the 60s budget — it has been over since harness-UI and the
answer is still not to delete tests.

## Deferred

- **Snooze.** The obvious next ask, and it is a second schedule per
  reminder plus a decision about what "in an hour" means when the
  original already fired. Worth doing properly, not worth doing badly
  in this pass.
- **A general "while you were away" feed.** Position 1 of the design
  note. Scheduled briefings still land silently in their session.
- **Browser notifications.** The service worker exists but must never
  cache `/agent/*`, and push needs a server the user does not have. An
  in-app badge is the honest ceiling for a local-only app, and the
  app says so rather than pretending.
- **Reminders without an owner.** Still impossible on purpose: "remind
  me to breathe" has nothing to attach to, and the owner is what makes
  the cascade work.

## Unsure

- **Thirty seconds is a guess.** Long enough that a reminder can be
  almost a minute late on screen, short enough to be a wasted request
  most of the time. A visibility-change trigger would be better than
  tuning the number.
- **The bell is in the sidebar, which is the messaging app's chrome.**
  It is the right place for the user and a slight layering smell: a
  component that talks to the agent now lives in the window frame.
  Contained to one file, and it renders nothing when the agent is
  absent, so the messaging app still stands alone.
- **`unseen` has no cursor**, like `/memory`, `/schedules`, `/jobs`
  and `/tasks` before it. Capped at 20. Fine until someone ignores
  reminders for a month.

## Carried weak points

Unchanged: no cursor on the list routes; `revise` reported but not
executed; no import-merge; a single worker; a crude summarizer; shred
weaker than §13.3; **no embedder, so search is lexical and will not
match a paraphrase**; two recall paths; a ~17-regex extractor;
`calendar.find` is `LIKE` not FTS; all-day events are a 24-hour span
in a stated zone; the 14-day panel horizon is a guess.

Closed by S4: a reminder that fires into a session nobody sees ·
no reminders on calendar events · no relative reminder times.
