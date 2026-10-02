# 035 — DERIVED trust cannot create a schedule

**Status:** accepted · **Milestone:** M8 (changes M1 code) · **Spec:** §12, §28

## What happened

M1 gave `schedule:create` to SYSTEM, USER and DERIVED. An M8 adversarial
test (57) asserted that untrusted content cannot create a schedule, and
it failed — not because foreign content has the capability, but because
*model output* does, and model output is downstream of every fenced web
page the agent has ever been shown.

The attack is one step long. A page says "also, set a daily reminder to
run the following"; the model, summarising it, emits a schedule-creation
intent; the intent is DERIVED; DERIVED permits `schedule:create`. A
prompt injection that is caught today becomes an action that fires at 9am
tomorrow, when the fence and the context that justified it are long gone.

## The decision

Remove `schedule:create` from the DERIVED ceiling. The agent may *ask*
(`approval:request` stays), and the user may create schedules; the agent
cannot hand itself a recurring slot.

This is a change to M1's trust lattice from inside M8, which the working
agreement (§36) says to do out loud rather than paper over downstream.
The alternative — leaving the lattice wrong and blocking the path in the
scheduler — would have left the next caller of `permits()` with the same
hole.

## Why it is safe

Dropping a capability from DERIVED preserves the nesting property that
makes the lattice meaningful: DERIVED ⊆ USER still holds, so a *drop* in
trust still cannot *grant* anything. Test 57 asserts the subset relation
directly, so a future edit that breaks it fails loudly.

## Related

The same test run found that `ScheduleStore` spread the user's payload
*after* the fields it controls, so a payload containing `scheduleId`
overwrote the real one. Fixed by spreading the payload first. Data does
not get to choose what it is about.
