# Failure modes

What breaks, how you will notice, what to do, and what it costs. §33 asks
M9 for this document; §27 is the reason it exists at all — *silent
degradation is forbidden*, and a failure mode nobody wrote down is a
failure mode that will be experienced silently.

Ordered by how likely you are to meet them.

---

## 1. No model is configured

**Looks like:** every answer begins "I can't answer that without a
language model." `/health` and `/degradation` say **L2**. Settings →
Standing instructions shows an amber banner.

**Is:** `ARISH_API_KEY` is unset, so the composition root wired
`OfflineProvider`. Tools still run; the clock still works; memory is
still written. Only generation is missing.

**Do:** set `ARISH_API_KEY` (and optionally `ARISH_MODEL`,
`ARISH_BASE_URL`) and restart. Nothing is lost by running offline first —
the log, the memory and the constitution are all provider-independent.

**Cost:** answers are canned. Everything else is real.

---

## 2. The vault is locked

**Looks like:** anything touching a secret returns **423** with "the
vault is locked — unlock it first". `/degradation` says **L4**.

**Is:** the keyring holds no unwrapped master key — either it was never
initialised, or `POST /vault/lock` was called, or the process restarted
(keys are never persisted unwrapped; a restart always locks).

**Do:** `POST /vault/unlock { passphrase }`. On a fresh install the same
call initialises the keyring and returns a **recovery code shown exactly
once** — write it down, because nothing in the system can show it again.

**Cost:** tools that need credentials refuse. Everything that does not
touch a secret is unaffected, deliberately: a locked vault must not take
the whole agent down.

---

## 3. The embedder is unavailable

**Looks like:** `/degradation` reports **L1**: "recall is lexical and
recency-based, so it may miss paraphrases."

**Is:** semantic scoring is off; hybrid retrieval falls back to FTS5 plus
recency plus importance.

**Do:** usually nothing — the shipped `HashEmbedder` has no network
dependency, so this only appears if a remote embedder is wired.

**Cost:** recall gets worse at paraphrase ("where do I work" vs
"employer") and stays fine at keywords. Nothing is lost; it is found less
often.

---

## 4. The process dies mid-run

**Looks like:** a run whose `state` is `running` with nobody running it;
a half-streamed answer in the UI that stops.

**Is:** exactly what invariant 3 anticipates. Everything committed to
SQLite survived; everything in memory did not.

**Do:** nothing manual. On restart: suspended runs are resumable, the
outbox reconciler decides the fate of any unsettled external effect
(**it never retries on its own** — see §18), and the queue's leases
expire so background jobs are picked up again. `test/chaos/` kills at 200
randomized points and asserts exactly this.

**Cost:** the interrupted answer is gone — the user re-asks. No
duplicated external effect, ever: that is the one thing the outbox is for.

---

## 5. An external effect is in an unknown state

**Looks like:** `POST /jobs` shows nothing wrong, but an `effect` row
sits in `intended` and reconciliation reports `needs-attention`.

**Is:** the process died between recording the intent and learning the
outcome, and the remote cannot be queried to settle it.

**Do:** look at it. The system will **not** guess: it does not retry
(that is how people get charged twice) and it does not mark it done (that
is how a message silently never gets sent). The decision is yours.

**Cost:** one effect, pending a human. Everything else continues.

---

## 6. A background job keeps failing

**Looks like:** Settings → Standing instructions lists it under "Gave up
on", with the last error. `GET /jobs/dead-letter` has the detail.

**Is:** the job exhausted `maxAttempts` (5 by default) with deterministic
backoff between tries.

**Do:** fix the cause, then `POST /jobs/:id/replay` — which creates a
**new** job rather than resurrecting the old one, so the failed attempt
stays in the record.

**Cost:** that occurrence did not happen. The schedule itself is
unaffected and will fire again at its next slot.

---

## 7. The laptop was closed for days

**Looks like:** on waking, one briefing arrives rather than four, and the
schedule row says "3 missed".

**Is:** catch-up policy `fire-once`, the default (decision 034).

