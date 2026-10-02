# BUILD PROMPT — Personal Agent Harness (Kernel)

> Hand this entire document to the coding agent as its task. It is a specification,
> not a suggestion. Build **only** what is described here. Do not add product
> features, do not add browser automation, do not add integrations. Those come
> later as plugins — and they will only be good if this kernel is right.

---

## 0. Mission

Build the **harness**: the durable runtime that a single person's agent runs inside,
for years.

Not a chatbot. Not a wrapper around a model API. A small operating system for one
person's agent, where:

- every single thing the agent ever perceived, decided, or did is recorded as an
  immutable event, and can be replayed;
- what the model sees on any given turn is **assembled deliberately** by code we
  own, measured in tokens, and testable;
- the agent learns the person over months — their facts, preferences, people,
  projects, rhythms, taboos — and that learning is inspectable and editable by
  the person, not buried in an opaque vector store;
- adding a new capability later (browser, email, calendar, shell, phone) is
  writing one plugin file that satisfies a contract, with **zero changes to the
  kernel**.

### The one-sentence test for every design decision

> *"Will this still be correct, debuggable, and personal after 3 years, 200,000
> events, 12 tool plugins, and 4 model-provider swaps?"*

If no, redesign it.

---

## 1. Principles (binding — violating these is a bug, not a style choice)

1. **Durability over cleverness.** State lives in an append-only event log in a
   real database with transactions. In-memory state is always a *projection* of
   the log and must be rebuildable from it.
2. **Resumability.** The process can be killed at any instruction. On restart,
   every interrupted run resumes or fails cleanly — never silently loses a step,
   never double-executes a non-idempotent tool.
3. **The context window is a build artifact.** Context is produced by a pure,
   deterministic function of (state, budget, policy). It can be snapshotted,
   diffed, and asserted on in tests. No string concatenation scattered across
   the codebase.
4. **Memory has provenance.** Every remembered fact knows where it came from,
   when, how confident we are, and what superseded it. A fact with no source is
   not a fact.
5. **The person owns the model of themselves.** Everything the agent believes
   about the user is readable, editable, and deletable through the API. No
   hidden profile.
6. **Capabilities are explicit.** A tool cannot touch anything it was not granted.
   Dangerous actions require a typed approval that is itself an event.
7. **The kernel knows nothing about any specific tool.** No `if (tool === 'browser')`
   anywhere. Ever.
8. **Everything is observable.** Every run emits a trace. If you cannot answer
   "why did it say that?" from stored data alone, the harness is incomplete.
9. **Boring, few dependencies.** Prefer the standard library and one well-chosen
   database over frameworks. No LangChain-style abstraction layers.
10. **Tests are part of the deliverable.** A milestone without its tests is not
    done.

### Non-goals (explicitly out of scope for this build)

- Multi-tenancy at scale (design for **one** person, but do not hardcode
  `user_id = 1` — keep a `principal` concept so it is not a rewrite later).
- Browser automation, email, calendar, RAG over documents, voice, mobile.
- Fine-tuning, training, embeddings infrastructure beyond a pluggable interface.
- A UI. The frontend already exists and talks to this over the API in §9.

---

## 2. Stack

- **Language:** TypeScript, strict mode, Node 22+, ESM. No `any` (`unknown` + a
  parser instead). Compile with `tsc`; no transpile-only shortcuts in CI.
- **Database:** SQLite via `better-sqlite3`, WAL mode, in a single file.
  - It is correct for one person: synchronous, transactional, zero-ops,
    embeddable, and fast enough for millions of events.
  - **But:** all SQL lives behind a `Storage` port (§3). Writing a Postgres
    adapter later must touch no other file.
- **Validation:** one schema library (`zod` or equivalent) used for *all*
  boundaries: tool inputs/outputs, API bodies, model structured output, config,
  and event payloads. Types are derived from schemas, never duplicated.
- **Transport:** plain HTTP + SSE (Node `http` or a thin router). No GraphQL.
- **Jobs:** an in-process worker loop over a DB-backed queue table. No Redis, no
  external broker.
- **Tests:** `vitest`. Unit + integration + replay/golden tests.
- Everything runs with `npm install && npm run dev` and **no cloud services**
  except the model provider (which must be mockable so the full suite runs
  offline and deterministically).

---

## 3. Architecture

