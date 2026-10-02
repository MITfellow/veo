/**
 * `observe()` — the write path (§22.5), end to end.
 *
 *   extract → gate → resolve entities → reconcile → emit
 *
 * Runs **after** the run completes, from the queue, never on the user's
 * critical path. §22.5 puts it plainly and it is a product requirement, not
 * an optimisation: "latency is a personality trait". An agent that pauses to
 * think about what it learned is an agent that feels slow for a reason the
 * user cannot see.
 *
 * Reconciliation is where the care goes. Four cases, and only one of them is
 * an update:
 *
 *   same value      → one more observation, confidence up, bounded
 *   new value       → supersede; both versions kept, valid time closed
 *   conflict        → disputed, and a probe queued **once**
 *   nothing like it → a new belief
 */
import type { EventLog } from '../../substrate/events/log.js';
import type { SourceRef, TrustLevel } from '../../substrate/events/types.js';
import type { Clock, Embedder, Logger } from '../../substrate/ports.js';
import { canonicalJson } from '../../substrate/hash.js';
import { gate, subjectHint } from './gate.js';
import { factLine, MemoryStore } from './store.js';
import { extractRules, type Extractor } from './extract.js';
import { resolveEntity, type EntityResolver } from './entities.js';
import type { Candidate, Fact } from './types.js';

export interface ObserveInput {
  principal: string;
  sessionId: string | null;
  runId: string | null;
  episodeId: string;
  /** What the user said, verbatim. */
  text: string;
  /** The event the text came from — the source span points into it. */
  eventId: string;
  /** Trust of that content. FOREIGN never becomes an active belief. */
  trust: TrustLevel;
}

export interface ObserveResult {
  written: string[];
  confirmed: string[];
  superseded: string[];
  disputed: string[];
  quarantined: string[];
  rejected: Array<{ reason: string; predicate: string }>;
  rulesLearned: string[];
}

export interface WriterDeps {
  store: MemoryStore;
  events: EventLog;
  clock: Clock;
  extractor: Extractor;
  entities: EntityResolver;
  embedder?: Embedder;
  logger?: Logger;
}

export class MemoryWriter {
  constructor(private readonly deps: WriterDeps) {}

  async observe(input: ObserveInput): Promise<ObserveResult> {
    const result: ObserveResult = {
      written: [],
      confirmed: [],
      superseded: [],
      disputed: [],
      quarantined: [],
      rejected: [],
      rulesLearned: [],
    };

    const candidates = await this.deps.extractor.extract({
      text: input.text,
      eventId: input.eventId,
    });

    this.deps.events.append({
      type: 'memory.observed',
      principal: input.principal,
      trust: input.trust,
      sessionId: input.sessionId,
      runId: input.runId,
      payload: { candidates: candidates.length, episodeId: input.episodeId },
    });

    // Rules first, and *before* the no-candidates early return.
    //
    // "Please keep it short" contains no fact about the user at all, so an
    // utterance-has-no-facts shortcut silently throws away the clearest
    // preferences people ever state. Procedural memory and semantic memory
    // are fed by the same turn but they are not the same pipeline.
    for (const rule of extractRules(input.text, input.eventId)) {
      if (input.trust === 'FOREIGN') break; // a web page does not get to set house rules
      const saved = this.deps.store.upsertRule({
        principal: input.principal,
        trigger: rule.trigger,
        instruction: rule.instruction,
        scope: 'global',
        sources: rule.sources,
        basis: 'asserted_by_user',
        confidence: rule.confidence,
        applied: 0,
        overridden: 0,
        lastApplied: null,
        lastOverridden: null,
        status: 'active',
        trust: input.trust,
      });
      result.rulesLearned.push(saved.id);
    }

    if (candidates.length === 0) return result;

    const decision = gate({ candidates, trust: input.trust, utterance: input.text });

    // Refusals are recorded. A gate that says no invisibly cannot be audited
    // for over-rejection, and "why don't you know that?" has no answer
    // (decision 027).
    for (const { candidate, reason, detail } of decision.rejected) {
      this.deps.events.append({
        type: 'memory.rejected',
        principal: input.principal,
        trust: input.trust,
        sessionId: input.sessionId,
        runId: input.runId,
        payload: {
          reason: `${reason}: ${detail}`,
          predicate: candidate.predicate,
          subjectHint: subjectHint(candidate),
          episodeId: input.episodeId,
        },
      });
      result.rejected.push({ reason, predicate: candidate.predicate });
    }

    for (const candidate of decision.quarantined) {
      const factId = this.writeCandidate(candidate, input, 'quarantined');
      result.quarantined.push(factId);
    }

    for (const candidate of decision.accepted) {
      const resolved = resolveEntity(this.deps.entities, candidate, input.principal);
      const existing = this.deps.store
        .bySubject(resolved.subject.id)
        .filter((fact) => fact.predicate === resolved.predicate);

      if (existing.length === 0) {
        result.written.push(this.writeCandidate(resolved, input, 'active'));
        continue;
      }

      const same = existing.find((fact) => sameValue(fact.object, resolved.object));
      if (same !== undefined) {
        this.deps.store.confirm(same.id, input.principal, input.trust);
        result.confirmed.push(same.id);
        continue;
      }

      const incumbent = existing[0];
      if (incumbent === undefined) continue;
      if (contested(incumbent, resolved)) {
        // Equal support on both sides. Not a change — a disagreement, and
        // guessing which side is right is how an agent becomes confidently
        // wrong. Mark it and ask later, once (§24's probe queue).
        if (incumbent.status !== 'disputed') {
          this.deps.store.dispute(
            incumbent.id,
            String(resolved.object),
            'a later statement conflicts with this one',
            input.principal,
            input.trust,
          );
          result.disputed.push(incumbent.id);
        }
        continue;
      }

      const newId = this.deps.store.supersede({
        oldFactId: incumbent.id,
        principal: input.principal,
        trust: input.trust,
        validTo: this.deps.clock.now(),
        next: {
          subject: resolved.subject,
          predicate: resolved.predicate,
          object: resolved.object,
          basis: resolved.basis,
          confidence: resolved.confidence,
          sources: resolved.sources as SourceRef[],
          trust: input.trust,
          stability: resolved.stability,
          sensitivity: resolved.sensitivity,
          sessionId: input.sessionId,
          runId: input.runId,
        },
      });
      result.superseded.push(incumbent.id);
      result.written.push(newId);
    }

    await this.embed([...result.written, ...result.quarantined]);
    return result;
  }

