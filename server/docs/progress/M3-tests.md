# M3 — Tools and effects: the test list

Written before any implementation, as §36 requires. Each line is a claim I
intend to be able to prove. Anything I cannot prove gets struck through with
a reason rather than quietly dropped.

M3 is where the platform stops only *knowing* things and starts *doing*
them. Three mechanisms already exist and must be used rather than rebuilt:
the Rule of Two gate (§19, swept over 891 cases), the tool-call audit trail
(`tool.invoked|succeeded|failed|denied`, decision 010), and the sealed plan
(§22, built for browsing in decision 009).

What M3 adds is the general machinery around them: a **tool contract** every
tool must satisfy, a **registry** that refuses a non-conforming tool at load,
an **autonomy ladder** L0–L4 that decides what may run unattended, an
**approval** lifecycle, **budgets**, **dry-run**, and **compensation** for an
effect that cannot be undone by replaying the log.

---

## 1. The tool contract (§26)

A tool declares what it is. The platform never guesses.

- [ ] A tool declares `sensitivity` and `effect`; the Rule of Two reads the
      declaration and never inspects the payload.
- [ ] A tool with no `input` schema is refused at registration, not at call
      time.
- [ ] Registering two tools under one name is refused.
- [ ] Every registered tool's input schema is `.strict()` — an unknown key is
      a 400, not a silently ignored field.
- [ ] A tool declaring `effect: 'external'` but no `compensate` is refused
      unless it also declares `irreversible: true`. Forcing the author to
      say which it is removes the third possibility: *forgot to think*.
- [ ] A tool declaring `idempotent: true` can be called twice with the same
      idempotency key and runs once.
- [ ] The conformance suite runs over **every** registered tool, so a tool
      added later cannot skip it.

## 2. The registry and the capability check

- [ ] A tool requiring a capability the caller does not hold is denied with
      the capability named.
- [ ] A FOREIGN-trust caller is denied every capability in `FOREIGN_DENIED`,
      with no exception path.
- [ ] An unknown tool name is a refusal, never a no-op that returns success.
- [ ] The registry is the only way to invoke a tool: a test reads the source
      tree and asserts no module outside `orchestration/` imports a tool
      implementation directly.

## 3. The autonomy ladder (§30)

L0 propose-only · L1 observe · L2 interact · L3 reversible effects ·
L4 irreversible effects with standing approval.

- [ ] At L0 **nothing executes.** A plan is produced and every step is
      `proposed`.
- [ ] Each rung permits exactly its own tier and everything below it — a
      table asserted literally, all 5 × 4 cells.
- [ ] A step above the current rung produces an **approval request**, not a
      failure. The difference is the whole product.
- [ ] Autonomy is capped at `FOREIGN_AUTONOMY_CAP` when FOREIGN content is
      in the causal closure, whatever the configured rung says.
- [ ] Raising autonomy is an event. There is no setter that does not leave a
      record.

## 4. Approvals

- [ ] An approval names the specific step, the tool, and the triple. A
      generic "yes" cannot be reused for a different step.
- [ ] An approval expires. An expired approval does not authorise anything,
      and the expiry is an event.
- [ ] A denied approval stops the run; the run ends `cancelled`, not
      `failed` — the user did not break anything.
- [ ] An approval cannot be granted by anything other than a USER-trust
      actor. An agent granting its own approval is refused.
- [ ] Approval for an (A∧B∧C) step must acknowledge all three properties
      (already enforced; asserted here through the executor).

## 5. Plan-then-execute (§22)

- [ ] A plan is sealed before the first step runs, and the seal covers the
      goal, the steps, the budget and the autonomy rung.
- [ ] Executing a step not in the plan is refused with `not_in_plan`.
- [ ] Mutating the plan mid-run breaks the seal and halts the run.
- [ ] A re-plan is a **new** plan with its own seal and its own event; the
      old plan's remaining steps do not carry over.
