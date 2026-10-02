# M3 — Tools & effects · design note and test list

**Spec:** §16 tool contract · §17 structured results · §18 outbox · §14 egress ·
§20 built-ins · §26 loop detection.
**Done when:** *killing the process mid-external-effect and restarting produces
**exactly one** effect, provably.*

Written before the code, per §36.

---

## 1. The one thing this milestone is really about

Everything else here is plumbing around a single hard problem: **a side effect
that has left the building cannot be undone, and the process can die between
"I decided to send it" and "I know it was sent."**

There are exactly three states after a crash:

| The log says | What actually happened | What we may do |
|---|---|---|
| nothing | nothing | run it |
| `intended`, no `committed` | **unknown** — sent, or not | **query, or ask. never guess.** |
| `intended` + `committed` | it happened | return the recorded result |

Row two is the whole milestone. §18's answer, which this implements:

1. **Intend** — append `effect.intended` with
   `idempotencyKey = hash(tool, version, canonicalInput, stepId)` **in the same
   transaction as the step**. Commit.
2. **Commit** — perform the effect, then append `effect.committed`.
3. **Reconcile on restart** — for every `intended` without `committed`: query
   the remote by idempotency key if the tool supports it; otherwise mark the
   run `needs-attention` and **ask the person**.

**Never blindly retry a non-idempotent external effect.** A duplicate payment
is worse than a late one, and a system that silently retries is one a person
cannot trust with anything that matters.

`canonicalJson` has been in place since M0 precisely for the key.

---

## 2. The tool contract (§16) — freeze it now

`src/capability/tool.ts` defines `Tool<I, O>` exactly as §16 specifies. Two
parts of it are easy to under-build and both are load-bearing:

- **`renderForModel(result, budget)` — truncation is the TOOL's job.** The
  tool knows which 2KB of a 40MB log matter; the runner does not. A generic
  truncator would cut the useful part and keep the header.
- **`ToolContext` is everything the tool gets, and nothing is ambient.** No
  `process.env`, no global `fetch`, no raw DB handle. The context carries
  `signal`, `principal`, `runId`, `stepId`, `effectiveTrust`, a **scoped**
  `FileStore`, a **scoped** `Net`, resolved secrets, `emit()`, logger. If a
  tool can reach something not in that object, the sandbox is decorative.

`dryRun` is **required** when `risk: 'dangerous'`, and `compensate` is required
when `effect: 'external' && !idempotent`. These are enforced at registration
time, not documented — a dangerous tool with no preview must fail to register
rather than fail at 2am.

### Results are structured (§17)

`ToolResult<O>` is a discriminated union; a failure is a value, not a throw
(invariant 13). Results carry **their own trust level**, which feeds the
lattice: an HTTP tool returns FOREIGN no matter how the step was running, and
that is what makes "a web page cannot spend your money" hold through a tool
boundary as well as a model boundary.

Large outputs go to the **artifact store**; the model gets a reference plus a
short summary. §17 is right that this is the decision that keeps the context
survivable later.

---

## 3. The invoke pipeline (`src/capability/invoke.ts`)

```
tool.requested
  → resolve tool (unknown ⇒ observation, not a crash)
  → validate input against the tool's schema        (zod, §6)
  → effective trust = min over causal closure       (M1)
  → capability + minTrust gate                      → policy.denied as an observation
  → dangerous? ⇒ approval                           (M4; M3 refuses and says so)
  → resolve secretsRequired via useSecret           (M1, scoped, zeroized)
  → external? ⇒ outbox.intend                       (§18)
  → execute with timeout + AbortSignal
  → validate OUTPUT against the tool's schema
  → artifacts stored, large values replaced by refs
  → external? ⇒ outbox.commit
  → tool.succeeded | tool.failed | tool.timedout
  → renderForModel ⇒ an observation the model reads next step
```

**Every failure mode produces an observation, never an exception that escapes.**
A tool that does not exist, a schema that does not match, a capability that is
refused, a timeout — all of them come back as text the model can read and adapt
to. That is §19's "a denial is not a crash", and it is also the difference
between an agent that recovers and one that dies.

**The output is validated too, not just the input.** A tool whose remote
changed shape must fail loudly at its own boundary rather than feed garbage
into the model and the memory.

---

## 4. Egress (§14)

`src/capability/egress.ts` wraps the `Net` port:

- per-tool host + method allowlist; everything else blocked
- **private, link-local and cloud-metadata ranges blocked by default** —
  `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (which is
  `169.254.169.254`, the metadata endpoint), `::1`, `fc00::/7`, `fe80::/10`
- **redirects re-validated at every hop**, not just the first. A 302 to
  `http://169.254.169.254/` is the oldest SSRF in the book.
- **DNS pinning**: resolve, validate the resolved IP, then connect to *that
  IP*. Resolving twice is a TOCTOU hole (DNS rebinding) — the name that
  validated is not necessarily the address that connects.
- per-run egress **byte budget**; a large outbound payload from a
  FOREIGN-influenced step trips a hard stop and an alert event, because that
  is the signature of exfiltration.

M3 implements the policy and the checks against a fake `Net`. Real DNS
resolution is wired but untested offline (§6: the suite is offline), which the
progress note will say plainly.

---

## 5. Built-in tools (§20)

§20 lists nine and says **only these**. The ones whose dependencies exist now:

| Tool | effect | why it is here |
|---|---|---|
| `clock.now` | pure | proves the pure path and that tools cannot read the real clock |
| `notes.read` / `notes.write` | local | proves the scoped FileStore |
| `vault.list` | local | proves the secret-touching path returns **names only** |

