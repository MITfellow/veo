# 017 — SSE event ids are event-log sequence numbers

**Status:** accepted · **Milestone:** M2

## Context

§29 requires `Last-Event-ID` resume: *"a sleeping laptop must never lose
output."* The usual implementation is a per-connection ring buffer of recent
frames, which has to be sized, which loses data when it wraps, and which
evaporates when the process restarts — exactly when resume matters most.

## Decision

The SSE `id` **is** the event's `seq` from the event log. Resume is
`SELECT ... WHERE run_id = ? AND seq > ?`.

## Consequences

- Resume and live streaming share one code path (`replayRun`), so a reconnect
  cannot drift from a live stream.
- Resume survives a server restart, because the log does.
- Nothing to size, nothing to evict, no memory growth per connection.
- Works for a run that finished months ago: reconnecting to it replays the
  whole thing. That falls out for free and is genuinely useful for a trace
  viewer.
- This only works because `seq` is dense and assigned inside the append
  transaction (M0). A gappy or post-hoc sequence would break the contract
  silently, so anything that changes `seq` allocation must revisit this.
