# M8 — Time & proactivity · design note and test list

Written before any code, per §36. Spec: **§28** (queue and scheduler),
**§27** (degradation ladder), §19 (budgets), §26 (run loop), §12 (trust).

§33's bar: *"every weekday 9am" survives restarts, a timezone change and a
3-day outage, with correct catch-up.* That one sentence contains four hard
problems — persistence, cron semantics, DST, and what to do about time that
passed while the process was dead — and the honest answer to the fourth is
a *policy*, not an algorithm.

§28 closes with the claim this milestone has to earn: this is what enables
proactive behaviour **with zero kernel changes**. So nothing here may
special-case the run loop. A scheduled run is an ordinary run whose
`trigger` happens to be `'schedule'`.

---

## 1. What is already true

- `run.degraded`, `schedule.fired`, `schedule.missed` are already in the
  closed event set (M0 declared them; nothing emits them yet).
- `Runner.run({sessionId, principal, trigger, runId})` already accepts
  `trigger: 'schedule'`, and the Situation block already renders "this run
  was triggered by: …".
- `config.queue` already carries `pollIntervalMs`, `maxAttempts`,
  `baseBackoffMs`, `leaseMs` — declared at M0 so they would not be
  forgotten, unused since.
- `trust.ts` already gates a `schedule:create` capability.
- `RunnerDeps.degradation?: () => string` exists and always returns `'L0'`.

Nothing has to be unpicked. M8 fills in declared holes.

## 2. Shape

Six files, all L4/L5, no new dependencies — Node's full-ICU `Intl` does the
timezone arithmetic.

```
src/orchestration/cron.ts         pure: parse a 5-field spec, next fire after t in tz
src/orchestration/queue.ts        JobQueue: enqueue / lease / complete / fail / dead-letter
src/orchestration/worker.ts       Worker: tick(), start(), stop() — graceful
src/orchestration/schedule.ts     ScheduleStore: CRUD + due() + catch-up
src/orchestration/degradation.ts  the L0–L4 ladder as a state machine
src/substrate/projections/jobs.ts jobs + schedules read models
```

New events (closed set 69 → 78):

```
job.enqueued  job.started  job.succeeded  job.failed  job.dead_lettered
schedule.created  schedule.updated  schedule.deleted
degradation.changed
```

Migration `011` adds `jobs`, `job_dead_letters`, `schedules`.

## 3. Five positions, stated before the code

**3.1 A lease is not an event.** Everything about a job's *life* goes in the
log — enqueued, started, succeeded, failed, dead-lettered — and the `jobs`
table is a projection of those. The **lease is not**. A lease is a
60-second claim by a process that may already be dead; writing one to an
append-only log would flood it with facts that are false moments later, and
§10's rebuild would then have to reconstruct leases held by processes that
no longer exist. On rebuild, every lease is empty — which is *correct*,
because a rebuild implies a restart, and a restart voids every claim.
`lease_until` and `lease_token` are therefore operational columns the
projector resets. (Decision 033.)

**3.2 Catch-up is a policy the user chooses, and the default is
`fire-once`.** After a three-day outage, "every weekday 9am" has missed
three fires. Firing all three is almost always wrong (three identical
morning briefings at 2pm). Firing none silently is also wrong. The default
is: fire the most recent missed slot once, and emit `schedule.missed` for
each one skipped so the record is complete. `fire-all` is available and is
**bounded** by `maxCatchUp`; the remainder are `missed`. An unbounded
fire-all is a self-inflicted denial of service after any long weekend.

**3.3 DST is resolved by the wall clock, never by the offset.** "9am" means
the thing a person's kitchen clock says. The next-fire search walks forward
in *local wall-clock minutes* and converts to an instant with `Intl`, so:
on a spring-forward day a 02:30 fire lands at the first existing local
minute after the gap, once; on a fall-back day a 01:30 fire that occurs
twice fires **once**, because `lastFiredAt` is an instant and the second
occurrence is not strictly after it. There is no offset arithmetic
anywhere in this milestone.

**3.4 Interactive beats background, by not starting.** §28 says interactive
runs have strict priority. The worker takes a `busy()` predicate and will
not lease while an interactive run is in flight. It does **not** preempt a
background job that is already running: cancelling a half-finished run to
shave latency off another one trades a visible cost for an invisible one.
Stated as a cost, not sold as a feature.

**3.5 Degradation is a level computed from signals, not a variable that is
set.** `report('embedder', …)` and `clear('embedder')`; the level is the
maximum of what is currently wrong. Setting a variable means the last
caller wins, so clearing the embedder failure would quietly announce L0
while the vault is still locked. Transitions — and only transitions — emit
`degradation.changed`, so a flapping embedder cannot flood the log.

## 4. What the agent gains

A proactive run is: a schedule row whose payload is a prompt, a job, a
worker tick, and `Runner.run({trigger:'schedule'})`. No kernel change, as
§28 promised. The only thing M8 adds to the run itself is that the
Situation block names the schedule.

## 5. Test list — 61 tests

