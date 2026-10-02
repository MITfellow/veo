# M2 — Thinking loop · design note and test list

**Spec:** §26 run loop · §27 degradation · §29 API · §30 observability · §8
ports · §32 budgets.
**Done when:** a two-turn conversation streams to `curl` **and the whole run is
reconstructible from the log alone.**

Written before the code, per §36.

---

## 1. What M2 is, and what it deliberately is not

M2 builds the loop that turns a message into a run: model port, a real
streaming adapter, a deterministic fake, step persistence, every stop
condition, cancellation, durable suspension, sessions, and SSE.

**Not** in M2, and the loop must be shaped so adding them changes no kernel
code:

| Deferred to | What |
|---|---|
| M3 | actually *executing* tools; the outbox; egress |
| M4 | policy, approvals, budgets as enforcement |
| M5 | the real Context Assembler, compaction, eviction |
| M6 | memory recall and write |

M2 parses tool calls out of the model stream and records them as
`tool.requested`, then stops the run with `reason: 'tools-unavailable'`. The
*shape* of the tool path is exercised end to end; only the execution is
missing. That keeps M3 additive.

The context sent to the model in M2 is built by a deliberately small pure
function (§5 below). It gets replaced wholesale at M5. Making it pure and
budgeted *now* means M5 swaps an implementation, not a design.

---

## 2. The model port (L1)

§8 declared `ModelProvider` at M0 with `unknown` payloads so the layering was
visible. M2 gives it real types.

```ts
generate(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>
```

**Streaming is the only mode.** There is no `complete()` returning a whole
response. A non-streaming provider is trivially expressible as a one-chunk
stream; the reverse costs you first-token latency forever, and §32 budgets
first token at <1.5s.

`ModelChunk` is a discriminated union, zod-validated at the port boundary
because a provider is an external surface:

```
{type:'text-delta',  text}
{type:'tool-call',   id, name, input}      // input: unknown, validated at M3
{type:'usage',       inputTokens, outputTokens, costMicros}
{type:'finish',      reason: 'stop'|'length'|'tool-calls'|'content-filter'}
{type:'error',       kind, message, retryable}
```

An **`error` chunk, not a thrown exception**, for provider failure mid-stream
(invariant 13: failure is data). A stream that has already emitted 400 tokens
and then dies must be able to say so without discarding those tokens.

### Adapters

- **`FakeModel`** (`test/fakes/model.ts`) — scripted, deterministic, replays a
  programmed sequence of chunks per call, counts tokens as a pure function of
  the text, honours `AbortSignal` mid-stream, and can be told to fail, stall,
  or emit malformed chunks. Every test uses it; the suite stays offline (§6).
- **`OpenAIAdapter`** (`src/substrate/model/openai.ts`) — one real adapter,
  SSE parsing over the `Net` port (never `fetch` directly, §8). Its API key is
  a **vault reference**, resolved through `useSecret` at call time, and the
  outbound request goes through `firewall.assertClean` before it leaves. It
  has **no test that hits the network**; its SSE frame parser is pure and
  tested against recorded bytes.

**Token counting**: the port exposes `countTokens`. The fake counts
characters/4 deterministically. Real tokenizers are a model-specific
dependency; §32's budgets need an *estimate* that is stable, not exact, and a
wrong-by-10% estimate with a safety margin beats a 2MB tokenizer per provider.
Recorded as a decision.

---

## 3. The run loop (L5, `src/orchestration/runner.ts`)

```
trigger → run.started → loop:
    step.started  (persisted BEFORE anything happens)
      → assemble context (pure)
      → model.requested
      → stream: text-delta* → usage → finish
      → model.responded | model.failed
      → parse: text | tool calls
      → tool.requested per call   (M3 executes; M2 stops here)
    step.finished (persisted AFTER)
  until stop condition
→ run.finished | run.failed | run.cancelled | run.suspended
```

**The step is the unit of recovery.** `step.started` is appended *before* the
model is called and `step.finished` after, so a process killed at any
instruction (invariant 3) leaves a log that says exactly how far it got. A run
with a `step.started` and no matching `step.finished` is an interrupted step,
and that is detectable without any extra bookkeeping.

