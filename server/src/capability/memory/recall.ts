import { MemoryStore, decayedConfidence, type Fact, type Sensitivity } from './store.js';

/**
 * Recall: getting the right few facts back out.
 *
 * This is lexical, and it says so. Semantic recall needs an embedding
 * model and this build ships none (§2), so rather than pretend, the score
 * is made of things that can actually be computed here: how well the words
 * match, how confident we are after decay, how recently it mattered, and
 * whether a human pinned it. Every term is visible in the result, so a
 * surprising ordering can be explained rather than shrugged at.
 */

export interface RecallQuery {
  /** Free text. Empty means "whatever is most salient". */
  query?: string | undefined;
  subject?: string | undefined;
  predicate?: string | undefined;
  limit?: number | undefined;
  maxSensitivity?: Sensitivity | undefined;
  /** Append `fact.used` for what comes back (§18). Default true. */
  record?: boolean | undefined;
  runId?: string | undefined;
}

export interface Recalled {
  fact: Fact;
  score: number;
  /** The score, itemised. Shown in the CLI so ranking is arguable. */
  because: { lexical: number; confidence: number; recency: number; pinned: number };
}

const STOP = new Set(['the', 'a', 'an', 'is', 'was', 'of', 'in', 'on', 'at', 'to', 'for', 'my', 'and', 'what', 'who', 'where']);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Does a query word match a stored word?
 *
 * Exact, or one is a prefix of the other from four characters up. That is
 * enough to join "live" to "lives_in" and "berlin" to "Berlin" without
 * pulling in a stemmer, and without matching "car" to "cardiology" — which
 * a two-character prefix rule would happily do.
 */
const PREFIX_MIN = 4;

function matches(queryToken: string, word: string): boolean {
  if (queryToken === word) return true;
  const shorter = queryToken.length <= word.length ? queryToken : word;
  const longer = shorter === queryToken ? word : queryToken;
  return shorter.length >= PREFIX_MIN && longer.startsWith(shorter);
}

/** Overlap of query tokens with the fact's own words, 0–1. */
function lexical(queryTokens: string[], fact: Fact): number {
  if (queryTokens.length === 0) return 0.5;
  const haystack = tokens(`${fact.subject} ${fact.predicate} ${fact.object}`);
  const hits = queryTokens.filter((t) => haystack.some((w) => matches(t, w))).length;
  return hits / queryTokens.length;
}

/**
 * Recency over 90 days, linear.
 *
 * Not exponential: confidence already decays exponentially by stability,
 * and compounding the two would make anything a month old effectively
 * invisible regardless of how important it is.
 */
const RECENCY_WINDOW_MS = 90 * 24 * 3600 * 1000;

function recency(fact: Fact, now: number): number {
  const age = Math.max(0, now - fact.recordedAt);
  return Math.max(0, 1 - age / RECENCY_WINDOW_MS);
}

const WEIGHTS = { lexical: 0.5, confidence: 0.3, recency: 0.2, pinned: 0.25 } as const;

export function recall(store: MemoryStore, now: number, query: RecallQuery = {}): Recalled[] {
  const limit = query.limit ?? 10;
  const queryTokens = tokens(query.query ?? '');

  const pool = store.asOf({
    ...(query.subject === undefined ? {} : { subject: query.subject }),
    ...(query.predicate === undefined ? {} : { predicate: query.predicate }),
    ...(query.maxSensitivity === undefined ? {} : { maxSensitivity: query.maxSensitivity }),
    limit: 2000,
  });

  const scored: Recalled[] = pool.map((fact) => {
    const because = {
      lexical: Number(lexical(queryTokens, fact).toFixed(3)),
      confidence: decayedConfidence(fact, now),
      recency: Number(recency(fact, now).toFixed(3)),
      // A pin is a human saying "this matters". It is a bonus, not a
      // multiplier: pinning something should lift it, not guarantee it
      // outranks a direct lexical hit on the actual question.
      pinned: fact.pinned ? 1 : 0,
    };
    const score =
      because.lexical * WEIGHTS.lexical +
      because.confidence * WEIGHTS.confidence +
      because.recency * WEIGHTS.recency +
      because.pinned * WEIGHTS.pinned;
    return { fact, score: Number(score.toFixed(4)), because };
  });

  // A query with words in it should not return facts sharing none of them.
  const relevant = queryTokens.length === 0 ? scored : scored.filter((s) => s.because.lexical > 0);

  const top = relevant
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
    .slice(0, limit);

  // §18: record what was recalled, so "what did it know when it said that"
  // is a query rather than a guess.
  if (query.record !== false) {
    for (const r of top) store.used(r.fact.id, query.runId);
  }
  return top;
}
