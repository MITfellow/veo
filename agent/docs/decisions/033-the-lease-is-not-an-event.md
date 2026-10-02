# 033 — The lease is not an event

**Status:** accepted · **Milestone:** M8 · **Spec:** §8, §28, invariant 1

## The ambiguity

Invariant 1 says every state change is an event. §28 wants a durable
queue with leases, so a worker that dies cannot strand a job. Taken
literally, the two produce `job.leased` and `job.lease_renewed` events —
one every few seconds per in-flight job, forever, in the same log that is
supposed to be the auditable record of what the agent *did*.

## The decision

`lease_until` and `lease_token` are **operational columns on `jobs`, not
events**. The log records the facts that matter — `job.enqueued`,
`job.started`, `job.succeeded`, `job.failed`, `job.deadlettered`,
`job.replayed` — and the lease is treated as what it is: a mutex with a
timeout, scoped to one process's attempt at one job.

Three consequences, all deliberate:

1. **`lease_until IS NULL` counts as expired.** A crash between writing
   `job.started` and writing the lease would otherwise strand the job in
   `leased` with no expiry, forever. The lease check is
   `lease_until IS NULL OR lease_until <= now`.
2. **Fencing is by token.** `complete()` and `fail()` take the
   `leaseToken` they were handed and no-op if the row's token has moved
   on. A worker that pauses past its lease, wakes up and reports success
   cannot overwrite the result of the worker that took over.
3. **Projector `reset` clears both columns.** Rebuilding the log from
   scratch must not resurrect a lease held by a process that no longer
   exists. This is the one place the "lease is not an event" position
   costs something, and clearing on reset is the whole price.

## What this rules out

Replaying the log does **not** reproduce lease history. If you need to
know why a specific job took three attempts, the `job.failed` events
carry the attempt number and the error; they do not tell you which
worker held it. We accept that: the question "which of my two workers ran
this" is an operations question about a single-user, single-process
system that currently has one worker.

## The related spec gap

§29's endpoint list predates the scheduler: it names `GET /degradation`
but no schedules or jobs routes at all, even though §28 requires a
"dead-letter table **with inspection**" and §28's whole point is
behaviour the user cannot see happening. Saying so out loud rather than
quietly deviating (§36): M8 adds `GET/POST /schedules`,
`PATCH/DELETE /schedules/:id`, `GET /jobs`, `GET /jobs/dead-letter`,
`POST /jobs/:id/replay`, and — also listed in §29 and not built until a
milestone needed it — `GET /events`. All are bearer-authenticated and
`cache-control: no-store` like everything else.
