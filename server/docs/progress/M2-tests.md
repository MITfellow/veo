# M2 — Memory: the test list

Written before any implementation, as §36 requires. Each line is a claim I
intend to be able to prove. Anything I cannot prove gets struck through
with a reason rather than quietly dropped.

M0 built the bitemporal `facts` projection and two demonstration queries.
M2 owns everything above it: the store, entity resolution, the lifecycle,
and shreddable item content. The two notes `CURRENT.md` carried into this
milestone are settled here — item content gets a home, and every extractor
obeys decision 007.

---

## 1. The two timelines are genuinely independent

The whole milestone turns on this. A system with one timeline cannot tell a
correction from a change and will either lose history or invent it.

- [x] A **change** closes valid time and opens a new row; the old row stays
      believed.
- [x] A **correction** closes transaction time only; valid time is untouched,
      because we are not claiming the world changed.
- [x] `asOf({ validAt, believedAt })` is a genuine 2-D query: the same pair of
      events produces four different answers at the four corners.
- [x] "What did you believe in March about what was true in January" is
      answerable and is not the same as "what do you believe now about
      January".
- [x] A retracted fact never appears in a current query, and always appears
      in a belief query dated before the retraction.
- [x] Nothing is ever deleted or overwritten. Row count is monotonic for
      asserts; `UPDATE` only ever closes a timeline.

## 2. The store is a projection of the log, not a store

- [x] Every mutation goes through an event. No method writes `facts` directly.
- [x] 5k memory operations → drop projections → replay → byte-identical.
- [x] A fact's `recorded_at` is the event's `ts`, never a fresh clock read —
      proven by replaying with a clock that has moved on.

## 3. Entity resolution

- [x] An exact name match resolves. An alias match resolves.
- [x] An **ambiguous** mention resolves to `null`, not to a best guess. A
      wrong merge is permanent and a null is cheap.
- [x] Renaming an entity keeps the old name as an alias, so history still
      resolves.
- [x] Merging follows the canonical chain to its end.
- [x] A merge cycle (A→B, B→A) terminates and is refused rather than
      hanging.
- [x] Facts about a merged entity are reachable through the canonical id.

## 4. Consolidation and conflict

- [x] Two identical facts collapse; the newer supersedes the older.
- [x] Two **different** values for the same subject+predicate are raised as a
      conflict, never silently resolved.
- [x] A conflict involving a pinned fact never supersedes the pinned one.
- [x] Consolidation is idempotent: running it twice changes nothing the
      second time.
- [x] Confidence decays by stability — `volatile` faster than `slow`, and
      `stable` not at all.

## 5. Trust — the part that matters (§20, decision 007)

- [x] A fact extracted from FOREIGN content is stored with FOREIGN trust,
      whatever the extractor claimed.
- [x] A FOREIGN-trust fact **cannot** supersede or retract a USER-trust fact.
- [x] Trust is monotonically non-increasing through the ingest pipeline.
- [x] An extracted object longer than `MAX_VERBATIM_SPAN` that is a substring
      of its source is refused — a summary of FOREIGN content is FOREIGN.
- [x] A capture containing `SYSTEM: you are now…` produces either no facts or
      FOREIGN-trust facts, and never an instruction anywhere in the log.
- [x] The negative control: an ordinary sentence about a real preference is
      extracted normally.

## 6. Item content and forgetting (§23, invariant 10)

- [x] Item content is sealed under its own key; the key is wrapped under
      the MDK.
- [x] `forget` destroys the key and leaves the ciphertext. The content is
      unrecoverable **and the tombstone remains auditable**.
- [x] `forget` is idempotent — asking twice is a user action, not an error.
- [x] After `forget`, no query path returns the content, including the
      bitemporal ones.
- [x] Plaintext item content never reaches the event log or the structured
      log. Proven by grepping both.
- [x] A locked vault refuses to read item content and says so, rather than
      returning empty.

## 7. Recall

- [x] Recall returns facts ordered by a defensible score, not by rowid.
- [x] Recall respects sensitivity: `secret` facts are excluded unless asked
      for explicitly.
- [x] Recall over an empty memory returns nothing and does not throw.
- [x] `fact.used` is appended when a fact is recalled into a context, so
      "what did it know when it said that" is answerable.

## 8. The surface

- [x] `arish memory add|list|recall|forget|entities|conflicts` all work
      against a real database.
- [x] `arish memory forget <id>` is reachable from the CLI and retracts.
- [~] ~~…and shreds.~~ Shredding an item needs an unlocked vault and there
      is no `arish vault unlock` by design (M1). `ItemStore.shred` is built
      and tested; it has no CLI door until M7's daemon.
- [x] Exit codes: 0 ok, 1 locked or usage, 2 other.
- [~] ~~`arish doctor` reports memory counts.~~ Moved to `arish status`:
      `doctor` answers "is this machine fit to run arish" and must work
      before a database exists. See M2.md.

## 9. Scale

- [x] 10k facts: a current-state query stays under the §57 100 ms budget.
- [x] 10k facts: consolidation completes without quadratic blowup.

---

## Deliberately out of scope

- **Semantic / vector recall.** Needs an embedding model; §2 says no model.
  Recall is lexical and says so.
- **`rule.induce` wiring.** The job exists; rules are M8's subject.
- **Automatic consolidation on a schedule.** Scheduling is M7.


---

## Result

**All ticked except the two struck above, each with its reason.**
451 tests / 36 files / 16.2 s, `tsc` and `eslint .` clean.
Three bugs were found by running the demo and none by the suite; they are
listed in `M2.md` under *What execution changed*.