Layered, with dependencies pointing **inward only**. Each layer is a directory
and may only import from layers below it.

```
                 ┌──────────────────────────────────────────┐
  L5  Interface  │ HTTP API · SSE stream · approval endpoints │
                 └──────────────────────────────────────────┘
                 ┌──────────────────────────────────────────┐
  L4  Orchestr.  │ Runner · Scheduler · Queue · Consolidator │
                 └──────────────────────────────────────────┘
                 ┌──────────────────────────────────────────┐
  L3  Cognition  │ Context Assembler · Memory · Persona      │
                 └──────────────────────────────────────────┘
                 ┌──────────────────────────────────────────┐
  L2  Capability │ Tool Registry · Sandbox · Policy/Approval │
                 └──────────────────────────────────────────┘
                 ┌──────────────────────────────────────────┐
  L1  Substrate  │ Event Log · Storage port · Clock · IDs ·  │
                 │ Model port · Config · Logger · Secrets    │
                 └──────────────────────────────────────────┘
```

**Ports (interfaces) defined at L1, implementations injected at startup:**
`Storage`, `ModelProvider`, `Embedder`, `Clock`, `Ids`, `Secrets`, `Logger`,
`FileStore`. Every one has an in-memory/fake implementation used by tests. The
whole harness must be constructible in a test with fakes in under 20 lines.

**Suggested layout**

```
src/
  substrate/   events.ts  storage/  ports.ts  clock.ts  ids.ts  config.ts  log.ts  secrets.ts
  capability/  registry.ts  invoke.ts  policy.ts  approvals.ts  sandbox.ts  artifacts.ts
  cognition/   context/  memory/  persona/  compaction.ts  tokens.ts
  orchestration/ runner.ts  steps.ts  queue.ts  scheduler.ts  consolidate.ts  interrupt.ts
  interface/   http.ts  routes/  stream.ts  auth.ts
  tools/       (built-in reference plugins only — see §6.5)
  index.ts
test/
  unit/  integration/  replay/  golden/  fakes/
```

---

## 4. L1 — Substrate

### 4.1 Event log (the spine)

One append-only table. Nothing in the system mutates history.

```ts
interface Event {
  id: string;            // ULID — monotonic, sortable, no coordination needed
  seq: number;           // global autoincrement, the true total order
  ts: number;            // epoch ms from the Clock port (never Date.now() directly)
  principal: string;     // whose agent this is
  sessionId: string | null;
  runId: string | null;
  stepId: string | null;
  type: EventType;       // closed discriminated union — see below
  payload: unknown;      // validated by a per-type schema
  causationId: string | null;  // the event that directly caused this one
  correlationId: string;       // ties a whole causal chain together
  schemaVersion: number;
}
```

`EventType` is a **closed union** with a schema per type. Minimum set:

```
session.created   session.titled    session.archived
message.user      message.agent     message.system
run.started       run.finished      run.failed       run.cancelled
step.started      step.finished
model.requested   model.responded   model.failed
tool.requested    tool.started      tool.succeeded   tool.failed   tool.timedout
approval.requested approval.granted approval.denied  approval.expired
memory.observed   memory.written    memory.updated   memory.superseded
memory.recalled   memory.forgotten  memory.corrected
context.assembled
artifact.created
schedule.fired
policy.denied
error.raised
```

Requirements:
- Append is **synchronous and transactional**. A tool result and the event
  recording it commit together or not at all.
- **Event upcasting:** a `migrations/events/` directory of pure functions that
  upgrade old payload versions to current on read. Old events are never
  rewritten. Add a test that loads a fixture log from "version 1" and reads it
  with today's code.
- Reads: by seq range, by session, by run, by type, by correlation. Indexed.
- Hash chain (optional but recommended): each event stores
  `prevHash`/`hash` so tampering or corruption is detectable. Cheap, and it
  makes the log trustworthy as an audit record.

### 4.2 Projections

Derived, rebuildable tables: `sessions`, `runs`, `messages`, `memory_*`,
`approvals`, `queue`, `schedules`. Each has a `rebuild()` from the log.

**Acceptance test:** delete every projection table, run `rebuild-all`, and the
resulting bytes are identical to before. This test is non-negotiable — it is
what proves the log is actually the source of truth.

### 4.3 Model port