### Stop conditions — all six, each its own reason

§26 names four caps; cancellation and suspension are also terminal for the
loop. Every one produces a distinct, named reason in `run.finished`, because
"the run stopped" without saying why is an unexplained output (invariant 15).

| Reason | Trigger |
|---|---|
| `stop` | the model emitted `finish:'stop'` with no tool calls |
| `step-cap` | step index reached `limits.maxSteps` |
| `token-cap` | cumulative tokens ≥ `limits.maxTokens` |
| `time-cap` | `clock.now() - startedAt` ≥ `limits.maxWallMs` |
| `cost-cap` | cumulative `costMicros` ≥ `limits.maxCostMicros` |
| `cancelled` | `/runs/:id/cancel` → `AbortSignal` |
| `suspended` | approval / ask / wait — parks durably |

Caps are checked **before** starting a step, never mid-stream: killing a model
call halfway to save 200 tokens wastes the 2000 already spent and leaves a
partial response nobody can use.

### Cancellation

One `AbortController` per run. `cancel()` aborts the model stream; the loop
catches the abort, appends `run.cancelled`, and leaves consistent state — the
partial text already streamed is kept and recorded, because the user watched
it appear and must not see it vanish.

### Suspension

A suspended run **holds zero resources**: the loop returns, the controller is
dropped, and `run.suspended` records what it is waiting for. Resuming
rebuilds state from the log and appends `run.resumed`. The test for this kills
the whole process (new `Runner`, new everything, same database) and resumes.

### Loop detection (§26)

Identical `tool + canonicalJson(input)` three times in one run → inject a
corrective observation; a fourth → abort with a message that names the tool
and the repeated input. The hash of the canonical input is the key, which is
why `canonicalJson` lives at M0.

---

## 4. Sessions and runs are projections, not tables of record

`session.created`, `message.user`, `message.agent`, `run.*`, `step.*` are
already in the §9 closed union. Sessions, messages, runs and steps are
therefore **projections** (decision 008: the projection set grows per
milestone), each with its events listed and each covered by
`rebuild-identity`.

This is what makes the "done when" literally true: drop every projection,
replay the log, and the conversation comes back byte-identical.

---

## 5. Context assembly in M2 (a placeholder that is honest about it)

`src/cognition/context/assemble.ts` exports a **pure** function:

```ts
assembleContext(input: AssemblyInput): AssembledContext
```

- pure: no clock, no storage, no I/O — session events in, messages out
- deterministic: same input, same output, asserted by a golden test
- budgeted: takes `maxTokens`, drops oldest turns first, and **reports what it
  evicted** rather than silently truncating
- logged: the assembled context is recorded on `model.requested` as block
  names + token counts (never the full text — that would double the log)

M2 ships three blocks: `system` (persona stub), `history`, `situation`
(current time, degradation level). §21's full fourteen arrive at M5.

FOREIGN content is **fenced** even in M2 — wrapped in explicit delimiters that
say the content is untrusted data and not instructions. M4 removes the fence
to prove the refusal does not depend on it; the fence is defence in depth, not
the mechanism.

---

## 6. Interface (L6, `src/interface/`)

Node's built-in `node:http`. No express, no fastify — the API in §29 is ~20
routes with no middleware ecosystem needed, and a web framework is a
ten-year dependency with a CVE cadence. Routing is a small table.

M2 subset of §29:

```
POST /sessions                 GET /sessions          GET /sessions/:id
POST /sessions/:id/messages    → { runId }
GET  /runs/:id/stream          SSE
POST /runs/:id/cancel
GET  /runs/:id/trace
GET  /health
```

### SSE

- `Last-Event-ID` resume, replayed **from the event log** — the sequence
  number is the SSE id, so a sleeping laptop reconnects and loses nothing.
  This is why resumability is free: the log already has every delta.
- heartbeat comments every 15s against idle-proxy timeouts
- clean close on cancel, on run end, and on client disconnect
- backpressure: respect `write()` returning false, await `drain`

Auth (§15) is a bearer token bound to a device record, `Principal` flowing
through everything, never a hardcoded user id. M2 ships the `Principal` flow
and a single-token check; device records and revocation are M9.

---

