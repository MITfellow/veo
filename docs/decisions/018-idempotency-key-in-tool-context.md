# 018 — The idempotency key belongs in `ToolContext`

**Status:** accepted · **Milestone:** M3 · **Deviates from the spec:** yes, additively

## The problem

§16 lists the fields of `ToolContext`. The idempotency key is not among them.

§18 then says that after a crash between `effect.intended` and
`effect.committed`, the *preferred* way to resolve the unknown is to ask the
remote whether an effect with that key already happened.

Those two statements cannot both hold. A tool can only ask the remote about a
key the remote knows, and the remote only knows it if the tool sent it on the
original request. A tool that was never told its key cannot have sent it, so
the preferred reconciliation path is unimplementable as specified, and every
crash degrades to "ask the person" — the expensive fallback, forever.

## The decision

Add one field:

```ts
idempotencyKey: string | null;
```

`null` when the call has no external effect (`effect !== 'external'`), because
there is no key to give and a fake one would be a lie the tool might act on.

The tool passes it to the remote in whatever form that remote expects — an
`Idempotency-Key` header, a client-side transaction id, a dedupe token. That
is the tool's business; the runtime's business is making sure it *can*.

## Why not the alternatives

**Pass it as an argument to `execute`.** Changes the signature of every tool to
serve a minority of them, and `ToolContext` already exists precisely to carry
"things the runtime knows that the tool may need".

**Let the tool compute it.** Then two components derive the same identity
independently and will eventually disagree. The key must be computed once, by
the outbox, from `(tool, version, canonicalInput, stepId)`, and handed down.

**Leave it out and always ask the person.** Correct but corrosive. A runtime
meant to last ten years will crash mid-effect many times; if each one costs a
human interruption that could have been a single API query, the person learns
to dismiss the prompts without reading them, and then the one that mattered
gets dismissed too.

## Consequence

`ToolContext` is now a 12-field object and the sandbox test asserts those keys
verbatim, so the next addition is a deliberate act rather than a drift.

The spec is wrong here, narrowly: its §16 field list is incomplete relative to
its own §18. Recorded here rather than silently patched (§36).