```ts
interface ModelProvider {
  id: string;
  generate(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelDelta>;
  countTokens(input: TokenCountable): Promise<number>;
  capabilities: { tools: boolean; structuredOutput: boolean; vision: boolean;
                  caching: boolean; maxContext: number; maxOutput: number };
}
```

- Provider-neutral message/tool-call shapes; adapters normalize each vendor.
  The kernel must never see a vendor-specific field.
- Streaming is the only path (non-streaming = consume the stream).
- Records `model.requested` / `model.responded` with full request+response,
  token counts, cost, latency, finish reason, and `cacheHit`.
- Retries with jittered backoff on transient failures; classify errors into
  `transient | invalid_request | context_overflow | content_filter | auth | quota`.
- `context_overflow` must **not** be a crash: it triggers compaction (§5.4) and
  one retry at a smaller budget.
- A `FakeModel` that replays scripted responses from fixtures, so every test is
  deterministic and offline.

### 4.4 Clock, Ids, Config, Secrets

- `Clock` is injected everywhere. A test can advance time by 90 days in one call
  — you will need this to test memory decay and consolidation.
- `Ids` produces ULIDs; seeded fake for tests.
- Config: one typed, schema-validated object, loaded once, immutable at runtime.
- Secrets: never in the event log. A redaction pass runs on every payload before
  append, using registered secret values + pattern rules. Test it.

---

## 5. L3 — Cognition (the part that makes it personal)

This is the heart. Spend the most care here.

### 5.1 The problem being solved

A model is stateless. "Personal" is entirely an artifact of **what you choose to
put in front of it** and **what you choose to keep from what came back**. So the
harness needs two excellent, separable engines:

- **Context Assembler** — read path: what goes in.
- **Memory** — write path and store: what survives.

### 5.2 Context Assembler

A **pure function**:

```ts
assembleContext(input: {
  principal: string; sessionId: string; budget: TokenBudget;
  snapshot: StateSnapshot; policy: ContextPolicy; now: number;
}): AssembledContext
```

`AssembledContext` contains the ordered blocks, the exact token cost of each,
what was dropped and why, and a `digest` hash. It is logged as
`context.assembled` on every single turn. **This log entry is the single most
valuable debugging artifact in the system** — it lets you answer "why did it
behave that way" months later.

**Blocks, in priority order (highest priority survives the budget squeeze):**

| # | Block | Source | Typical budget |
|---|-------|--------|---------------|
| 1 | Kernel instructions — invariants, tool protocol, safety | static | fixed |
| 2 | Persona — how this agent speaks and decides, for this person | persona store | small |
| 3 | User model — identity card: who they are, hard constraints, taboos | memory (profile) | small, pinned |
| 4 | Situation — time, timezone, device, locale, what triggered this run | runtime | tiny |
| 5 | Active goals / open commitments | memory (procedural) | small |
| 6 | Pinned memories — user-pinned, never evicted | memory | small |
| 7 | Retrieved memories — scored for *this* turn | memory retrieval | medium |
| 8 | Working set — artifacts/files/entities currently in play | artifacts | medium |
| 9 | Conversation — recent turns verbatim | session | large |
| 10 | Compacted history — summaries of older turns, with pointers | compaction | medium |
| 11 | Tool schemas — only tools permitted for this run | registry | medium |

**Rules:**
- Budgets are **declared per block as percentages of the model's window**, not
  magic numbers in code. Config-driven, per-model.
- Every block renders through a named, versioned template. Templates live in
  files, not string literals in logic.
- Eviction is explicit and recorded: `{ block, droppedItems, reason }`.
- **Never silently truncate mid-structure.** Drop whole items, and say so in the
  context ("3 older messages summarized above").
- Assembler is sync, pure, and has zero I/O — it receives a `StateSnapshot`
  gathered beforehand. That is what makes it testable.

**Required tests:** golden snapshots of assembled context for ~10 scenarios
(empty session, long session, memory-heavy, tool-heavy, post-compaction, near
overflow). A diff in any golden file must be reviewed deliberately — these are
the behavioral contract of the agent.

### 5.3 Memory

Four stores, one interface. Do **not** build "a vector database and hope".

#### (a) Episodic — what happened
Derived from the event log. Each closed run produces an **episode**: what the
person asked, what was done, the outcome, entities touched, how it felt
(satisfied / corrected / abandoned). Episodes are the raw material for
consolidation.