**Do:** nothing, or change the policy per schedule in Settings:
`fire-all` (capped at 10) runs every missed slot, `skip` runs none. All
three report the misses.

**Cost:** by design, the stale occurrences do not run.

---

## 8. The context will not fit

**Looks like:** a `context.assembled` event with drops, and in the worst
case a `ContextTooSmallError` and a failed run.

**Is:** the window is too small to hold the four unevictable blocks —
kernel, constitution, identity card, hard constraints. Usually a tiny
`maxContextTokens`, occasionally a very long constitution.

**Do:** raise the budget, or shorten the constitution. The error names
both numbers.

**Cost:** the run fails cleanly rather than silently dropping the
constitution, which is the deliberate choice (decision 032): no
constitution, no model call.

---

## 9. The database is corrupt, or a backup is suspect

**Looks like:** `POST /backup/verify` returns `ok: false` with the first
bad sequence number, or the agent refuses to start.

**Is:** either real corruption (disk, partial restore) or tampering —
the hash chain cannot tell you which, only that the bytes do not follow
from each other.

**Do:** verify your most recent known-good backup (`POST /backup/verify`
reads a copy, never the live file). Importing an export into an empty
agent is the clean-room recovery path; it refuses a non-empty target and
rolls back entirely on a broken chain.

**Cost:** whatever is after the last good event. The chain tells you
precisely where that is.

---

## 10. You want out

**Looks like:** nothing wrong at all.

**Is:** `POST /export` returns the whole agent: every event with its hash
chain, the constitution, the persona, and the vault **as ciphertext**.
`POST /import` replays it into an empty agent and rebuilds every
projection.

**Do:** keep the export. It is plain JSON, and the schema is documented
by the types in `src/portability/export.ts`.

**Cost:** secrets need the passphrase at the destination. That is not a
limitation of the exporter; it is §13 holding across the boundary.

---

## 11. Cognition drifted after an upgrade

**Looks like:** the agent answers differently and nobody can say why.

**Is:** a template, policy, ranker or constitution change moved what the
model sees.

**Do:** `npm run replay -- <runId>`. It rebuilds the context that run
would assemble today and diffs it against what was recorded at the time,
block by block, and exits non-zero if anything moved. `--trace` prints
the readable trace next to it.

**Cost:** none. This is the tool that makes the refactor safe rather than
the thing that went wrong.

---

## What has no failure mode yet, and should be read as a risk

- **`GET /events` has a cursor now, and the rest of the API does not.**
  `sinceSeq` makes the log followable and cheap (3–6ms at 150k events,
  down from ~1.6s). Every other list route still answers with a slice
  and no way to say "since" — `/memory`, `/schedules`, `/jobs`. None of
  them is large enough to hurt yet, and all of them will be.
- **One worker.** The lease fencing is built for several; nothing starts
  a second. If the single worker wedges, background work stops and the
  only signal is a growing `pending` count on `GET /jobs`.
- **No alerting.** Everything above is visible on demand and nothing
  pushes. For a single-user agent on a laptop that is the right call; for
  anything unattended it is not.
- **`revise` is reported, never executed.** When a constitution article
  asks for a revision remedy the system records that it would have
  revised and does not. Shipping a silent self-editor is a bigger risk
  than the gap (M9 progress note).
- **The summarizer is crude.** Compaction keeps the shape of a long
  session but will lose nuance. `history.expand` recovers the original
  turns from the log when it matters.
- **A capability nobody can reach.** The one with a track record: by the
  end of M9 the agent served fifty routes and the only UI in the product
  called thirty-six. The missing fourteen were correct, tested, and from
  the user's seat indistinguishable from never built — the vault among
  them, which is the reason every install sat at L2 with no way to
  supply a model key. It is now a test rather than a hope: the wiring
  audit runs in both directions and an exemption has to be argued for in
  writing (decision 039). The same failure one layer in — a module built
  and never constructed by the composition root — is covered by the
  layer-by-layer half of the same test.
