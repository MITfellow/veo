# S3 — making the skills reachable

The design note is `S3-reachable-design.md`, written before any code,
per §36. This is what came of it.

Three things, in the order they were built: the offline provider can
now fill tool arguments, a completed task can be reopened, and
reminders exist.

## Built

### 1. Schema-driven slot filling in the offline provider

The headline, and the reason S3 is called what it is.
`src/providers/offline.ts` contained:

```ts
if (required.length > 0) continue;
```

so the only tools that could ever be called were the four that take no
arguments — `clock.now`, `calendar.list`, `tasks.list`, `notes.list`.
Every other tool, nineteen of them, was dead on the default
configuration, which is the one the app boots into when there is no
`ARISH_API_KEY`. S1 and S2 each added four or five tools and each
shipped them unreachable. They had passing unit tests the whole time;
the tests were right and the product was broken, which is the specific
failure mode worth naming.

Now `bestTool` returns `{name, input}` and fills required arguments
from the JSON schema the registry already produces:

- `enum` → the member the question actually names;
- `number` / `integer` → the first number in the question;
- `string` → a quoted span if there is one, otherwise the question's
  content words (right for a search query, which is the common case);
- `boolean` → give up, rather than guess which way someone meant it.

**A partial fill abandons the whole call.** A half-filled call fails
zod validation at the capability gate and the person reads the
resulting tool error as the agent crashing, which is a worse answer
than "I have no model".

Scoring is normalised overlap, `hits / sqrt(ownWords)`. Raw overlap let
the wordiest description win almost every question — `memory.recall`,
whose description lists nine nouns, beat `clock.now` on "what is the
time".

The file stays name-blind (invariant 9), and there is now a test that
reads its own source and asserts no tool name appears in it, checked
against the live roster so tool #24 is covered the day it is
registered.

#### The part I got wrong first

The first version of the filler turned **"hello there"** into
`calendar.cancel({id: 'hello there'})` and raised a dangerous approval.
The word "there" appears in that tool's description — *"this removes
something they put there"* — and that single function word was the
entire evidence. Two integration tests in `app.test.ts` caught it,
which is what they are for.

The fix is not a threshold. Something that cannot understand a
question must not be allowed to decide a write, so the provider now
refuses to guess arguments for anything that is not `risk: 'safe'` and
`effect: 'pure' | 'local'`, with an absent risk treated as dangerous.
That required carrying `risk` and `effect` through to the model's tool
spec — `ToolSummary`, `ModelToolSpec`, `specsFor` — which is
information a real model should have had all along: a chooser that
cannot tell "look at the calendar" from "delete the appointment" is
choosing blind, and the policy engine only sees the call after the
decision is made.

The greeting is handled separately and properly, by putting function
words and pleasantries in the stopword list where that judgement
belongs. Times of day and "now" were deliberately left out of it:
they are noise in "good morning" but real signal in "what is on my
calendar this morning", and a wrong *read* costs little.

### 2. `task.reopened`

S2 shipped a tick-box that could not be unticked — `PATCH {done:false}`
returned `409 not_reopenable` — because the log had no event for it.
Now it does. The completion stays in the history and a later fact
overrides it: "finished on Tuesday, reopened on Thursday" is true and
useful, and erasing the Tuesday would make it a lie.

- event `task.reopened`, projector bumped to version 2 (which is what
  re-projects an existing database);
- `TaskStore.reopen`, which returns false for a task that is already
  open and for one that was dropped — dropping says *this stopped
  being worth doing*, and undoing that is adding it again, with
  today's date on it;
- tool `tasks.reopen` at `minTrust: 'DERIVED'`, the exact counterpart
  of `tasks.complete`;
- the UI button is no longer `disabled` when a task is done.

The S2 test that asserted the 409 was rewritten to assert the new
behaviour. That is a behaviour change, not a weakened test — it got
longer, and it now also pins the two conflict cases.

### 3. Reminders

Deferred in S1 and again in S2, both times with the honest reason:
this needs a scheduler, and building a second one gives you an app
with two clocks, two catch-up policies and two places to look when
nothing arrives. §28's scheduler exists, so:

