# ARISH

The durable runtime a personal agent lives inside. Not a chatbot and not a
model wrapper — the substrate that makes an agent's memory, decisions and
mistakes survivable over a decade.

**Status: M0 (Substrate) complete.** M1–M9 are specified and not yet built.

```bash
npm install
npm run demo        # the four M0 claims, end to end, in ~2 seconds
npm test            # 81 tests, offline, deterministic, ~13s
npm run typecheck
npm run verify-chain -- /tmp/arish-demo.db
```

## The one idea

The event log is the only source of truth. Everything else — sessions,
messages, runs, entities, the entire memory — is a projection that can be
thrown away and rebuilt from the log alone, byte for byte. That is not an
aspiration in a design doc; it is a test:

```
test/integration/rebuild-identity.test.ts
  append 10,000 events → snapshot → DELETE every derived table → replay → compare bytes
```

If that test ever fails, some piece of the agent's state is living somewhere a
backup would not capture, and the ten-year promise is void. It is not to be
weakened to make something else pass.

## What M0 gives you

| | |
|---|---|
| **Append-only log** | 51 typed events, zod-validated per type, `UPDATE`/`DELETE` blocked by database triggers |
| **Hash chain** | every event hashes its predecessor; `verifyChain` tells a sequence gap from a broken link from an edited payload |
| **Redaction before append** | secrets are stripped inside `append()`, so no call site can forget |
| **Bitemporal facts** | valid time *and* transaction time, kept separate on purpose |
| **Upcasters** | old events are read forward, never rewritten — and migrating a schema does not break the chain |
| **Deterministic everything** | clock, ids and randomness are injected ports; a seeded run reproduces byte-identically |

## Two timelines, three answers

The thing that makes an agent auditable rather than merely confident:

```
January   we learn Maya works at Acme
June      Maya tells us she moved to Globex — in April

"where does she work now?"        → Globex
"where did she work in March?"    → Acme    (valid time: true of the world)
"what did you believe in March?"  → Acme    (transaction time: true of me)
```

Those last two coincide here because we were out of date, not wrong. Had we
simply misheard her, they would differ — and being able to say *which*
happened is the difference between an agent that can be corrected and one that
can only be doubted. See `docs/decisions/005-*`.

## Layout

```
src/substrate/      L1 — ports, clock, ids, config, hashing, event log, storage, projections
src/security/       L2 — vault, keys, trust, capabilities        (M1)
src/capability/     L3 — tools, outbox, policy, approvals        (M3–M4)
src/cognition/      L4 — context assembly, memory, calibration   (M5–M7)
src/orchestration/  L5 — runs, scheduler, queue                  (M8)
src/interface/      L6 — HTTP + SSE                              (M9)
src/tools/          the only place a tool name may appear
```

Dependencies point inward only. Nothing in `src/substrate` knows a tool exists.

## Working rules

Carried from the specification, and enforced in review rather than assumed:

- No `Date.now()`, `Math.random()`, `randomUUID()` or `fetch` in kernel code —
  ports only. This is what makes a three-year-old run reproducible.
- A schema is the single definition of a shape. Types are derived from it, never
  written alongside it.
- Never weaken a test to make it pass. The tests encode the architecture.
- On an ambiguity: take the more durable, more inspectable, less coupled, safer-
  when-wrong option; write it down in `docs/decisions/`; keep going.
- If the specification is wrong, say so out loud and propose the alternative
  rather than deviating quietly. (This has happened twice — see decisions 004
  and 005.)

## Documents

- `docs/progress/M0-design.md` — the design note and 38-item test list, written
  before any implementation
- `docs/progress/M0.md` — what was built, what was found, what was deferred and
  what I am still unsure about
- `docs/decisions/` — six decisions, including the two places this deviates
  from the specification and why
