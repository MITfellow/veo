# Personal Intelligence — Forensic Analysis (Phase 0)

**Method:** every claim below was obtained by reading or running the repository
on 2026-10-07, not by recalling what was built. Commands are quoted so each
finding can be re-derived.

---

## 0. The headline finding: the brief describes a repository that is partly not this one

The brief opens by stating what already exists:

> The frontend already exists. **The model already exists.** A substantial
> harness already exists. **Connectors already exist in various forms.**
> **Browser support already exists.** Memory already exists. Trust/governance
> already exists. Durable execution already exists.

Four of those are true. Three are not, and the plan depends on them.

| Brief's premise | Reality in this repo | Evidence |
|---|---|---|
| The frontend exists | **True** | `src/` — 79 `.ts/.tsx`, React 19 + Vite, IndexedDB |
| A substantial harness exists | **True, twice over** | `agent/` 132 files, `server/` 68 files |
| Memory exists | **True** | `facts`, `entities`, `entity_aliases`, `items` tables; bitemporal |
| Trust/governance exists | **True** | trust lattice, Rule of Two, approvals, budgets, quarantine |
| Durable execution exists | **True in `agent/`** | `orchestration/{queue,worker,cron,snapshot}.ts` |
| **The model already exists** | **False** | no provider configured; no key; `server/` forbids one by construction |
| **Connectors already exist** | **Catalogue only** | 15 entries, 5 `available`, 7 `blocked`; **zero** provider implementations |
| **Browser support exists (Playwright)** | **False** | `grep -rn "playwright\|puppeteer\|chromium" server/ agent/` → **no matches** |

This is not pedantry. §18–§48, §100, §132 and §142 — roughly a third of the
brief — are instructions to *converge* Gmail, Calendar, Drive, Discord and
GitHub into one world model. There is nothing to converge. Building them is
not convergence, it is net-new network, OAuth and secret-handling work, and it
collides head-on with the standing constraints recorded in
`docs/decisions/001–012`. §2 of the governing spec and decision 001 say this
build makes **no network call and attaches no model**.

**This contradiction cannot be resolved by an agent. It is recorded here and
raised with the user.** Everything below is what is true regardless of how
it is resolved.

---

## 1. There are two ARISH platforms in this repository

```
find agent/src -name '*.ts' | wc -l   → 132      find agent/test -name '*.test.ts' | wc -l → 92
find server/src -name '*.ts' | wc -l  →  68      server suite: 43 files, 535 tests, 16.8 s
```

**`agent/`** — the original platform, M0–M9 complete, vendored via `git subtree`.
Subsystems: `adapters`, `capability`, `cognition`, `interface`, `observability`,
`orchestration`, `portability`, `providers`, `security`, `substrate`, `tools`.
It has what the brief's inventory list names almost item for item: context
assembly, calibration, persona, search, calendar, tasks, reminders, queue,
scheduler, snapshot, degradation, governed model calls, outbox, egress.

**`server/`** — the current build, M0–M3 complete, written under a spec whose
first rule is **no model, ever**. Subsystems: `substrate`, `security`,
`capability`, `cognition`, `orchestration`, `interface`.

**The brief's inventory is `agent/`'s inventory. The work of the last six
milestones is `server/`'s.** They do not import each other — decision 001
forbids it — and they have different event logs, different schemas and
different CLIs.

**This is the single largest piece of disconnection in the repository, and no
amount of new code inside either one fixes it.**

---

## 2. What is genuinely implemented

**Substrate (both platforms).** Append-only hash-chained event log; validate →
redact → hash → insert → project in one transaction; canonical JSON; 28 event
types in a closed union with per-type zod payload schemas and upcasters;
projections are strictly derived — 10k events → drop every projection →
replay → **byte-identical digest**, enforced by test.

**Bitemporal facts (`server/src/capability/memory/store.ts`).** Real, and the
§5 requirement is already met: `valid_from`/`valid_to` are world time,
`recorded_at`/`retracted_at` are knowledge time. `supersede()` closes valid
time; `correct()` and `retract()` close transaction time. `asOf()` answers
"what did we believe then". **The brief's §5 asks for something that exists.**