#### (b) Semantic — facts and entities
```ts
interface Fact {
  id: string;
  subject: EntityRef;          // the person, a project, a contact, a device
  predicate: string;           // "prefers", "works_at", "allergic_to", "timezone"
  object: Json;
  confidence: number;          // 0..1
  sources: SourceRef[];        // events/messages that support it — REQUIRED
  firstObserved: number; lastConfirmed: number; observationCount: number;
  stability: 'volatile' | 'slow' | 'stable';  // drives decay rate
  sensitivity: 'normal' | 'private' | 'secret';
  supersedes: string | null; supersededBy: string | null;
  assertedBy: 'user' | 'inference';   // user statements outrank inferences
  pinned: boolean;
  status: 'active' | 'retired' | 'disputed';
}
```
Plus a lightweight **entity graph**: people, projects, places, orgs, devices,
accounts, with typed relations. This is what makes the agent able to say "your
sister Priya" rather than "a person you mentioned".

#### (c) Procedural — how this person wants things done
Learned operating rules: "always confirm before sending anything to work
contacts", "writes commit messages in imperative mood", "don't call before
10am", "prefers bullet points, hates preamble". Each rule has a trigger
condition, an instruction, a source, and a **track record** (times applied,
times the user overrode it). **Rules that keep getting overridden must decay and
retire automatically.** This feedback loop is what separates a harness that gets
*more* annoying over time from one that gets better.

#### (d) Affective/relational — tone calibration
Lightweight: formality level, humor tolerance, verbosity preference, how much
hedging they want, which topics are sensitive. Few fields, high impact. Derived,
never guessed from one sample.

#### Write path (`memory.observe`)
Candidate extraction runs **after** a run completes, off the critical path, as a
queued job — never blocking the user's response.

1. Extract candidate facts/rules from the episode (structured model call with a
   strict schema).
