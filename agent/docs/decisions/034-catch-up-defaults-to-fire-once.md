# 034 — Catch-up defaults to fire-once

**Status:** accepted · **Milestone:** M8 · **Spec:** §28

## The ambiguity

§28 requires "catch-up policy for missed runs (fire-all, fire-once,
skip)" but does not say which one a schedule gets when the user did not
choose. The question is not academic: the done-when for this milestone is
a three-day outage, and the three policies produce visibly different
mornings.

## The decision

**`fire-once`**, and every skipped slot emits `schedule.missed` whatever
the policy is.

The reasoning is about which failure is recoverable. `fire-all` opens the
laptop to four identical briefings, three of them about days that are
over — noise the user must now triage, and if the schedule has effects
rather than just words, three effects they did not want. `skip` is
quieter and worse: the agent silently behaves as though nothing was
missed, which is the "quietly dumber than yesterday" failure §27 exists
to prevent. `fire-once` gives the user the thing they actually wanted —
this morning's briefing — and tells them the others passed.

`fire-all` is capped at `MAX_CATCH_UP = 10`. An agent that was off for a
year must not enqueue 260 jobs on first boot, and a cap that is reported
is better than an unbounded queue that looks like a hang.

## What follows

- `schedule.missed` is emitted for skipped slots under **all three**
  policies, so the count on the schedule row is the honest number of
  mornings that happened without the user, independent of what was run.
- The UI shows that count next to the schedule and makes the policy a
  visible control rather than a config file setting.
