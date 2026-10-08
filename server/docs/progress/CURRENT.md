# Where this is

Suite: **53 files / 725 tests / ~27 s**, `tsc` + lint clean, zero
`eslint-disable`. Schema **v11**. Last commits: mesh `1934509`, mesh demo
`f666e79`, exactly-once effects (this one).

> **The specification was replaced and the paste is truncated at §20.**
> Parts IV–VIII and Appendices A–H are missing — the 14 connectors, the
> 18 workflows, browser use, Veo integration, the M0–M18 table in §36,
> and Appendix E's 40 pre-answered decisions. Decision 018 lists the
> divergences already visible: Node 22+ vs our `>=20`, and three
> cognitive jobs (`page.extract`, `intent.parse`, `priority.score`) that
> §16.1 names and we do not have. Nothing beyond §20 has been guessed at.

## Built

- M0 substrate, M1 memory, M2 bitemporal memory, M3 plan-gate-execute.
- Personal intelligence: world model, claims, graph (`docs/PERSONAL_*.md`).
- Egress behind a guard (013). No inference call, ever.
- **Semantic layer (014)** — `capability/semantics/{ontology,manifest,broker}`.
  Nine objectives, seven connector manifests, a broker that returns a
  route or a refusal with a remedy.
- **OAuth (015)** — `capability/auth/{pkce,oauth,identities}`, PKCE,
  refresh-on-use, tokens in the vault, `identities` table.
- **Agent-to-agent mesh (017)** — `capability/mesh/*` plus
  `security/link.ts`. One protocol for in-device and between-device
  links: paired by a human-read code, sealed with directional keys,
  scoped by four grants, and FOREIGN on arrival. `POST /mesh/frame`
  answers 202 to everything so the port is not an oracle.
- **First connector wired (016)** — `capability/runtime/{types,gcal,
  invoke,health,observe}`. An objective goes in, Google Calendar is
  chosen, a token is spent, the answer lands as FOREIGN facts whose
  valid time is the event's own span.

- **Exactly-once external effects (018)** — `capability/outbox.ts`,
  schema v11. An effect is two events: intend before touching the world,
  commit after. A crash leaves a queryable intention instead of a
  silence. Reconciliation asks the provider where it can and a human
  where it cannot — **absence of a probe is never absence of the
  effect**, so nothing is ever blindly retried.

## The next concrete action

Surface `Outbox.needsAttention()` in the CLI and the web UI. The queue
exists and only a human can drain it; today nothing shows it to them.
No connector implements a probe yet either, so every real effect would
reconcile to `needs_attention`.

Then: drive `MeshAgent.expire()` from the orchestration tick. Today a request
whose answer never arrives stays pending until a caller expires it by
hand, which the tests do and nothing in the product does.

Then, in order:
1. The **loopback redirect listener** (`127.0.0.1:8899/oauth/callback`),
   still the last missing piece of sign-in.
2. A peers page in `server/web/`: show the pairing code, the
   confirmation words, and per-peer grants. Pairing is API-only today.
3. Feed `successRate` from the audit trail (§150).
4. A per-peer frame rate limit; the size is capped, the rate is not.

## Blocked / unresolved

- **The §49 Veo collision is still unraised with the user.** Three of the
  eleven permitted files already exist (`MemoryPanel.tsx`, `store.tsx`,
  `seed.ts`) and the proxy port is 7777, not 8787.
- Nothing is pushed: **10 commits ahead** of `MITfellow/veo` `main`.
- No real provider credentials, so no manifest is `AVAILABLE` in practice.

## Unsure (guesses that should be measured)

`MAX_VERBATIM_SPAN=32`, `MAX_LABEL=80`, M2 half-lives (7 d / 365 d / ∞),
`FOREIGN_CONFIDENCE_SCALE=0.5`, recall weights, `TIER_FLOOR`,
`DEFAULT_BUDGET`, `DEFAULT_TTL_MS=15 min`, 3-hop path limit, egress
defaults (**3 redirects is probably too few for a real sign-in flow**),
broker score weights `0.5/0.35/0.15`, `EXPIRY_SKEW_MS=60_000`.
