# Where this is

Suite: **49 files / 645 tests / ~26 s**, `tsc` + lint clean, zero
`eslint-disable`. Schema **v9**. Last commits: semantic layer `f5232c8`,
OAuth (this one).

## Built

- M0 substrate, M1 memory, M2 bitemporal memory, M3 plan-gate-execute.
- Personal intelligence: world model, claims, graph (`docs/PERSONAL_*.md`).
- Egress behind a guard (013). No inference call, ever.
- **Semantic layer (014)** — `capability/semantics/{ontology,manifest,broker}`.
  Nine objectives, seven connector manifests, a broker that returns a
  route or a refusal with a remedy.
- **OAuth (015)** — `capability/auth/{pkce,oauth,identities}`, PKCE,
  refresh-on-use, tokens in the vault, `identities` table.

## The next concrete action

Wire **one** connector end to end — `gcal` read-only is the smallest
honest choice — so that `broker.route('READ_CURRENT_STATE')` produces a
route, `withAccessToken` spends a token, `Egress` makes the call, and the
result lands as a FOREIGN-trust fact. Everything it needs now exists;
nothing yet joins them.

Order inside that:
1. A `ConnectorRuntime` interface: given a route and a token, perform
   the operation. One implementation, `gcal`.
2. A health reporter, so `BrokerContext.health` stops being a test fixture.
3. The loopback redirect listener (`127.0.0.1:8899`), which is the last
   missing piece of the sign-in flow.
4. Feed `successRate` from the audit trail (§150).

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
