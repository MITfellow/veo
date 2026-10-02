/**
 * `recall()` — the read path (§22.6).
 *
 * Hybrid scoring, because similarity alone is not enough and never has been.
 * The thing people reach for — embed the turn, take the nearest five facts —
 * fails in exactly the ways that matter for a personal agent: it cannot find
 * a name or an order number (lexical), it cannot tell a fresh fact from a
 * stale one (recency), it returns five phrasings of one belief (diversity),
 * and it systematically hides the one memory that would have stopped a
 * mistake (contradiction).
 *
 * Six components and one penalty, all logged with every recall, so that when
 * the agent says something wrong about someone there is a way to find out
 * why. §22.6 is unusually specific about this and it is right to be: an
 * unexplainable retrieval is an unfixable one.
 */
import type { Embedder } from '../../substrate/ports.js';
import { factLine, MemoryStore } from './store.js';
import {
  DEFAULT_WEIGHTS,
  HALF_LIFE_DAYS,
  type Fact,
  type RecallWeights,
  type ScoredFact,
} from './types.js';

export interface RecallInput {
  principal: string;
  /** The live turn — the retrieval query. */
  text: string;
  /** Entities active in this turn, if the caller knows them. */
  entityIds?: readonly string[];
  limit: number;
  now: number;
  /** Policy may allow `secret` facts; by default it does not. */
  allowSecret?: boolean;
  weights?: Partial<RecallWeights>;
}

export interface RecallOutput {
  items: ScoredFact[];
  candidates: number;
  weights: RecallWeights;
}

export interface ReaderDeps {
  store: MemoryStore;
  embedder?: Embedder;
}

const DAY_MS = 86_400_000;

/** How much of the result set may be near-duplicates. MMR's λ. */
export const DIVERSITY_LAMBDA = 0.72;

export class MemoryReader {
  constructor(private readonly deps: ReaderDeps) {}

  async recall(input: RecallInput): Promise<RecallOutput> {
    const weights: RecallWeights = { ...DEFAULT_WEIGHTS, ...input.weights };

    // Hard rules first, in SQL, so no weighting can reach a retired or
    // quarantined fact (§22.6). A filter inside the scorer is a filter one
    // refactor away from becoming a tie-break.
    const pool = this.deps.store.recallable(input.principal);
    const pinned = pool.filter((fact) => fact.pinned);
    const scorable = pool.filter(
      (fact) => !fact.pinned && (input.allowSecret === true || fact.sensitivity !== 'secret'),
    );

    const lexical = new Map(
      this.deps.store.searchText(input.text).map((row, index, all) => {
        // bm25 returns lower-is-better and unbounded; rank-normalise instead
        // of trying to calibrate a raw score against five other components.
        return [row.factId, 1 - index / Math.max(1, all.length)];
      }),
    );

    const semantic = await this.semanticScores(input.text, scorable);
    const queryTokens = tokens(input.text);
    const entityIds = new Set(input.entityIds ?? []);

    const scored: ScoredFact[] = scorable.map((fact) => {
      const components = {
        semantic: (semantic.get(fact.id) ?? 0) * weights.semantic,
        lexical: (lexical.get(fact.id) ?? 0) * weights.lexical,
        recency: recencyDecay(fact, input.now) * weights.recency,
        importance: importance(fact) * weights.importance,
        entity: (entityIds.has(fact.subject.id) ? 1 : 0) * weights.entity,
        contradiction: contradictionSignal(fact, queryTokens) * weights.contradiction,
        sensitivity: -sensitivityPenalty(fact) * weights.sensitivity,
      };
      const score = Object.values(components).reduce((sum, value) => sum + value, 0);
      return { fact, score, components };
    });

    scored.sort((a, b) => b.score - a.score);

    // Pinned facts are always in (§22.6), and they do not compete for the
    // ranked slots — a pin is the user saying "this matters", and making
    // them re-earn it every turn would make pinning meaningless.
    const budget = Math.max(0, input.limit - pinned.length);
    const diversified = mmr(scored, budget, DIVERSITY_LAMBDA);

    const items = [
      ...pinned.map((fact) => ({ fact, score: Number.POSITIVE_INFINITY, components: { pinned: 1 } })),
      ...diversified,
    ];

    this.deps.store.markUsed(
      items.map((item) => item.fact.id),
      input.now,
    );

    return { items, candidates: pool.length, weights };
  }