**Trust lattice (`server/src/security/trust.ts`).** `USER > SYSTEM > DERIVED >
TOOL > FOREIGN`, nine capabilities, `FOREIGN_DENIED`, `FOREIGN_AUTONOMY_CAP = 1`.
External content cannot raise its own authority — §66, §67 and §112 are
implemented and adversarially tested (116 adversarial assertions).

**Quarantine (`src/security/quarantine.ts`, decision 007).** Untrusted content
enters a side table, never a fact; extraction refuses any string > 32 chars
that is a substring of its source. §112 holds.

**Execution policy (M3, decision 012).** One gate chain — plan → budget →
Rule of Two → capabilities/trust → autonomy → call — with no second path to a
tool, asserted structurally by reading the source tree.

**Vault.** Argon2id + XChaCha-style sealing, per-item keys, panic, shredding.

**Honest degradation.** `arish doctor` reports `model: none configured — L1`.
Nothing claims an intelligence it does not have. §117 and §166 are already the
house style.

---

## 3. What is partially implemented

| Subsystem | What exists | What is missing for "personal" |
|---|---|---|
| Entities (`memory/entities.ts`) | create, rename (keeps alias), merge (cycle-safe), lexical `candidates()` | **no types beyond a `kind` string, no relationships at all** |
| Facts | subject–predicate–object, bitemporal, trust-scaled confidence | triples cannot express a graph; no scope; no "current world vs memory" split |
| Recall | lexical, explainable (`0.5·lexical + 0.3·confidence + 0.2·recency + 0.25·pinned`) | no graph traversal, no source-aware retrieval, no cross-source ranking |
| Connectors | 15 declared, trust-tagged, honest about being blocked | **no manifest of read/write entities, side effects, verification, failure modes** (§19) |
| Tools | contract-declared, 6 built-ins | names are mechanical (`memory.assert`), not semantic (`SEND_EXTERNAL_MESSAGE`) (§20) |
| Browser (`capability/browser/`) | HTML tokenizer/parser, affordance view, plan, driver, session, 72 adversarial tests | **no transport** — it can parse a page it is handed, not fetch one |
| Cognition | 11 jobs, deterministic baselines, inert `ModelStrategy` | baselines are pattern extractors; no planning, no synthesis |

---

## 4. What is simulated

**`src/lib/bot.ts` — the frontend fabricates intelligence locally.**

```ts
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const BY_PERSONA: Record<Contact['persona'], string[]> = { partner: [...], friend: [...] }
```

Persona-keyed canned replies chosen with `Math.random()`. This is exactly
§118's finding, and it was *by design* for Veo-the-iMessage-clone. It is not
wired to ARISH, and it must not remain responsible for the agent experience.

**It is not the whole story, though:** `src/lib/agent.ts` already talks to the
real runtime over `/agent/*` HTTP + SSE, deliberately not `EventSource`, with
the token attached by the dev proxy so the browser never holds it. **The
bridge §119 asks for exists.** What is missing is that the Agent thread is one
contact among many rather than the product.

**`http.fetch` in `server/`** returns `{ok: false, code: 'no_transport'}`. That
is declared, tested and honest — a real contract with no transport (§2), not a
simulation pretending to work.

---

## 5. What is disconnected

1. **`agent/` ↔ `server/`.** Two platforms, two event logs, no bridge.
2. **`server/` ↔ frontend.** `server/web/` is a separate vanilla-JS onboarding
   UI on :8787. Veo talks to `agent/` on :7777. The M0–M3 work has **no**
   presence in the product the user sees.
3. **Connector catalogue ↔ capability system.** `connectors.ts` is a list for
   a UI page. Nothing in the executor can route to a connector.
4. **Browser ↔ executor.** Browsing is its own run loop with its own audit
   writer (`capability/browser/record.ts`), named as a known divergence in
   decision 012. §30's "strengthen rather than duplicate" is live advice.
5. **Jobs ↔ execution.** The 11 cognitive jobs are reachable from ingest and
   the CLI, not from planning. Nothing *plans* — plans come from a JSON file.

---

## 6. What is duplicated

