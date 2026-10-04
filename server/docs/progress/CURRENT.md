# Current state

**Milestone:** M0 — Substrate · **COMPLETE**
**Last verified:** `npm run check` green — 84 tests, 6.5s (budget 60s),
`tsc --noEmit` clean, `eslint . --max-warnings 0` clean.

## Done in this milestone

Ports and fakes · monotonic ULID · injected clock · strict config · SQLite +
WAL + four migrations · bitemporal `facts` · event log with per-type schemas,
redaction-before-hash, hash chain and upcasters · six projections · logical
snapshot digest · CLI (`doctor`, `status`, `verify-chain`, `rebuild`).

**The §58 M0 gate is met by execution, not assertion:** 10k events → drop every
projection → rebuild → byte-identical. Also verified live on disk: 4,000 events
chain-verified, a tampered row caught at the exact seq with exit 1, and a
`SIGKILL` mid-write losing nothing.

## In flight — the next thing to do

Nothing is half-built. **Start M1 — Security**, and start with the test list in
a new `docs/progress/M1.md` before any implementation.

M1's first decision, which blocks its first line of code: **Argon2id.** Node's
`webcrypto` does not provide it (only PBKDF2 and HKDF). Appendix E.9 says
`scrypt` is explicitly *not* acceptable as a substitute, and that a dependency
is permitted if `webcrypto` cannot do it — preferring pure-WASM over native.
So M1 opens by writing `docs/decisions/005-argon2id.md`, then the keyring.

## Blocked / unsure

- **§49 / M7 cannot be executed as literally written.** Three of the eleven
  Veo files it says to *create* already exist and are wired to the pre-existing
  `agent/` platform, and `vite.config.ts` already proxies to `127.0.0.1:7777`
  rather than `8787`. Recorded in decision 001. **Not blocking: M0–M6 touch
  zero files outside `server/`.** It needs an owner decision before M7 starts.
- Node is v20.20.2, not 22 (decision 002). Nothing the platform uses needs 22.

## Do not forget

- `agent/` is a *different*, pre-existing platform in this repo and it **has a
  model provider**. It is not a reference for `server/` and its tests do not
  count toward any gate here (decision 001).
- The `examples/` directory does not exist yet and must not be created until
  M2 needs it (§61). `npm run lint` globs `.` so it will be picked up
  automatically.
- M1 must add `vault.*` payload schemas to `events/registry.ts` — the types are
  already in the closed union and `append()` will refuse them until then. That
  refusal is by design (decision 003); do not "fix" it by loosening `append`.
