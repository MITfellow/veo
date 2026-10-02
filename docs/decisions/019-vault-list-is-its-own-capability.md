# 019 — Listing secret names is a separate capability from reading them

**Status:** accepted · **Milestone:** M3

## The question

The built-in that lets the agent see which secrets exist needs a capability.
`vault:read` already existed. Reuse it, or add `vault:list`?

## The decision

Added `vault:list`, strictly weaker than `vault:read`, and placed above it in
the SYSTEM / USER / DERIVED ceilings.

## Why

Knowing that a secret called `github-token` exists is categorically different
from knowing its value. The first lets the agent say "I have a GitHub token,
shall I use it?" — which is the behaviour we want, because the alternative is
an agent that either guesses or asks about credentials it does not have. The
second is the thing the entire vault exists to prevent.

Folding the two together would mean that any tool needing to *check whether* a
credential is configured must be granted the ability to *read every secret in
the vault*. That is a capability system that produces the wrong answer in the
common case, which is how capability systems become decorative: once the
grants are obviously too broad, people stop reading them.

## The structural half

The capability split is the policy. The guarantee is structural: `vault.list`'s
output schema is

```ts
z.object({ secrets: z.array(z.object({ name, version, createdAt, lastUsedAt })) })
```

There is no field a secret value could occupy. Output validation runs on every
call, so a future edit that tried to include one would fail at the boundary
rather than leak. Policy says who may call it; the schema says what it is able
to say. Both, because either alone eventually fails.
