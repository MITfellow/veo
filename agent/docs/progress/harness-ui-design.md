# Connecting the whole harness to the whole UI — design note

Written before the code, per §36.

## The complaint

The agent serves **50 routes**. The Veo client calls **36**. Nine milestones
of runtime capability shipped behind an API that the only user-facing
surface in the product never asks for. A capability that exists, is
tested, and is unreachable from the UI is — from the user's seat —
indistinguishable from a capability that was never built. M9 found
exactly this failure once already (`createSecurity()` built, never
constructed by `main.ts`, for eight milestones). This is the same bug one
layer out: constructed by the composition root, never reached by the
client.

## The audit

### A. Routes the server serves and the client never calls

| Route | Status |
| --- | --- |
| `GET /vault/secrets` | **wire** |
| `POST /vault/secrets` | **wire** |
| `POST /vault/secrets/:name/rotate` | **wire** |
| `DELETE /vault/secrets/:name` | **wire** |
| `POST /vault/unlock` | **wire** |
| `POST /vault/lock` | **wire** |
| `POST /vault/panic` | **wire** |
| `GET /events` | **wire** |
| `GET /jobs/dead-letter` | **wire** |
| `POST /jobs/:id/replay` | **wire** |
| `GET /runs/:id/trace` (JSON) | **wire** — only `?format=text` was reachable |
| `POST /import` | **wire** |
| `GET /sessions` | deliberately not surfaced — see below |
| `PUT /constitution` | deliberately not surfaced — see below |

### B. Stream frames the client parses and then drops

`src/interface/stream.ts` emits eleven frame types. `dispatchFrame` in
`src/lib/agent.ts` handles seven and silently falls through four:

- `step-done` — per-step close, carrying the step's token spend.
- `degraded` — **the ladder changing level mid-run**. §27's whole point is
  that the agent says so when it is working with less. Dropping this
  frame is the UI telling a comfortable lie.
- `cancelled` — a cancelled run currently looks identical to a finished
  one.
- `resumed` — a run that came back from an approval suspension.

### C. Things with no UI at all

- No **stop button**. `agent.cancel()` exists in the client and `POST
  /runs/:id/cancel` exists on the server; nothing calls it. A run that
  goes wrong has to be waited out.
- No **"why did it say that?"**. `traceText()` exists and is called by
  nothing.
- No **vault screen**, so §13's secrets are unusable: there is no way to
  put the model API key anywhere except an environment variable, which is
  why every running install sits at L2.
- No **event log viewer**. The log is the system of record for everything
  else in the product and a person cannot look at it.

## Shape

Nothing new in the agent. This is all client, which is the correct answer
when the complaint is "the back end is ahead of the front end".

```
src/lib/agent.ts            + 12 methods, + 4 frame handlers
src/components/VaultPanel.tsx     new — §13 secrets, lock/unlock/panic
src/components/EventLogPanel.tsx  new — §30 the log, filtered, live
src/components/TraceSheet.tsx     new — §30 "why did it say that?"
src/components/SchedulePanel.tsx  + replay on a dead letter
src/components/Modals.tsx         + the two new panels
src/lib/store.tsx                 + cancelRun, + degraded notice, + runId on the bubble
src/components/Composer.tsx       + the stop button
src/components/MessageList.tsx    + the trace affordance on an agent bubble
src/types.ts                      Message.runId?
```

## Five positions

1. **The vault earns a screen of its own, not a row in Settings.** It is
   the only panel in the product where a wrong click is irreversible
   (panic). It gets its own confirmation grammar: `panic` requires typing
   the literal sentence the server already demands, and the client sends
   exactly that string rather than a boolean, so the client cannot be the
   thing that makes destruction easy.

2. **A secret's value is write-only in the UI.** `GET /vault/secrets`
   returns names and metadata, never plaintext, and the panel is built so
   there is no code path that would display a value even if the server
   started sending one.

3. **`degraded` becomes a system bubble in the thread, not a toast.** The
   degradation happened *to this run*; the honest place to say so is
   inside the conversation it affected, where it stays in the transcript.

4. **The trace opens from the bubble it explains.** A separate "traces"
   screen would make the user match run ids by eye. The message knows its
   `runId` — that is the join, and it costs one optional field.

5. **Two routes stay unsurfaced, on purpose, and the test knows their
   names.** `GET /sessions` would be a second conversation list competing
   with Veo's own (Veo owns chat identity; the agent's session is an
   implementation detail reached through `chat.agentSessionId`). `PUT
   /constitution` replaces the whole document in one shot, which defeats
   the article-level amendment history the constitution panel exists to
   show. Both are listed in `UNSURFACED` in the wiring test with these
   reasons, so the exemption is a decision on the record rather than an
   oversight that looks like one.

## Tests

### Unit — `src/lib/agent.test.ts` (12)
1. `events()` builds the query string from the filter and drops empty fields.
2. `events()` returns `{events,total}`.
3. `trace()` returns the parsed JSON trace.
4. `deadLetters()` returns the dead-letter list.
5. `replayJob()` POSTs to `/jobs/:id/replay`.
6. `vault()` returns state and the secret list.
7. `putSecret()` sends name and value, never logs the value.
8. `rotateSecret()` POSTs to the rotate route.
9. `deleteSecret()` DELETEs the named secret.
10. `unlockVault()`/`lockVault()` hit their routes.
11. `panicVault()` sends the literal confirmation sentence.
12. A 423 from any vault route surfaces as "the vault is locked".

### Unit — frame dispatch (4)
13. A `degraded` frame calls `onDegraded(level, detail)`.
14. A `cancelled` frame calls `onCancelled`.
15. A `step-done` frame calls `onStepDone(index, tokens)`.
16. A `resumed` frame calls `onResumed`.

### Integration — the reverse wiring audit (1, and it is the point)
17. **Every route in the server's table is called by the client**, except
    the names in `UNSURFACED`, each of which carries a reason. This is the
    mirror of M9's forward check and the test that would have caught all
    twelve gaps on the day they opened.

### e2e — `e2e/harness.spec.ts` (8)
18. The vault panel shows a state and an empty secret list on a fresh install.
19. Adding a secret lists it by name and never renders its value.
20. Lock then unlock round-trips; the list is hidden while locked.
21. Panic refuses until the exact sentence is typed.
22. The event log lists events and filters by type.
23. Sending a turn shows a stop button while the run is in flight.
24. An agent bubble offers the trace, and the trace names the model step.
25. A degraded run writes the degradation into the transcript.

## Not built

- No import UI beyond the client method: `POST /import` refuses a
  non-empty install by design (decision 038), so the only honest place for
  it is a first-run flow that does not exist yet. The method is wired and
  the route is marked surfaced; the button waits.
- No live tail on the event log. `GET /events` is a tail slice with no
  cursor (a carried weak point); building a poll loop on top of a route
  that cannot express "since" would paper over the gap rather than close
  it. Refresh is a button.