### Unit — cron (`test/unit/cron.test.ts`) · 1–12
1. parses the five fields; rejects garbage with a readable error (table)
2. `*/15`, ranges, lists, and steps over ranges
3. day-of-week accepts names, and `7` means Sunday
4. "every weekday 9am" → Mon–Fri only
5. the next fire is **strictly after** the instant given, never equal
6. day-of-month and day-of-week both restricted = OR (crontab semantics)
7. `Asia/Kolkata` 9am is 03:30Z and does not drift over a year
8. spring forward: a fire inside the skipped hour lands at the first
   existing local minute, exactly once
9. fall back: a fire inside the repeated hour happens exactly once
10. across both transitions, "9am New York" stays 9am local
11. a one-shot has exactly one fire and then none
12. an unsatisfiable spec (Feb 30) returns `null` rather than searching forever

### Unit — queue (`test/unit/queue.test.ts`) · 13–24
13. enqueue → pending, inspectable, `job.enqueued` written
14. lease marks it leased, sets `lease_until`, increments attempts
15. a leased job is invisible to a second lease (no double delivery)
16. an expired lease makes the job available again
17. complete → done, never delivered again
18. failure backs off exponentially with jitter, within computed bounds,
    deterministic under the seeded rng
19. past `maxAttempts` → dead-letter, reason and payload preserved
20. a dead letter is inspectable and can be replayed back onto the queue
21. ordering: priority, then `runAfter`, then insertion (FIFO within a tier)
22. a job with `runAfter` in the future is not leased
23. an idempotency key that is already pending does not enqueue a second job
24. rebuild: job states come back from the log; **leases do not** (3.1)

### Unit — degradation (`test/unit/degradation.test.ts`) · 25–31
25. starts at L0 with no signals
26. an embedder failure → L1, and one `degradation.changed`
27. the level is the max of active signals, not the most recent
28. clearing one signal falls to the next-highest, not to L0
29. the same signal reported twice writes one event, not two
30. each transition records from, to, and why
31. the Situation block tells the user which mode they are in

### Integration — worker (`test/integration/worker.test.ts`) · 32–40
32. a tick leases and runs exactly one job
33. a throwing handler retries, then dead-letters
34. no background job starts while an interactive run is in flight
35. completing with a stale lease token is refused (fencing)
36. two workers on one queue never run the same job
37. after a restart, leased jobs return only once the lease expires
38. `stop()` finishes the current job, refuses new ones, leaves nothing leased
39. a scheduled job produces a real run with `trigger: 'schedule'`
40. a background run obeys the same budgets as an interactive one

### Integration — scheduler (`test/integration/scheduler.test.ts`) · 41–50
41. create / list / update / delete, each with its event
42. a due schedule enqueues exactly one job per fire
43. two ticks inside the same minute do not double-fire
44. catch-up `skip`: a 3-day outage fires nothing and emits one
    `schedule.missed` per missed slot
45. catch-up `fire-once`: exactly one run, for the most recent missed slot
46. catch-up `fire-all`: bounded by `maxCatchUp`, remainder reported missed
47. changing the timezone re-anchors the next fire to the new wall clock
48. **the headline (§33)**: "every weekday 9am" across a restart, a
    timezone change and a 3-day outage — correct catch-up, no double fire
49. a failed scheduled run retries as a *job*; the schedule does not re-fire
50. deleting a schedule cancels its pending jobs

### HTTP (`test/integration/schedule-api.test.ts`) · 51–56
51. `POST/GET/DELETE /schedules`
52. `GET /jobs` and `GET /jobs/dead-letter`
53. `POST /jobs/:id/replay` requeues a dead letter
54. `GET /degradation` returns level, signals and what is unavailable
55. every one of these refuses an unauthenticated caller
56. a bad cron spec is 400 with the parse error, not 500

### Adversarial (`test/adversarial/scheduling.test.ts`) · 57–60
57. a schedule cannot be created from FOREIGN-trust content
58. a spec that would fire every minute forever is rejected below
    `MIN_INTERVAL_MS` — the agent cannot schedule its own denial of service
59. a clock that jumps backwards (NTP correction) neither double-fires nor stalls
60. a job payload cannot smuggle a different principal — the principal comes
    from the schedule row

### Golden · 61
61. a scheduled run's assembled context names the trigger and the schedule

---

## 6. Deliberately not built

- **Sagas and compensations for scheduled chains** (§18's second paragraph).
  M3 built the outbox; multi-step compensation is M9 territory and nothing
  in M8 needs it.
- **A second worker process.** The queue is safe for two workers (test 36)
  but the product runs one. Horizontal scale is not a personal agent's
  problem.
- **Natural-language schedules** ("remind me every other Tuesday"). That is
  a parsing feature wearing a scheduling costume, and it belongs in a tool,
  not in the scheduler.
- **Proactive *initiative*** — the agent deciding on its own what is worth
  waking up for. M8 builds the clock, not the ambition. §24.2's ask budget
  already exists to govern that when it comes.