  private async semanticScores(query: string, facts: readonly Fact[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const embedder = this.deps.embedder;
    if (embedder === undefined || facts.length === 0) return out;

    const stored = this.deps.store.embeddings();
    let queryVector: Float32Array;
    try {
      const vectors = await embedder.embed([query]);
      const first = vectors[0];
      if (first === undefined) return out;
      queryVector = first;
    } catch {
      // Recall degrades to lexical. Returning nothing at all would be worse:
      // an embedder outage should cost precision, not memory.
      return out;
    }

    for (const fact of facts) {
      const vector = stored.get(fact.id);
      if (vector === undefined) continue;
      out.set(fact.id, Math.max(0, cosine(queryVector, vector)));
    }
    return out;
  }
}

/* ─────────────────────────────── components ───────────────────────────────── */

/** Exponential decay with a half-life set by `stability` (§22.6). */
export function recencyDecay(fact: Fact, now: number): number {
  const halfLife = HALF_LIFE_DAYS[fact.stability] * DAY_MS;
  const age = Math.max(0, now - fact.recordedAt);
  return Math.pow(0.5, age / halfLife);
}

/** confidence × log(observations) × pinned (§22.6). */
export function importance(fact: Fact): number {
  const observations = Math.log1p(fact.observationCount) / Math.log(10);
  return Math.min(1, fact.confidence * (0.6 + observations)) * (fact.pinned ? 1.5 : 1);
}

/**
 * The contradiction bonus — **positive, and it will look like a bug**.
 *
 * §22.6 and §3.4 both insist on it. A fact that disagrees with the direction
 * of the current turn is boosted, not filtered, because the single most
 * valuable thing a long memory can do is say "you said the opposite in
 * April". Remove this and long-term memory becomes a confirmation-bias
 * engine that agrees with whatever the user said most recently — which feels
 * pleasant and is how an agent ends up helping someone repeat a mistake.
 *
 * The signal is crude (negation and disagreement markers shared between the
 * turn and the fact, plus the store's own `disputed` flag) and that is
 * acceptable: a crude positive signal is far better than a correct negative
 * one.
 */
export function contradictionSignal(fact: Fact, queryTokens: ReadonlySet<string>): number {
  let signal = 0;
  if (fact.status === 'disputed') signal += 0.6;
  if (fact.contradictedCount > 0) signal += 0.2;

  const factTokens = tokens(factLine(fact));
  const overlap = [...queryTokens].filter((token) => factTokens.has(token)).length;
  if (overlap === 0) return signal;

  const NEGATIONS = ['not', 'never', 'no', 'stopped', 'quit', 'former', 'used', 'anymore'];
  const queryNegates = NEGATIONS.some((word) => queryTokens.has(word));
  const factNegates = NEGATIONS.some((word) => factTokens.has(word));
  // One side negates and the other does not, about the same subject matter:
  // that is the shape of "you told me the opposite once".
  if (queryNegates !== factNegates) signal += 0.5;

  return Math.min(1, signal);
}

/** Private facts need a stronger reason to appear (§22.6). */
export function sensitivityPenalty(fact: Fact): number {
  if (fact.sensitivity === 'secret') return 1;
  if (fact.sensitivity === 'private') return 0.35;
  return 0;
}

/* ──────────────────────────────── diversity ───────────────────────────────── */

/**
 * Maximal marginal relevance.
 *
 * Without it, "where do I work?" returns five paraphrases of one employment
 * fact and the context budget is gone. MMR trades a little relevance for
 * coverage, which is the right trade when the consumer is a model that only
 * needs to be told something once.
 */
export function mmr(scored: readonly ScoredFact[], limit: number, lambda: number): ScoredFact[] {
  const selected: ScoredFact[] = [];
  const pool = [...scored];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      if (candidate === undefined) continue;
      const redundancy = selected.reduce(
        (max, chosen) => Math.max(max, textSimilarity(factLine(candidate.fact), factLine(chosen.fact))),
        0,
      );
      const value = lambda * candidate.score - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    const chosen = pool[bestIndex];
    if (chosen === undefined) break;
    selected.push(chosen);
    pool.splice(bestIndex, 1);
  }

  return selected;
}

/* ──────────────────────────────── utilities ───────────────────────────────── */

export function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

export function textSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
