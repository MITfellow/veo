# 041 — A reminder is not a schedule, for capability purposes

## The ambiguity

§28 gives the system one timing mechanism and one capability for it,
`schedule:create`. Decision 035 then removed `schedule:create` from
DERIVED, and the reasoning was good enough that I would make the same
call again:

> a schedule is a standing grant of future authority, and DERIVED is
> model output, which is downstream of every fenced web page the agent
> has ever read.

S3 adds reminders. A reminder is implemented as a one-shot schedule —
deliberately, because building a second timer would mean two things to
keep running, two catch-up policies, and two places to look when
something does not arrive. So the obvious reading is that
`reminders.set` needs `schedule:create`, and therefore that the agent
may never set a reminder.

That reading produces a bad product. "Remind me to call the bank
tomorrow at ten" is close to the most ordinary thing anyone would say
to an assistant, and an assistant that answers "you will have to set
that one yourself" is failing at the easy case.

The opposite reading — give DERIVED `schedule:create` back — undoes 035
and hands the agent the ability to create arbitrary recurring runs.

## The decision

Reminders get their own capabilities, `reminder:read` and
`reminder:set`, and DERIVED has both. `schedule:create` stays exactly
where 035 left it.

This is a deviation from the spec's single-capability model and is
written down here rather than done quietly, per §36.

## Why this is not a loophole

What 035 was protecting is *standing authority to start work*. A
schedule can be recurring, carries an arbitrary payload, and wakes the
agent up to run a prompt of its own choosing. All three are what make
it dangerous in the hands of something downstream of a web page.

A reminder has none of them:

- it fires **once**, at an instant fixed when it is set;
- its payload is a **fixed sentence**, not a prompt the agent composes
  later;
- it must name an **owner** that already exists — a task or a calendar
  event the person wrote down — and `reminders.set` returns `not_found`
  if there is no such thing.

So the worst a compromised DERIVED step can do with `reminder:set` is
make the agent say something once, at a time, about an item the person
already has. That is noise, and it is visible noise: it shows up in the
reminder list and in the log. It is not a foothold.

Cancelling is still held at `minTrust: 'USER'` with `risk: 'dangerous'`,
on the same line decision 035 drew for `calendar.cancel` and
`tasks.drop`: the agent may add something visible and reversible; it may
not remove something the person asked for. Silently not telling someone
what they asked to be told is the one failure a reminder system cannot
have.

## What would change my mind

If reminders ever gain a recurrence field, or a free-text payload the
model fills in at fire time, this decision expires and the capability
should collapse back into `schedule:create`. Both of those changes
would reintroduce exactly the properties that make a schedule a
standing grant.