  private writeCandidate(
    candidate: Candidate,
    input: ObserveInput,
    status: Fact['status'],
  ): string {
    return this.deps.store.write({
      principal: input.principal,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      basis: candidate.basis,
      confidence: candidate.confidence,
      sources: candidate.sources as SourceRef[],
      trust: input.trust,
      stability: candidate.stability,
      sensitivity: candidate.sensitivity,
      status,
      sessionId: input.sessionId,
      runId: input.runId,
    });
  }

  /**
   * Backfill embeddings for facts that have none.
   *
   * Facts can arrive without a vector in two ordinary ways: the embedder
   * was down when they were written, or they were written before an
   * embedder was configured at all. Without a backfill those facts are
   * permanently invisible to semantic recall — a silent, growing blind spot
   * rather than a visible failure. Idempotent, and bounded per call.
   */
  async embedAll(limit = 200): Promise<number> {
    const pending = this.deps.store.factsWithoutEmbeddings(limit);
    await this.embed(pending.map((fact) => fact.id));
    return pending.length;
  }

  /** Embeddings are an index, not a belief: failure degrades recall to
   *  lexical-only rather than losing the fact. */
  private async embed(factIds: readonly string[]): Promise<void> {
    const embedder = this.deps.embedder;
    if (embedder === undefined || factIds.length === 0) return;
    const facts = factIds
      .map((id) => this.deps.store.get(id))
      .filter((fact): fact is Fact => fact !== undefined);
    if (facts.length === 0) return;
    try {
      const vectors = await embedder.embed(facts.map(factLine));
      facts.forEach((fact, index) => {
        const vector = vectors[index];
        if (vector !== undefined) this.deps.store.putEmbedding(fact.id, embedder.id, vector);
      });
    } catch (error) {
      this.deps.logger?.warn('embedding failed; recall falls back to lexical', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/* ──────────────────────────────── helpers ─────────────────────────────────── */

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * A conflict rather than a change.
 *
 * Two signals, both required: the incumbent is at least as well supported as
 * the newcomer, and the fact is the kind that does not usually change
 * (`stable`). "I moved to Berlin" after "I live in Lisbon" is a change;
 * "I'm allergic to peanuts" after "I'm not allergic to anything" is a
 * disagreement, and the agent should say so rather than quietly pick the
 * newer one.
 */
function contested(incumbent: Fact, candidate: Candidate): boolean {
  if (incumbent.stability !== 'stable') return false;
  if (incumbent.basis === 'asserted_by_user' && candidate.basis !== 'asserted_by_user') return true;
  return incumbent.confidence >= candidate.confidence && incumbent.observationCount > 1;
}