Deferred with their milestones, not forgotten: `memory.*` (M6),
`history.expand` (M5), `clock.schedule` (M8), `ask_user` (M4 — it *suspends*,
and durable suspension is M4's deliverable).

The **external** tool used to prove the outbox lives in `test/fakes/`, not
`src/tools/`. §20 says only those nine ship as built-ins, and a fake remote is
a better test subject anyway: it can be made to crash at the exact instruction
that matters.

### The §20 contract test

> adding plugin #10 must require editing nothing outside `src/tools/` plus one
> registration line.

`test/integration/plugin-contract.test.ts` adds a tenth tool and asserts it
works end to end. If that test needs a change anywhere else, the contract
failed and gets fixed before anything else proceeds.

---

## 6. Wiring into the loop

The runner currently records `tool.requested` and stops with
`tools-unavailable`. M3 replaces that branch with: invoke each call, append the
observations, **continue the loop**. The stop reason `tools-unavailable`
becomes unreachable — which is the point of having named it.

Loop detection (already built at M2) now has something real to detect.

---

## 7. Test list (written before the code)

### `test/unit/tool-contract.test.ts`
1. a tool with `risk:'dangerous'` and no `dryRun` **fails to register**
2. a tool with `effect:'external'`, `idempotent:false`, no `compensate` fails to register
3. duplicate `name@version` fails to register
4. a tool name outside `src/tools/` is not special-cased anywhere (invariant 9)
5. `renderForModel` is called with the budget and its output is what the model sees
6. registry lookup by name and by `name@version`

### `test/unit/idempotency-key.test.ts`
7. the key is `hash(tool, version, canonicalInput, stepId)`
8. key-order differences in the input produce the **same** key
9. a different `stepId` produces a **different** key
10. a different tool version produces a different key
11. the key is stable across processes (recorded constant)

### `test/integration/invoke.test.ts`
12. happy path: validate → execute → `tool.succeeded` → observation
13. unknown tool ⇒ observation naming it, **no exception escapes**
14. input failing the schema ⇒ `tool.failed`, the model is told what was wrong
15. **output** failing the schema ⇒ `tool.failed`, nothing reaches memory
16. a tool that throws ⇒ `tool.failed`, run survives
17. a tool that exceeds `timeoutMs` ⇒ `tool.timedout`, abort signal fired
18. capability refused ⇒ `policy.denied` + an explanatory observation
19. `minTrust` not met ⇒ refused, and the explanation names the limiting event
20. a FOREIGN tool result stays FOREIGN in the log (trust does not launder)
21. secrets are resolved, used, and **absent from every event**
22. `ToolContext` exposes nothing ambient (asserted on its key set)
23. a large result goes to artifacts; the model sees a ref + summary

### `test/integration/outbox.test.ts` — **the M3 bar**
24. an external tool writes `effect.intended` **before** executing
25. intend and the step record commit in **one** transaction
26. success ⇒ `effect.committed` with the remote ref
27. **crash between intend and commit** ⇒ on restart the effect is *not* re-run blindly
28. reconcile with a queryable remote ⇒ discovers it happened ⇒ `effect.committed`, **one** effect total
29. reconcile with a queryable remote that says it did *not* happen ⇒ runs it ⇒ exactly one
30. reconcile with a **non-queryable** remote ⇒ run marked `needs-attention`, user asked, **nothing retried**
31. the same input in the same step twice ⇒ one effect (key collision is intentional)
32. the same input in a *different* step ⇒ two effects (different keys — correct)
33. a non-idempotent external tool is **never** auto-retried
34. `compensate` runs for a committed effect that is later rolled back

### `test/integration/egress.test.ts`
35. a host not on the allowlist is blocked, and the block is an event
36. a method not on the allowlist is blocked
37. a redirect to a blocked host is blocked **at the redirect**, not after
38. `169.254.169.254` is blocked even when explicitly allowlisted (it is never OK)
39. private ranges blocked by default
40. DNS rebinding: the resolved IP is what gets validated and connected to
41. per-run byte budget trips a hard stop with an alert event
42. a large outbound payload from a FOREIGN step trips the exfiltration stop

### `test/integration/tools-in-the-loop.test.ts`
43. the model calls a tool, gets an observation, and answers using it
44. two tool calls in one step both execute and both produce observations
45. a failing tool does not end the run — the model sees the error and adapts
46. `tools-unavailable` is now unreachable
47. loop detection fires on a real repeated tool call
48. a tool call under a step cap stops cleanly

### `test/integration/plugin-contract.test.ts` — **the §20 test**
49. a tenth tool is added, registered with one line, and works end to end
50. nothing outside `src/tools/` and the registration line was touched

### `test/adversarial/tool-safety.test.ts`
51. a tool that tries to read `process.env` has nothing to read in its context
52. a tool that returns a secret value in its output is caught by the firewall
53. a tool that returns 50MB does not blow the context — artifacts absorb it
54. a tool that never resolves is killed by the timeout
55. a tool that ignores its `AbortSignal` is still bounded
56. a tool result claiming `trust:'SYSTEM'` from a FOREIGN source is refused

---

## 8. Risks

- **The outbox is easy to get subtly wrong.** The failure mode is invisible
  until it is a duplicate payment. Mitigation: the crash test is a *real*
  process boundary (new everything, same database), not a mocked one.
- **Egress checks that only run in tests are theatre.** Mitigation: the
  allowlist and IP-range checks are pure functions tested directly; the DNS
  pinning path is wired and marked untested-offline in the note.
- **Scope creep from §19.** Approvals and budgets are M4. M3 refuses dangerous
  tools outright and says why. Resisting the urge to half-build approvals here
  is the point.

## 9. Budget

Suite stays <60s. Tool invocation overhead (excluding the tool) under 5ms.
