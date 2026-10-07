# Where this is

Suite: **49 files / 661 tests / ~19 s**, `tsc` + lint clean, zero
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
- **First connector wired (016)** — `capability/runtime/{types,gcal,
  invoke,health,observe}`. An objective goes in, Google Calendar is
  chosen, a token is spent, the answer lands as FOREIGN facts whose
  valid time is the event's own span.

## The next concrete action

The **loopback redirect listener** — `127.0.0.1:8899/oauth/callback` —
which is the last missing piece of sign-in. Everything either side of it
exists: `OAuthClient.begin()` produces the URL to open, `complete()`
takes the callback URL. Nothing currently receives that callback.

Then, in order:
1. Feed `successRate` from the audit trail (§150); it is a constant 0.5
   for every connector today.
2. A second connector, to prove the first one's shape generalises.
   `gmail` read-only is the natural pair.
3. Surface connected accounts in `server/web/` — the connectors page
   lists catalogue entries and cannot yet sign anything in.

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