- Two event logs, two schemas, two migration chains, two CLIs.
- Two tier tables: `capability/browser/plan.ts` `{observe:1, interact:2, effect:4}`
  vs M3's `{1,2,3}` + irreversible⇒L4 (decision 012, unresolved on purpose).
- Two audit writers: `orchestration/audit.ts` and `capability/browser/record.ts`.
- Two "memory" notions: `facts` (bitemporal triples) and `items` (sealed blobs).

---

## 7. What the model currently sees

**Nothing, because there is no model.** When one is attached, the cognition
registry hands a job a typed request with `temperature: 0` and a zod-validated
response schema. There is no system prompt anywhere in `server/`; there is no
`PERSONALITY_PROMPT.md`. §17 and §93 are satisfied by omission rather than by
design, which is a weaker position than it sounds — nothing has yet had to
resist the temptation.

## 8. What the model currently cannot see

Everything the brief's §1 asks about: who the user is, which identities they
hold, what they are doing, which project is active, which people are relevant,
what "this"/"him"/"tomorrow" refer to, what changed. **None of it exists as
data.** There is no `User`, no `Identity`, no `Project`, no `Scope`, no
relationship edge of any kind in either schema.

## 9. How context is assembled

In `server/`: it is not. A tool receives `{now, inputTrust, runId, stepIndex,
idempotencyKey, dryRun}` — six fields, none personal.
In `agent/`: `cognition/context/` assembles a window from recent messages +
recalled facts + persona. That is a **transcript**, not a world.

## 10–11. Memory retrieval, connector representation

Covered in §3 above: lexical recall with an explainable score; connectors are
UI catalogue entries with trust labels.

## 12. How browser state enters cognition

It does not. A browser run writes `tool.*` events; nothing reads them back
into context.

## 13. How user identity is resolved

**It does not exist.** `actor` is a free string (`'user:ara'`, `'agent'`,
`'system'`). There is no identity table, no provider, no account, no scope.
§6 is unbuilt in both platforms.

## 14. How current application state enters context

It does not.

## 15. How external data becomes memory

`Quarantine.admitAsync` → `memory.extract` baseline → facts at
`FOREIGN_CONFIDENCE_SCALE = 0.5`. The path is real and safe; what it extracts
is pattern-matched, not understood.

## 16. How the frontend interacts with the real agent

`src/lib/agent.ts` → `/agent/*` → `agent/src/interface/http.ts` + SSE stream,
token injected by the Vite proxy. Real, and the right shape.

## 17. Which client behaviour still uses local simulation

`src/lib/bot.ts` (random canned replies), `src/lib/contacts.ts`,
`src/data/seed.ts` (contacts directory; conversations were removed at the
user's instruction — the app starts empty).

## 18. Which parts know nothing about the user's world

The executor, the tool layer, the planner, the browser, the connector
catalogue, and every one of the 11 cognitive jobs. **All of them.** The only
user-specific state in `server/` is whatever facts the user typed into
`arish memory add`.

---

## The honest conclusion

The repository is a **very strong substrate with no world on top of it.**

Event sourcing, bitemporality, trust, quarantine, approvals, budgets, the gate
chain — the parts that are hardest to retrofit and most boring to build — are
done and adversarially tested. §63, §64, §65, §110 and §112 are not work items
here; they are already the architecture.

What is absent is precisely what the brief calls the first principle: **there
is no representation of this particular human's world.** No user, no identity,
no project, no person, no relationship, no scope, no current-vs-remembered
distinction, no observation/inference provenance.

That is Phase 1 and Phase 2, and it is buildable **today, offline, with no
model and no connector** — because a world model is a data architecture, not
an integration. Everything in §3–§17 of the brief can be built and tested
against a replayable synthetic world (§173–§175) with zero network.

Phases 8–11 (connector manifests, cross-connector normalisation) can be built
as far as **manifests and routing over the existing catalogue**; they cannot
be *populated* without network, OAuth and secrets, which is the decision the
user must make.

**Next action: Phase 1 (canonical domain contracts) and Phase 2 (Personal
World Model), in `server/`, on the existing event log.**
