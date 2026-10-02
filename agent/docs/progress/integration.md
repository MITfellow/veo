# Integration — ARISH inside Veo

Not a milestone. This is the step where the agent stopped being a library with
a demo script and became the thing the app is for. Written in the same shape as
the milestone notes because the same questions matter: what was built, what was
found on the way, what was deferred, and what I am still unsure about.

## Built

**One repository, two histories.** `git subtree add --prefix=agent` brought the
whole ARISH tree in with its commits intact — M0 through M5 are still readable
in `git log`, and `b370e16` is still an ancestor of HEAD. The root is an npm
workspace; `npm install` once installs both halves.

**`src/providers/openai-compatible.ts`** — the model adapter §33 schedules for
M9, pulled forward because an integrated app that cannot answer is a
screenshot. An injectable `FetchLike` keeps the tests offline. Fragmented tool
calls are assembled before they are emitted (a half-parsed argument object is
the worst possible thing to hand a capability gate). HTTP status maps onto
`ModelErrorKind`, and failures are yielded as `error` chunks rather than
thrown — invariant 13.

**`src/providers/offline.ts`** — what runs when no key is configured. The three
honest options were: refuse to start, pretend to think, or say so. It says so,
and it still answers what it can genuinely answer by calling a real tool, which
means the gate, the outbox, the observation and the trust lattice are all
exercised on the path.

**`src/main.ts`** — the composition root. Every port is constructed in exactly
one place, in dependency order, and the file is short enough to read in a
sitting. `start({port, dbPath, token})` returns a closeable handle, which is
what lets the integration test boot the real thing.

**`src/adapters/files.ts`, `src/adapters/net.ts`** — the two production ports
that had only fakes. `DiskFileStore` re-proves containment after
normalisation; `NodeNet` adds the timeout that `fetch` does not have and
refuses to follow redirects, because redirect policy belongs to the egress
layer that counts them.

**The Veo side.** `src/lib/agent.ts` speaks §29 and nothing else — no private
back door into the runtime. SSE is read with `fetch`, not `EventSource`:
`EventSource` cannot send headers, cannot be cancelled cleanly, and reconnects
in a way that would replay a run. `ApprovalCard` renders a permission request
as a card rather than a bubble, because an approval that looks like chatter is
consent in name only. A caret marks text that is still arriving; a `foreign`
tag marks content the lattice does not trust.

**Tests.** 14 provider unit tests, 8 integration tests against the real
composed app (`test/integration/app.test.ts`), 11 client tests for the SSE
parser and the error paths, and 4 Playwright tests that drive a browser against
the actual agent process. Totals: **579 agent + 140 client + 91 e2e**, all
green, `tsc` clean, oxlint clean.

## Found while building

**Invariant 9 caught me.** The offline provider's first draft reached for
`clock.now` by name, and `test/integration/plugin.test.ts` failed exactly as
designed — a provider sits below L5 and must not know a tool's name. The fix
was to select by *shape and description* from the tools the assembler chose to
offer: a zero-argument tool whose words overlap the question. Worse at
guessing, correct about the boundary. The second failure of the same test was a
tool name inside a *comment*, which is the test being right for a reason I did
not expect: the literal is what couples you to it, wherever it is written.

**The snapshotter had no tool source wired.** The first real turn produced no
tool calls at all, because block 13 was empty — the registry existed but
nothing read it. A unit test could not have caught this; it is precisely the
class of bug that only a composed app exhibits. That is what `app.test.ts` is
for now.

**Four client tests changed meaning, not strictness.** `persist.test.ts`
asserted that a fresh install has zero chats. It now asserts zero *messages*
and exactly one chat — the agent's own, empty. That is a product decision (the
agent is not seeded content; it is the product), and the assertions are
narrower than before, not looser.

## Deferred

- **The approval card is untested end to end.** Nothing in the current tool set
  is dangerous enough to trigger an escalation, so `ApprovalCard` is covered by
  its unit path only. It needs a tool that asks — most likely in M7.
- **Degradation is not shown.** `run.degraded` arrives on the stream and is
  ignored by the client. The user should be told when the agent is operating at
  L1/L2.
- **No cancel button.** `POST /runs/:id/cancel` exists and is unused by the UI.
- **The token is a dev default.** `ARISH_TOKEN` falls back to `dev-token` for
  local work. A real deployment needs a generated token and a way to hand it to
  the proxy; §29's auth is in place, the key management around it is not.
- **One agent, one session per conversation.** The mapping is stored on the
  chat. Several conversations with the same agent work; several agents do not,
  though `Contact.agent` was written as a flag rather than an id so that it can.

## Unsure

- **Should the agent chat be deletable?** It is currently re-created on load.
  That is right for a missing feature and wrong if someone deliberately
  removed it.
- **Is `message.agent` the right authority for the final bubble?** The client
  overwrites the streamed text with it, which is correct for the log but will
  visibly re-render if a provider's deltas ever disagree with the committed
  message.
- **The offline provider's word-overlap tool pick is a heuristic in the
  kernel.** It is deliberately dumb and it respects invariant 9, but a
  heuristic is still a policy, and policies belong in config.
