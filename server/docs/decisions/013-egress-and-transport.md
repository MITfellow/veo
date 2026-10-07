# 013 — The platform may reach the network, behind a guard

**Status:** accepted · **Phase:** personal-intelligence Phase 8 prerequisite
**Amends:** decision 001 and §2 of the governing spec · **Relates to:** 007, 009, 012

## What changed and who changed it

The governing spec said this build makes no network call. The user, asked
directly, chose **real connectors** — and a connector that cannot make a
request is a drawing of a connector.

So the no-network rule is **narrowed, not deleted**:

> **No inference call, ever.** No model provider, no API key for a model, no
> token sent to anything that generates text. That half of §2 is untouched
> and the user re-confirmed it in the same breath: *keep model-free.*
>
> **Data egress is permitted, behind `security/egress.ts`.** Reading a
> user's own calendar is not inference; it is the world the intelligence is
> supposed to understand.

The distinction is the one the whole product rests on. A model attached by
config is a different system; a connector reading the user's own data is
this system doing its job.

## The shape

```
caller → Egress (policy: allow-list, budgets, redirect revalidation)
       → Net port
       → RealNet (one socket, pinned DNS)  |  NoNet (honest refusal)
```

`RealNet` is the only place in the platform that opens a socket, and
`NoNet` remains the default so a build that was never configured for the
network says so rather than failing obscurely.

## Why `node:http` and not global `fetch`

Not preference. The address checks are worthless without **DNS pinning**,
and global `fetch` offers no hook into name resolution. A validator that
resolves a hostname, approves the address, then hands the *hostname* to the
socket has checked nothing: DNS rebinding answers the validator with a
public address and the socket with `127.0.0.1`. A custom `lookup` makes
resolution happen exactly once.

This also keeps the two-runtime-dependency rule intact: no HTTP client was
added.

## The rules, each with the attack it stops

| Rule | Attack |
|---|---|
| Per-call origin allow-list | A URL arriving inside FOREIGN content is not an instruction to visit it |
| Private/loopback/link-local/CGNAT refused | Reaching inside the trust boundary instead of out |
| `169.254.169.254` refused **even when allow-listed** | Cloud credential theft; a config file is how that rule otherwise gets turned off |
| Redirects re-validated at **every** hop | A 302 to the metadata endpoint — the oldest SSRF there is |
| DNS resolved once, connect to that address | Rebinding TOCTOU |
| Literal addresses checked before dialling | **Found by a test**: a literal IP never reaches `lookup`, so the pinning was bypassable by not using a hostname |
| Credentials in a URL refused | Token leakage through logs and Referer |
| Cleartext http refused for FOREIGN callers | An on-path attacker can rewrite every check below it |
| Per-scope byte and request budgets | A large outbound payload from a FOREIGN-influenced step is the signature of exfiltration |
| Origin logged, never path or query | A path and query string are where private data sits (§21) |

`egress.attempted` and `egress.blocked` were reserved in the M0 event union
precisely so that the first network call this platform ever made could not
be an unlogged one. They now have payload schemas.

## The address table lives in `substrate/`, not `security/`

Both the policy layer (refusing a URL before a request is built) and the
transport (refusing an address after resolution) need the same answer. Two
copies of a security table is one copy that will be updated. The layer rule
permits it: `security/` may import `substrate/`, not the reverse.

## What this does not yet do

- **No OAuth.** Token acquisition, refresh and storage in the vault is the
  next piece, and it is where the user's client credentials become necessary.
- **No connector is wired to it.** `http.fetch` still reports `no_transport`
  until a composition root is given a `RealNet`. Turning it on is one
  argument, deliberately, so that a build has to *choose* to reach outward.
- **No certificate pinning** beyond Node's default trust store.
- **No proxy support**, which some corporate networks will require.

## Open and honestly unmeasured

`maxBytes: 2_000_000`, `maxRequests: 20`, `maxRedirects: 3`, `timeoutMs:
20_000`. Guesses. The redirect limit is the one most likely to be wrong in
practice — three is generous for an API and thin for a login flow, and a
login flow is exactly what the first OAuth connector will be.
