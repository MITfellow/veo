# 010 — Browsing is a run, and an action is a tool call

**Status:** accepted
**Closes:** the gap `BROWSER.md` admitted — browsing was observable but not
replayable.

## The problem

Decision 009 claimed a browsing session is "replayable and auditable after
the fact". It was not. The session emitted a `SessionEvents` record per
step and the API kept a transcript in memory; nothing reached the event
log. Restart the process and the whole session was gone.

The obvious fix is four new event types — `browser.planned`,
`browser.navigated`, `browser.acted`, `browser.refused` — and a
`browser_steps` projection. I did not do that, for two reasons.

**The event-type union is closed (decision 003).** Adding a family is a
real change to a thing M0 deliberately sealed, and it should be paid for
with more than convenience.

**Browsing is not special.** Everything the browser needs recorded — "I
committed to this before I looked", "I invoked this, at this risk tier,
against this target", "it was refused for this reason" — is what *every*
tool needs recorded. A `browser_steps` table is the shape of a system
where the next capability gets `email_steps` and the one after that gets
`files_steps`, and no one can answer "what did the agent do yesterday"
without a union across five tables.

## The decision

**A browsing session is a run. Each action is a tool call.** No new event
types; five existing members of the closed union get their schemas
registered:

| Event | Carries |
| --- | --- |
| `run.started` | the goal |
| `run.planned` | the sealed plan — kinds, budget, origins, private-data flag, autonomy, **seal** |
| `tool.invoked` | call id, tool, a bounded action summary, a bounded target, the risk tier |
| `tool.succeeded` | call id, a bounded detail |
| `tool.failed` | call id, failure kind, detail |
| `tool.denied` | call id, **refusal code**, reason |
| `run.finished` | stop reason, step count |

One new projection, `tool_calls`, with the obvious columns and two
indexes. Browsing is audited today; every tool built after this inherits
the audit for free.

### `run.planned` is the interesting one

It is appended **before a page is read**, which is the whole point. The
log shows what the agent agreed to do before it saw the thing that might
have wanted it to do something else, and the seal makes later tampering
detectable without re-deriving anything.

### Nothing in the log may carry page prose

`action` is `open https://blog.example/injection`, not a URL with its
query string. `target` is an origin, a ref, or a form index. `detail` is
`3 affordance(s) on …`. All bounded, all capped by schema.

This is not tidiness. **The log is read back by the privileged path on
replay**, so a record is an input to the privileged path, and decision 007
already settled that a summary of FOREIGN content is FOREIGN. A log line
that quoted a page would reintroduce, through the audit trail, exactly the
channel decision 009 closed. The scale test asserts seven hostile phrases
are absent from ten thousand bytes of log.

## What this cost

The M0 rebuild-identity gate failed the moment `tool_calls` joined
`PROJECTION_TABLES` — it asserts **every** projection has rows before
comparing, so a new empty table makes it compare emptiness to emptiness
and it says so. The fix was to make the 10k workload emit tool calls,
including all three terminal outcomes and one call deliberately left open.
That gate has now caught a real problem twice; it is worth its runtime.

## And a bug, found by running

The recorder first tracked only `callId`. When an action was permitted by
the gate and then failed downstream, its call stayed open — and the *next*
refusal was written onto the abandoned row, while the action actually
refused got no row at all. Against the live binary a three-action session
produced two rows, one of them wrong.

The recorder now tracks `{ callId, action }`, so a refusal only claims a
call that belongs to the same action, and an action that supersedes an
open call closes it as `abandoned` first. Some refusals can only be
decided after the gate — an href is unknown until the ref is dereferenced
— so `BrowserError` carries the policy `code` with the throw rather than
having the catch site guess it.

**Every test passed before this was fixed.** It took four `curl`s against
a real server.

## Consequences

- **`arish` can answer "what did it do, and what was it refused".** One
  table, one query, across every tool.
- **A denial is first-class.** `tool.denied` carries the refusal code, so
  "how often does the Rule of Two actually fire" is a `GROUP BY`.
- **An interrupted call stays `invoked`.** That is the truth and it must
  survive a rebuild; the 10k workload includes one on purpose.
- **The schema is at v6.** Migrations are additive and the gate proves the
  rebuild is identical, so this is not a breaking change.
- Still deferred: `run.step.started` / `run.step.finished` are registered
  in `EVENT_TYPES` but not in the schema registry. Nothing emits them yet
  and registering a schema nothing produces is how registries rot.
