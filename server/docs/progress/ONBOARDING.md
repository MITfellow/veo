# Onboarding surface + Cognitive Jobs

Out-of-band work, between M1 and M2, recorded as **decision 008**. The
milestone order is broken once, deliberately, and this note says exactly
what was built so the deviation is auditable rather than absorbed.

**Verified by running:** `npm run check` → **244 tests, 25 files, 10.5s**
(60s budget), `tsc --noEmit` exit 0, `eslint . --max-warnings 0` clean.
`arish serve` was driven in a real browser; every claim below was observed,
not inferred.

## Built

### The Cognitive Job layer (`src/cognition/`) — the part that matters

Eleven jobs, each with a deterministic baseline that ships working and a
model strategy that is fully written and inert.

| Job | Baseline |
| --- | --- |
| `text.summarize` | Extractive — ranks sentences by term frequency with a positional prior, keeps original order |
| `history.compact` | Keeps the opening turn and the last N, states how many were dropped |
| `content.classify` | Ordered shape rules, reports which signal fired |
| `brief.compose` | Groups facts by subject, commitments by due date |
| `draft.compose` | Template; `needsReview` always true |
| `turn.generate` | Reports what it found and what it plans, citing context lines |
| `memory.extract` | Eight explicit patterns; silent rather than speculative |
| `entity.resolve` | Exact → alias → token overlap, **null on ambiguity** |
| `memory.consolidate` | Collapses restatements, escalates contradictions |
| `rule.induce` | Frequency counting above a support threshold |
| `quarantine.extract` | Counts, flags and bounded single-word terms only |

**One decision point.** `selectStrategy` in `registry.ts` is the only place
in the platform that asks whether a model exists. `test/unit/jobs.test.ts`
asserts the §59.17 claim directly: with only the config object changed, all
eleven jobs move from baseline to model.

**The seam is one function.** `ModelProvider = (request) => Promise<string>`.
Prompts, parsers, schemas, token ceilings and temperature are all built and
tested now; a test supplies a fake provider and the model path runs end to
end. A configured model with no provider throws `model_not_attached` rather
than silently falling back — a quiet fallback would hide a misconfiguration
behind a plausible answer.

### The Get Started surface (`web/`, `src/interface/{http,api}.ts`)

Four steps — about, connectors, model, ready — laid out like the Windows 11
Get Started page from the reference screenshot. No framework, no build step,
no external asset; three files served by `node:http` over loopback. Still
two runtime dependencies.

Twelve connectors in five local and seven blocked. **Blocked ones are shown
with the reason stated on the card**, because "coming soon" that looks
identical to "working" is how someone comes to trust an integration that
does nothing. A blocked connector can still be chosen — the intent is
recorded — but the API returns `effective: false` and always will until the
missing capability exists.

Enabling a combination that holds all three Rule of Two properties raises a
warning **at the moment of choosing**, not at the moment of acting.

### Also

- **`FileStore` port** (`src/substrate/files.ts`), which M0 deferred. Now the
  only `node:fs` in the platform, and the ban is what forced the right
  design — `readWithin` refuses traversal, and "missing" is indistinguishable
  from "escaped" because the difference is itself information.
- **`arish serve`**, and `doctor` grew two checks: `11 cognitive jobs, all on
  deterministic baselines` and `5 ready, 7 blocked on network/OAuth`.
- **`model` config section** — the entire attachment surface, with the API key
  as a `secret://` reference because §23 forbids a credential in config.

## Three bugs the work found

1. **`memory.extract` matched nothing.** The patterns were written lowercase
   with no `i` flag, so every properly capitalised sentence — i.e. all of
   them — extracted zero facts. The fix is case-tolerant *triggers* with
   case-**sensitive** captures, since capitalisation is the only signal
   separating a name from a common noun. Regression test added.
2. **The UI ate `<name>`.** A server string went through `innerHTML` and
   `arish vault set <name>` rendered as `arish vault set `. The `html:`
   option is now deleted from the DOM helper entirely, and the SVG icons
   build through `createElementNS`. There is no `innerHTML` in the UI.
3. **The model page echoed a pasted API key.** If you typed a real key into
   the reference field, `envExample` reflected it straight back into the
   response body. It now only echoes a value that is already a `secret://`
   reference, and detects the mistake specifically: *"That looks like the
   key itself, not a reference to it."*

All three were invisible to review and immediate under execution.

## Deferred

- **No provider transport**, by design (§2). This is the whole point.
- **Connectors do not yet read anything.** The catalogue, trust declarations,
  capability sets, persistence and risk analysis are real; the adapters that
  actually open a file or parse an `.ics` are M6's. A connector marked
  `available` means "nothing in the platform blocks it", not "it is pulling
  data" — and the UI says so.
- **Connector state is not evented.** It is a durable table like the vault
  (decision 006), but enabling one should probably append a
  `policy.evaluated` event. Needs a decision on the event family first.
- **No authentication on the HTTP surface.** Loopback-only is the current
  control. Acceptable for a single-user local agent, insufficient the moment
  `--host` is anything else. `serve` should probably refuse a non-loopback
  host without a token.

## Unsure

- **`turn.generate`'s baseline is the weakest of the eleven** and I think
  that is correct rather than fixable. The others degrade gracefully; a
  conversational turn without a model is a report, and no amount of
  templating changes that. It is the clearest argument for attaching a model
  and the page says so plainly.
- **Twelve connectors may already be too many** for a first run. The Windows
  page shows six. Five local ones are honest; the seven blocked ones might
  be better behind a "show what's coming" disclosure.
- **`looksLikeRawKey` uses a length heuristic** (>24 chars) alongside known
  prefixes. It will occasionally scold someone about an unusual but valid
  reference format. I would rather be wrong in that direction.