2. **Gate before writing** — reject: transient chatter, hypotheticals ("imagine
   I'm a doctor"), third-party content the user merely pasted, anything with no
   clear source span, anything the user asked not to remember.
3. **Deduplicate and reconcile** against existing facts:
   - identical → bump `observationCount`, `lastConfirmed`, raise confidence
   - contradictory → create new fact, mark old `supersededBy`, **keep both**
     (never delete history; a person's job, city and opinions change and the
     agent should know the trajectory)
   - uncertain → store as `disputed`, and allow the agent to ask the user once,
     at a natural moment.
4. Emit `memory.written` / `memory.updated` / `memory.superseded`.

#### Retrieval path (`memory.recall`)
Hybrid scoring — not cosine similarity alone:

```
score = w_sem * semanticSim        // embedding, via the Embedder port
      + w_lex * lexicalMatch       // SQLite FTS5 — catches names/IDs vectors miss
      + w_rec * recencyDecay       // exp decay, half-life by `stability`
      + w_imp * importance         // confidence × observationCount × user-pin
      + w_ent * entityOverlap      // entities active in this turn
      - w_pen * contradictionPenalty
```

- Weights live in config, are logged with every recall, and are tunable.
- **Diversity pass:** MMR-style, so the agent doesn't recall five phrasings of
  the same fact and waste the budget.
- Hard rules: pinned facts always included; `secret` facts excluded unless the
  run's policy allows; retired facts never recalled, only reachable by audit.
- Every recall emits `memory.recalled` with the candidates, the scores, and what
  made the cut. **When the agent says something wrong about the user, this log is
  how you find out why.**
- The `Embedder` port must have a deterministic fake (hash-based) so tests don't
  need a model.

#### Consolidation ("sleep")
A scheduled job — nightly, plus after every N episodes:
- distill episodes → durable facts and rules;
- merge near-duplicate facts; recompute confidence with decay;
- retire rules with bad track records;
- maintain a small, always-pinned **"user identity card"** (≤ ~400 tokens): the
  compressed essence of this person. This is what makes turn one of a brand-new
  session already feel like it knows them;
- write a rolling **"what I learned recently"** digest the user can read.

Consolidation must be **idempotent and replayable** — running it twice changes
nothing the second time. Test that.

#### User control (required, not optional)
API + events for: list memories, search, edit, pin, unpin, forget (tombstone,
with the tombstone itself an event), export everything as human-readable JSON,
"forget everything about X", and a global "don't remember this session" flag.
A person will only let an agent this deep into their life if they can see and
rip out what it knows.

### 5.4 Compaction

When the conversation block exceeds its budget:
- summarize the **oldest** contiguous chunk, never the newest;
- the summary is a structured object (decisions, open threads, entities,
  unresolved questions), not prose soup;
- it keeps **pointers to the event ids** it came from, so the agent can
  re-expand detail on demand via a built-in `history.expand` tool;
- compaction emits an event and is itself replayable.

Never destroy the original messages. Compaction is a view, not a deletion.

---

## 6. L2 — Capability

### 6.1 Tool contract (freeze this early — everything later depends on it)

```ts
interface Tool<I, O> {
  name: string;                     // stable, namespaced: "memory.recall"
  version: string;
  description: string;              // written for the model, not for docs
  input: Schema<I>;
  output: Schema<O>;
  capabilities: Capability[];       // e.g. ['net:read', 'fs:write:/x', 'spend:money']
  risk: 'safe' | 'caution' | 'dangerous';
  idempotent: boolean;
  timeoutMs: number;
  costHint?: (i: I) => number;
  execute(i: I, ctx: ToolContext): Promise<ToolResult<O>>;
  renderForModel(r: ToolResult<O>, budget: number): string;  // truncation OWNED BY THE TOOL
  dryRun?(i: I, ctx: ToolContext): Promise<string>;          // required if dangerous
}
```

`ToolContext` provides: `signal`, `principal`, `runId`, `stepId`, logger,
`emit()` for progress, a scoped `FileStore`, and **nothing else**. No ambient
global access. If a tool needs a capability, it is granted explicitly.

### 6.2 Results are structured, not strings

```ts
type ToolResult<O> =
  | { ok: true;  value: O; artifacts?: ArtifactRef[]; display?: Display; metrics?: Metrics }
  | { ok: false; error: { kind: ErrorKind; message: string; retryable: boolean; hint?: string } };
```

Big outputs (files, screenshots, HTML, long logs) go to the **artifact store** and
the model sees a short reference plus a summary. This single decision is what
will keep the context window sane when the browser tool arrives later.

### 6.3 Invocation rules

- Validate input against schema **before** execution; a validation failure is a
  normal, recoverable tool error that the model can read and correct — not a crash.
- Hard timeout via `AbortSignal`; tools must be cancellation-aware.
- **Idempotency keys:** `hash(tool, version, input, stepId)`. On resume after a
  crash, a completed non-idempotent call is never re-executed — its recorded
  result is replayed.
- Concurrency: tools declaring independence may run in parallel within a step,
  with a configurable cap. Mutating tools serialize.
- Every outcome is an event. Failure is data, not an exception that escapes.

### 6.4 Policy & approval

- Each run carries a **capability set**. A tool requiring a capability not in the
  set fails with `policy.denied` before executing. The model is told why, in
  words it can act on.
- `risk: 'dangerous'` → emit `approval.requested` (with the `dryRun` preview),
  **suspend the run durably**, and return. When the user answers via the API, the
  run resumes from exactly that step — not from the beginning.
- Approvals support: once / for this session / always for this tool+argument
  shape / deny. "Always" writes a procedural memory, closing the loop between
  permissions and personalization.
- Rate limits and spend caps per tool, per day — enforced in the kernel.

### 6.5 Built-in reference tools (only these — they prove the contract)

1. `memory.recall` — explicit lookup
2. `memory.remember` — deliberate "remember this" with user intent
3. `memory.forget`
4. `history.expand` — re-expand a compacted span
5. `clock.now` / `clock.schedule` — the agent can arrange to act later
6. `notes.write` / `notes.read` — a scoped durable scratchpad
7. `ask_user` — structured clarification that suspends and resumes the run

That is all. Everything else is a future plugin. **If adding plugin #8 requires
editing any file outside `tools/`, the contract failed and must be fixed before
proceeding.**

---

## 7. L4 — Orchestration

### 7.1 The run loop

```
trigger → create run (durably) → loop:
    gather snapshot → assemble context → call model (streaming)
      → parse into: text deltas | tool calls | finish
      → execute tools (policy → approval? → invoke → artifacts → events)
      → append observations
    until: finish | step cap | token cap | wall-clock cap | cancelled | suspended
→ finalize run → enqueue consolidation job
```

Requirements:
- Every iteration is a **step**, persisted before and after. A crash mid-step is
  recoverable because the step's state is on disk.
- Four independent stop conditions (steps, tokens, time, cost) — all configurable,
  all emitting a clear terminal reason. An agent that loops forever burning money
  is the classic harness failure; make it structurally impossible.
- **Loop detection:** identical tool+input three times in a row → inject a
  corrective observation, then abort with a useful message.
- **Cancellation** propagates through `AbortSignal` to the model stream and every
  running tool, and leaves consistent state.
- **Suspension** (approval, `ask_user`, scheduled wait) is first-class: the run is
  durably parked with zero resources held, and resumes on the triggering event.
  A suspended run must survive a full process restart. Test this explicitly.

### 7.2 Queue & scheduler

- DB-backed queue: `pending | leased | done | failed`, lease expiry, attempt
  count, exponential backoff, dead-letter table.
- Worker loop with graceful shutdown (finish current job, refuse new, flush).
- Scheduler: cron expressions and one-shot timers, persisted, timezone-aware,
  **catch-up policy** on restart (fire missed / skip / fire once — configurable).
  Firing emits `schedule.fired` and starts a run with a `trigger` context.
- This is what later allows proactive behavior ("remind me", "check this every
  morning") without any kernel change.

### 7.3 Concurrency model

One run per session at a time; multiple sessions may run concurrently.
Background jobs (consolidation, embedding) never block interactive runs — give
interactive work strict priority in the worker.

---

## 8. Persona

Small, but do it properly — it is the voice the person lives with.

- A versioned persona document: identity, voice, defaults, refusal style,
  verbosity, how to handle uncertainty, when to ask vs. act.
- **Composable layers:** base persona + user overrides (explicit settings) +
  learned adjustments (from affective memory). Layers merge deterministically
  and the merge result is logged.
- Editable by the user through the API; every change is an event, so you can see
  "the agent changed how it talks on this date, because of this."

---

## 9. L5 — API (what the existing frontend consumes)

HTTP + SSE. Typed request/response schemas shared with the client.

```
POST   /sessions                      create
GET    /sessions                      list (paged)
GET    /sessions/:id                  detail + messages
POST   /sessions/:id/messages         send; starts a run; returns runId
GET    /runs/:id/stream               SSE: token deltas, step boundaries, tool
                                      lifecycle, approval requests, done/error
POST   /runs/:id/cancel
POST   /approvals/:id                 { decision, scope }  → resumes the run
GET    /memory                        search / filter / page
PATCH  /memory/:id                    edit, pin, correct
DELETE /memory/:id                    forget (tombstone)
GET    /memory/identity-card          the pinned user model
GET    /persona  PUT /persona
GET    /events                        audit/debug, filterable
GET    /runs/:id/trace                full trace: context, model calls, tools
GET    /health  GET /metrics
POST   /export   POST /import         full account portability
```

SSE requirements: heartbeats, `Last-Event-ID` resume (replay from the event log
on reconnect — the client must never lose output because a laptop slept),
backpressure, and clean close on cancel.

Auth: single-principal bearer token now, but routed through an `auth` middleware
with a `Principal` object so multi-user is additive later.

---

## 10. Observability & evaluation

- **Trace per run**: the assembled context (with per-block token counts), every
  model request/response, every tool call, every memory recall with scores,
  timings, token and cost totals. Retrievable by run id. Renderable as readable
  text for debugging.
- **Replay harness**: `replay <runId>` re-executes a recorded run against the
  fake model with recorded tool results, and diffs the assembled contexts. This
  is how you refactor the cognition layer without fear.
- **Golden tests**: fixture conversations whose assembled contexts are snapshotted.
- **Memory evals** (write these — they are the real quality bar):
  - *Recall*: after a 50-episode synthetic history, does the agent surface the
    right fact for 20 probe questions?
  - *Precision*: does it avoid injecting irrelevant memories? Measure the share
    of recalled memories that are actually relevant.
  - *Update*: user changes jobs at episode 30 — at episode 40 does the agent use
    the new job and know the old one is history?
  - *Forget*: after `forget`, the fact never appears in any assembled context.
  - *Decay*: advance the fake clock 1 year; volatile facts fade, stable ones don't.
  - *Override*: a rule overridden 3 times retires itself.
- Structured logs with the correlation id on every line. Metrics: tokens, cost,
  latency per stage, tool success rates, memory hit rate, context utilization.

---

## 11. Milestones

Build strictly in order. **Each milestone ends with: tests green, `tsc` clean,
a short `docs/` note on what was built and what was deliberately deferred, and a
runnable demo script.** Do not start the next milestone before the previous one
is complete.

**M0 — Skeleton (foundations)**
Repo, strict TS, config, ports + fakes, logger, SQLite with migrations, event log
with append/read/hash-chain, ULIDs, injected clock, redaction, projection rebuild
+ the byte-identical rebuild test.
*Done when:* I can append 10k events, drop all projections, rebuild, and prove
identity.

**M1 — Minimal thinking loop**
Model port + one real adapter + FakeModel, streaming, run loop with step
persistence, stop conditions, cancellation, session/message projections, SSE.
*Done when:* a two-turn conversation streams to a curl client and the entire run
is reconstructible from the log alone.

**M2 — Tools**
Registry, schema validation, invoke pipeline, timeouts, idempotency, artifacts,
structured results, the 7 built-ins, parallel execution, loop detection.
*Done when:* killing the process mid-tool-call and restarting resumes correctly
and does not re-run a non-idempotent tool.

**M3 — Policy & approvals**
Capability sets, policy denial as a model-readable observation, dangerous-tool
approval flow with durable suspension and resume, approval scopes, rate/spend caps.
*Done when:* a dangerous tool parks the run, the process is restarted, the user
approves via the API, and the run completes correctly.

**M4 — Context Assembler**
Pure assembler, block system, per-model budgets, templates, eviction reporting,
`context.assembled` events, compaction + `history.expand`, overflow→compact→retry.
*Done when:* the golden context tests exist and a 200-turn session stays inside
budget with no loss of coherence.

**M5 — Memory (the milestone that matters most)**
All four stores, write gating, reconciliation/superseding, hybrid retrieval with
logged scores, FTS5 + embedder port, diversity, pinning, decay, full user CRUD +
export, consolidation job, identity card.
*Done when:* every memory eval in §10 passes, and a fresh session visibly knows
the person from turn one.

**M6 — Scheduling & proactivity**
Queue hardening, cron/one-shot schedules, catch-up policy, background runs,
priority, dead-letter handling.
*Done when:* "every weekday at 9am, do X" survives restarts and a timezone change.

**M7 — Persona, API completion, observability**
Persona layering + API, remaining endpoints, SSE resume, trace endpoint, replay
command, metrics, export/import of the entire account.
*Done when:* the frontend can drive everything, and `replay <runId>` reproduces a
run with a zero context diff.

**M8 — Hardening**
Fuzz the event upcasters, chaos test (kill at random points in 100 runs → zero
corrupt states), 100k-event performance pass, backup/restore, failure-mode docs.

---

## 12. Definition of done (for the whole harness)

1. Kill the process at any point in 100 randomized runs → every run is either
   cleanly resumable or cleanly failed. Zero corrupted state, zero duplicated
   side effects.
2. Delete all projections → full rebuild from the log → byte-identical state.
3. Add a new tool plugin touching only `tools/` and one registration line.
4. Swap the model provider by changing config only.
5. `replay <runId>` reproduces any historical run with a zero context diff.
6. The user can read, edit, pin, and delete everything the agent believes about
   them, and deletion is provably respected in every future context.
7. A 200-turn, 90-day simulated history still produces a coherent, in-budget
   context in under 100ms of assembler time.
8. Full test suite runs offline, deterministically, in under 60 seconds.
9. For any sentence the agent ever produced, a stored trace explains the exact
   context, memories, and tool results behind it.

---

## 13. Working agreement for the coding agent

- Before writing code for a milestone, write a short design note and the test
  list. Then implement.
- Commit per milestone with a descriptive message.
- When you hit an ambiguity, choose the option that is **more durable, more
  inspectable, and less coupled**, write the decision down in
  `docs/decisions/NNN-title.md` (one short page: context, decision, consequences),
  and continue. Do not stall.
- If a requirement here turns out to be wrong once you are in the code, say so
  explicitly with your reasoning and propose the alternative — do not silently
  deviate.
- Do not add dependencies without justifying them in the design note.
- Do not add features that are not in this document. The restraint is the point.
