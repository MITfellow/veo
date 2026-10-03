# S4 — a reminder you actually see (design note)

Written before the code, per §36.

## The problem

S3 shipped reminders and I wrote this in its own progress note:

> A fired reminder starts a run in its own session, which is where the
> text lands. Nothing pops up; if the app is closed, you see it next
> time you open it. This is honest but thin.

"Thin" was generous. A reminder that does not reach the person is not
a reminder — it is a row in a table. The scheduler fires, the worker
runs, the agent speaks, and the whole chain ends in a session nobody
has open. Every mechanism works and the feature does not.

This is the single biggest gap in the product right now, and it is one
I created, so it goes first.

## Five positions

**1. The notification is the *fired reminder*, not the agent's reply.**

The tempting design is a feed of "things the agent said while you were
away", which would include scheduled briefings and anything else the
worker produces. I am deliberately not doing that yet. A reminder has
a property nothing else has: the person explicitly asked to be told
this, at this moment. That request is what earns an interruption.
Everything else the agent says in the background is something it chose
to say, and the bar for interrupting someone with that is higher.

A general feed can come later and should reuse this surface. Starting
general would mean the first thing in the badge is a briefing nobody
asked for, which is how people learn to ignore badges.

**2. Seen is an event, not a column the client sets.**

`reminder.seen`, appended when the person actually looks. Same
discipline as everywhere else here: the projection carries `seen_at`,
the log carries the fact. This matters more than it sounds — "I was
told and I saw it" versus "I was told and I never looked" is exactly
the distinction that makes an old reminder list worth reading, and it
is the natural companion to S3's "fired, and ignored anyway".

**3. The session id has one definition.**

The worker composes `ses-schedule-${scheduleId}` so that a recurring
schedule reads as one continuing thread. The notification needs the
same id, so clicking a notification can open the conversation it
landed in. That string is currently written in exactly one place and
is about to be written in a second, which is how two places drift.
Export `scheduleSessionId(scheduleId)` from the schedule module and
use it in both.

**4. Polling, not a socket.**

Thirty seconds, and on mount. The agent already has an SSE route for
run streams, and the honest reason not to use it here is that the
browser would have to hold an open connection to be told about
something that happens at most a few times a day. Polling a cheap
indexed query is the right trade, and it degrades correctly: if the
agent is not running, the badge is simply absent rather than an error
in the corner of the screen.

**5. Relative times belong in the client.**

`reminders.set` takes an absolute instant on purpose — S3 made that
call so the tool could not quietly attach a reminder to the wrong
moment. But "an hour before" is what a person actually means when
setting a reminder on a calendar event, and the API's own design says
the *caller* resolves that. So the calendar panel offers presets — an
hour before, the evening before, on the morning — computed from the
event's own start time, and sends an instant. That closes S3's first
deferred item without weakening the tool's contract.

## What gets built

**Agent (L2–L6)**

- migration 018: `seen_at` on `reminders`;
- event `reminder.seen`; reminders projector → version 2;
- `ReminderStore.markSeen`, `.unseen`;
- `scheduleSessionId()` exported from `orchestration/schedule.ts`,
  used by the worker and the notification view;
- `GET /notifications`, `POST /notifications/:id/seen`.

**Veo (client)**

- `agent.notifications()`, `agent.markNotificationSeen()`;
- a bell in the sidebar title bar with an unseen count, `ntf-` prefix
  (one prefix per panel — the rule exists because reusing another
  panel's class as a test hook has bitten this repo three times);
- a popover listing unseen reminders, each with the time it fired and
  a control that marks it seen;
- a Remind control on calendar events, with the relative presets.

## Test list (41 tests)

*Store and projection (41–48)*

41. `markSeen` appends `reminder.seen` and stamps `seen_at`
42. marking twice appends once
43. `unseen` returns fired-but-unseen, newest first
44. `unseen` excludes cancelled, pending and already-seen
45. a rebuild reproduces seen state
46. one principal cannot mark another's reminder seen
47. cancelling after firing does not hide it from `unseen`
48. the projector's `reset` clears `seen_at` with everything else

*Session identity (49–51)*

49. `scheduleSessionId` is used by the worker (the session it creates
    matches the one the notification points at)
50. the notification's session actually contains the reminder text
51. a reminder with no run yet still reports a session id

*Routes (52–58)*

52. `GET /notifications` is empty on a fresh agent
53. a fired reminder appears, with text, firedAt and sessionId
54. `POST /notifications/:id/seen` removes it from the list
55. seen is 404 for an unknown id
56. the list is scoped to the principal
57. cancelled reminders never appear
58. `GET /notifications` 404s when reminders are not wired

*Client and UI (59–66)*

59. `agent.notifications()` parses the shape
60. the bell is absent with nothing unseen
61. the badge counts unseen
62. the popover lists them with their times
63. marking seen clears the badge
64. the agent being down leaves no badge and no error
65. a calendar event can be given a reminder with a preset
66. the preset resolves against the event's start, not now

*e2e (67–69)*

67. a fired reminder shows a badge, and dismissing it clears it
68. the badge survives a reload until dismissed
69. a reminder set on a calendar event appears in the list

## Not built

- **A general "what happened while you were away" feed.** Position 1.
- **Browser notifications / service worker push.** The service worker
  exists but must never cache `/agent/*`, and a push subscription
  needs a server the user does not have. An in-app badge is the honest
  ceiling for a local-only app.
- **Sound.** No.
- **Snooze.** It is the obvious next ask, and it is a second schedule
  per reminder. Worth doing, not worth doing badly in the same pass.
- **Notifications for scheduled briefings.** Position 1 again.
