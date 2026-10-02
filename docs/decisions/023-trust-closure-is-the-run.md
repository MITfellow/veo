# 023 — A step's causal closure is the run, not the step

**Status:** accepted · **Milestone:** M4 · **Fixes a real vulnerability**

## What was wrong

§12.1: "Compute effective trust as the **minimum** over everything in the
step's causal closure."

The M3 implementation read the events carrying the *current* `stepId`:

```ts
const stepEvents = events.read({}).filter((e) => e.stepId === stepId);
```

That is a closure of one step. A FOREIGN tool result logged in step 2 is not
in step 3's closure by that definition, so step 3 ran at USER trust — and a
web page could ask for a payment and get one. The step-level capability gate
was correct, the policy module was correct, the ceilings were correct, and
the input to all three was wrong.

The injection corpus found it immediately: `web.post` executed, carrying
whatever the attacker asked for, on the step after the injection landed.

## The decision

Effective trust is the minimum over:

- every event in the **run** so far,
- every message event in the **session** being replayed into the context,
- every observation about to be fed in as this step's input.

Which is to say: everything that influenced the step. For a model step, that
is exactly the context it is given, plus the run that produced it.

## Why this definition and not a narrower one

A narrower closure needs `causationId` threaded perfectly through every
append, and the moment one event is appended without it, the closure silently
shrinks and the gate silently opens. That failure is invisible — everything
works, nothing throws, and the trust level is simply too high.

A closure defined as "the run and the session history" cannot shrink by
accident. It can only be too *large*, which fails toward refusing things, and
a refusal is visible and complainable in a way that an over-permissive step
is not.

## Cost

O(events in run + messages in session) per step. §32's budget is 100ms for
assembly at 200 turns, and this is the same order of work the assembler
already does. M5 makes assembly incremental; this moves with it.

## The general lesson

Three of the four layers in this chain were right. The vulnerability was in
the *argument*, not the function. Tests that exercise each layer in isolation
all passed — only the end-to-end attack found it, which is the argument for
the injection corpus existing as a milestone bar rather than a unit test.