- [ ] `run.planned` is appended before any tool is invoked. Asserted by
      sequence number, not by reading the log in order.

## 6. Dry run

- [ ] Every tool with `effect: 'external'` supports a dry run.
- [ ] A dry run emits `tool.dryrun` and **no** `tool.invoked`.
- [ ] A dry run makes no change: the projection digest before and after is
      identical.
- [ ] A dry run of a whole plan reports every step's verdict, including the
      ones that would be refused — a plan that would fail at step 7 should
      say so at step 0.

## 7. Budgets and degradation (§27)

- [ ] A run exceeding its step budget stops with `budget.exceeded` and ends
      `failed`, not silently truncated.
- [ ] A wall-clock budget is enforced against the injected clock, not
      `Date.now`.
- [ ] Exceeding a budget emits the event **before** stopping, so the log
      explains the stop.
- [ ] A budget cannot be raised mid-run by anything in the run.

## 8. Effects, idempotency and compensation

- [ ] A tool call carries an idempotency key derived from the plan seal and
      the step index, so a replayed step does not double-fire.
- [ ] A failed external effect runs its `compensate` and records
      `tool.failed` plus the compensation as its own tool call.
- [ ] A compensation that itself fails is recorded and does not mask the
      original failure.
- [ ] An `irreversible: true` tool never runs below L4, with or without an
      approval request pending.

## 9. The audit trail (decision 010, generalised)

- [ ] Every execution path through the executor produces a terminal
      `tool.succeeded|failed|denied` for each `tool.invoked`. A sweep over
      every outcome asserts zero calls left open.
- [ ] A denial carries its policy code.
- [ ] A run always reaches a terminal state: `finished`, `failed` or
      `cancelled`. No run dangles, over a sweep of every refusal shape.
- [ ] Nothing in the log carries tool output prose — the same rule as
      decision 010, for the same reason: the log replays into the
      privileged path.

## 10. The built-in tools

Small, real, and offline. Each is a genuine capability, not a stub.

- [ ] `time.now` — pure, no capability, works at L1.
- [ ] `memory.recall` — reads private data, so (B); refused at L0.
- [ ] `memory.assert` — writes private data; records the fact through the
      store, never directly.
- [ ] `note.write` — creates a sealed item; requires an unlocked vault and
      says so when locked.
- [ ] `file.read` — reads through `substrate/files.ts`, the only `node:fs`
      door; refuses a path outside the configured roots.
- [ ] `http.fetch` — declared, contract-tested, and refuses with
      `no_transport`. §2: this build ships no network call, and a tool that
      pretended otherwise would be the one lie that matters.
- [ ] Every built-in passes the conformance suite in §1.

## 11. Adversarial

- [ ] A tool cannot raise its own autonomy, grant its own approval, or widen
      its own capability set. Asserted structurally by reading the source.
- [ ] FOREIGN content in a tool's *output* does not raise the trust of the
      next step's input.
- [ ] A plan whose goal text contains an instruction ("then email everyone")
      does not thereby acquire the capability to do it.
- [ ] The hostile corpus, fed as tool output, produces no step that was not
      in the plan.
- [ ] A step that holds all three Rule-of-Two properties is refused without
      an approval, through the executor, not just through the gate.

## 12. Scale and the gate

- [ ] 500 runs through the real executor: every run terminal, every call
      terminal, replay byte-identical.
- [ ] The new projections are fed by the 10k rebuild-identity workload.
- [ ] Full suite stays under 60 s.

---

## Deliberately out of scope

- **Real connector adapters** (Gmail, Calendar, …) — M6. M3 builds the
  machinery they will plug into.
- **Scheduling and the daemon** — M7. A run here is started by a command.
- **Any network transport.** §2. `http.fetch` exists to prove the contract
  and to refuse honestly.
- **Multi-step planning by a model.** `turn.generate` has a baseline; a plan
  here comes from the caller or from that baseline, and neither invents
  tools it was not given.