**A reminder is a one-shot schedule plus a link row.** Migration 017,
`reminders(id, principal, owner_kind, owner_id, schedule_id,
remind_at, text, created_at, cancelled_at, fired_at, seq)`. Events
`reminder.set` / `reminder.cancelled` / `reminder.fired`. The table
holds no next-fire time of its own to drift out of step with the
schedule's — test 22 asserts that, by reading the column list.

The owner is the part that earns its keep. A reminder always belongs
to a task or a calendar event, `POST /reminders` returns
`no_such_owner` if that thing does not exist, and closing an owner
cancels its pending reminders — completing a task, dropping a task,
cancelling an event. A reminder about something that no longer exists
is the failure that teaches a person to ignore reminders, and after
that the feature is worse than absent.

Already-fired reminders are *not* cancelled retrospectively: "I was
reminded and ignored it" is a fact about the past and is the one you
want when you ask why something slipped.

New capabilities `reminder:read` / `reminder:set`, and
**decision 041** explains why they are not `schedule:create`.
Decision 035 took `schedule:create` away from DERIVED for a good
reason — a schedule is a standing grant of future authority — and that
reason does not reach a fixed sentence at a fixed instant about
something the person already wrote down. Cancelling stays at
`minTrust: 'USER'`, `risk: 'dangerous'`, the fourth application of
035's line.

UI: a "Remind" button per task row that opens a time picker under it,
and a pending list at the foot of the panel. The panel now says in as
many words that a due date does not fire and a reminder does — they
are separate controls on purpose.

## Numbers

| | before S3 | after |
|---|---|---|
| agent tests / files | 947 / 87 | **992 / 90** |
| web tests / files | 159 / 15 | 159 / 15 |
| e2e | 151 passed / 13 skipped | **155 / 13** |
| tools | 23 | **27** |
| migrations | 16 | **17** |
| tools reachable with no API key | **4** | **all safe, read-only ones** |

`tsc` clean in both projects, oxlint 0/0. The agent suite is 64s
against a 60s budget; it has been over since the harness-UI milestone
and the answer is still not to delete tests.

## Deferred

- **Relative reminders.** "20 minutes before" has to be resolved into
  an instant by the caller. `reminders.set` takes an absolute moment
  on purpose, so it cannot quietly attach a reminder to the wrong
  thing's wrong time — but it means the agent has to do arithmetic it
  is not good at without a model.
- **Recurring reminders.** They would turn a reminder back into a
  schedule, and decision 041 says so explicitly: if reminders ever
  gain recurrence, the capability collapses back into
  `schedule:create`.
- **Reminders in the calendar panel.** Only the task panel has the
  control. The API and the cascade both support events — test 38
  proves it end to end — but there is no button for it yet.
- **A notification surface.** A fired reminder starts a run in its own
  session, which is where the text lands. Nothing pops up; if the app
  is closed, you see it next time you open it. This is honest but
  thin.

## Unsure

- **The stopword list is a judgement call, and judgement calls rot.**
  It is load-bearing — it is what stops a greeting matching a tool —
  and it will be wrong for some question nobody has typed yet. It is
  the right size of mechanism for a provider that exists so the app
  can start without a key, but it is not a good matcher and should not
  be grown into one. The real fix is a model.
- **Owner-check at set time, not at fire time.** A task deleted by a
  route that forgets to cascade would leave an armed reminder. Three
  routes cascade today and they are tested; a fourth added later would
  not be. A check at fire time would be belt and braces.
- **`reminder:read` for TOOL trust.** I gave TOOL read but not set, by
  analogy with the calendar. I am not certain a tool's output should
  see the reminder list at all.

## Carried weak points

Unchanged from S2 and still true: no cursor on `/memory`,
`/schedules`, `/jobs`, `/tasks`; `revise` reported but not executed;
no import-merge; a single worker; a crude summarizer; shred weaker
than §13.3; **no embedder, so search is lexical and will not match a
paraphrase**; two recall paths; a ~17-regex extractor;
`calendar.find` is `LIKE` not FTS; all-day events are a 24-hour span
in a stated zone; the 14-day panel horizon is a guess.

Closed by S3: offline tool choice is word overlap and zero-arg-only ·
no `task.reopened` · no reminders.