## 7. Test list (written before the code)

### `test/unit/model-chunks.test.ts`
1. every chunk shape validates; an unknown `type` is rejected at the boundary
2. a malformed chunk from a provider raises a typed error naming the provider
3. `finish` reasons are a closed set
4. usage accumulates across chunks rather than overwriting

### `test/unit/fake-model.test.ts`
5. replays its script deterministically — same seed, identical chunk sequence
6. honours `AbortSignal` mid-stream and stops emitting
7. can script an `error` chunk after N text deltas
8. `countTokens` is pure and stable

### `test/unit/context-assembly.test.ts`
9. pure: same input → deeply equal output, twice
10. deterministic across two fresh processes (golden file)
11. respects the token budget; drops **oldest** first
12. reports evictions — what was dropped and why — rather than silently cutting
13. FOREIGN content is fenced with explicit untrusted-data delimiters
14. system block is always present even at a brutally small budget

### `test/unit/sse.test.ts`
15. frames text deltas as valid SSE with monotonic ids
16. `Last-Event-ID` replays from that sequence number, no gap and no repeat
17. heartbeats emitted on an idle stream
18. a comment/heartbeat never parses as a data event

### `test/integration/run-loop.test.ts`
19. a one-turn run: `run.started` → `step.*` → `message.agent` → `run.finished`
20. **two-turn conversation**: the second turn sees the first in its context
21. `step.started` is appended before the model is called (kill-safety)
22. step cap stops the run with `reason:'step-cap'`
23. token cap stops with `reason:'token-cap'`
24. time cap stops with `reason:'time-cap'` using `FakeClock`
25. cost cap stops with `reason:'cost-cap'`
26. a provider `error` chunk → `model.failed` → `run.failed`, partial text kept
27. cancellation mid-stream → `run.cancelled`, partial text kept, state clean
28. tool calls parsed → `tool.requested` appended → stops `tools-unavailable`
29. loop detection: 3 identical calls → corrective observation; 4th → abort
30. every event carries the run's `correlationId`

### `test/integration/run-reconstruction.test.ts` — **the M2 bar**
31. drop every projection, replay the log, byte-identical sessions/messages/runs/steps
32. the full transcript of a run is reconstructible from events alone
33. a run interrupted mid-step (no `step.finished`) is detectable and resumable
34. **a killed process**: new Runner, same DB, suspended run resumes correctly
35. the trace (§30) renders from the log with context blocks, tokens, timings

### `test/integration/http.test.ts`
36. `POST /sessions` → `GET /sessions/:id` round-trip
37. `POST /messages` returns a `runId` immediately, before the run finishes
38. `GET /runs/:id/stream` streams deltas then a terminal event
39. `POST /runs/:id/cancel` ends the stream cleanly
40. SSE reconnect with `Last-Event-ID` loses nothing
41. unauthenticated requests are refused; the decision is auditable
42. `GET /health` reports degradation level

### `test/adversarial/loop-safety.test.ts`
43. a model that never emits `finish` is stopped by the step cap, not hung
44. a model emitting 10k tiny deltas does not blow memory or the token cap check
45. a provider that throws (rather than emitting `error`) is still recorded as
    `model.failed` and does not corrupt the run
46. an abort during the *first* chunk leaves a well-formed cancelled run
47. two concurrent runs in one session do not interleave their events

### `test/golden/context.test.ts`
48. the assembled context for a fixed 12-turn session matches a committed
    golden file, so any change to assembly is visible in review

---

## 8. Risks

- **The loop is the thing everything else hangs off.** Getting the step
  boundary wrong is expensive to fix at M5. Mitigation: persist before/after,
  and make the step a pure data record, not an object with behaviour.
- **SSE resume looks easy and is not.** Mitigation: ids are event sequence
  numbers, replay is a log read, and there is a test that reconnects.
- **Temptation to let the runner reach into memory or tools directly.** The
  runner takes them as injected interfaces that do not exist yet; M2 wires
  no-op implementations so M3/M6 substitute rather than edit.

## 9. Budget

§32: first token < 1.5s excluding model time; append < 2ms (held at M0);
assembly < 100ms (M5's target, measured from M2). Suite stays < 60s.
