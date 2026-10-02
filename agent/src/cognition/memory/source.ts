/**
 * `StoredMemorySource` — memory, as the context assembler sees it.
 *
 * M5 shipped `MemorySource` as a declared port with no implementation, and
 * the assembler's `memories` block has been empty since. This is the
 * implementation; nothing about the assembler changes.
 *
 * One constraint shapes the whole file: **`gather()` is synchronous**. The
 * snapshotter is called inside the run loop and the assembler is pure, so
 * recall here cannot await an embedder. The resolution is a small cache that
 * the asynchronous path keeps warm: `prime()` runs the real hybrid recall
 * (embeddings and all) between turns, `recall()` reads what it left behind,
 * and if nothing has been primed it falls back to a synchronous lexical +
 * importance ranking.
 *
 * The fallback matters more than the cache. A cold agent on its first turn
 * still recalls — worse, but it recalls — rather than behaving as if it had
 * no memory at all.
 */
import type { MemorySource, RecallQuery } from '../../orchestration/snapshot.js';
import type {
  CalibrationNote,
  Commitment,
  Constraint,
  IdentityCard,
  MemoryItem,
  ProfileStats,
} from '../context/types.js';
import { factLine, type MemoryStore } from './store.js';
import type { MemoryReader } from './read.js';
import { importance, tokens as tokenise } from './read.js';
import type { Fact } from './types.js';

export interface StoredMemorySourceDeps {
  store: MemoryStore;
  reader: MemoryReader;
  clock: { now(): number };
}

export class StoredMemorySource implements MemorySource {
  /** Last asynchronous recall, keyed by the query that produced it. */
  private warm: { key: string; items: MemoryItem[] } | null = null;

  constructor(private readonly deps: StoredMemorySourceDeps) {}

  /** Run the real, asynchronous recall and cache it for the next `recall()`. */
  async prime(query: RecallQuery): Promise<void> {
    const result = await this.deps.reader.recall({
      principal: query.principal,
      text: query.text,
      limit: query.limit,
      now: this.deps.clock.now(),
    });
    this.warm = {
      key: keyOf(query),
      // Pins are rendered by their own block (§21). Letting them through
      // here too puts the same sentence in the prompt twice, which costs
      // budget and reads as though the agent is insisting.
      items: result.items.filter((item) => !item.fact.pinned).map((item) => toItem(item.fact)),
    };
  }

  recall(query: RecallQuery): readonly MemoryItem[] {
    if (this.warm !== null && this.warm.key === keyOf(query)) return this.warm.items;

    // Synchronous fallback: lexical overlap plus importance. No embedder, no
    // await, no excuse for an empty memories block.
    const queryTokens = tokenise(query.text);
    return this.deps.store
      .recallable(query.principal, 300)
      .filter((fact) => fact.sensitivity !== 'secret')
      .map((fact) => {
        const factTokens = tokenise(factLine(fact));
        let overlap = 0;
        for (const token of queryTokens) if (factTokens.has(token)) overlap += 1;
        const score = overlap / Math.max(1, queryTokens.size) + importance(fact) * 0.5;
        return { fact, score };
      })
      .filter((row) => !row.fact.pinned)
      .filter((row) => row.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit)
      .map((row) => toItem(row.fact));
  }

  pinned(principal: string): readonly MemoryItem[] {
    return this.deps.store.pinned(principal).map(toItem);
  }

  identity(principal: string): IdentityCard | null {
    const card = this.deps.store.identityCard(principal);
    if (card === null) return null;
    return {
      text: card.text,
      updatedAt: card.updatedAt,
      factCount: this.deps.store.recallable(principal, 2_000).length,
    };
  }

  /**
   * Constraints the agent must respect — §22.3's rules, rendered as the
   * standing instructions block rather than as memories. A rule is a thing
   * to obey; a fact is a thing to know, and putting them in one block makes
   * both weaker.
   */
  constraints(principal: string): readonly Constraint[] {
    return this.deps.store
      .activeRules(principal)
      .filter((rule) => rule.status === 'active')
      .slice(0, 12)
      .map((rule) => ({
        id: rule.id,
        text: rule.instruction,
        // Learned operating rules are not health or legal constraints; they
        // are preferences with teeth, and 'other' is the honest bucket.
        kind: 'other' as const,
      }));
  }

  /** Promised and not yet done (§22.7). Facts with a `committed_to` predicate. */
  commitments(principal: string): readonly Commitment[] {
    return this.deps.store
      .recallable(principal, 200)
      .filter((fact) => fact.predicate === 'committed_to' && fact.status === 'active')
      .slice(0, 10)
      .map((fact) => ({
        id: fact.id,
        text: String(fact.object),
        dueAt: null,
        madeAt: fact.recordedAt,
      }));
  }

  /**
   * Disputed beliefs become open questions the agent may raise at a natural
   * moment (§22.5 step 4, §24's probe queue). They are surfaced rather than
   * resolved: a disagreement the agent silently picks a side on is a
   * disagreement the user never gets to settle.
   */
  openQuestions(principal: string): readonly CalibrationNote[] {
    return this.deps.store
      .recallable(principal, 200)
      .filter((fact) => fact.status === 'disputed')
      .slice(0, 5)
      .map((fact) => ({
        id: fact.id,
        question: `You have conflicting information about this: ${factLine(fact)}. Ask, do not guess.`,
        aboutFactId: fact.id,
      }));
  }

  profile(principal: string): ProfileStats {
    const facts = this.deps.store.recallable(principal, 2_000);
    const sessions = new Set(this.deps.store.episodes(principal, 500).map((e) => e.sessionId));
    return {
      factCount: facts.length,
      meanConfidence:
        facts.length === 0
          ? 0
          : facts.reduce((sum, fact) => sum + fact.confidence, 0) / facts.length,
      sessionsObserved: sessions.size,
    };
  }
}

function keyOf(query: RecallQuery): string {
  return `${query.principal}|${query.sessionId}|${query.limit}|${query.text}`;
}

function toItem(fact: Fact): MemoryItem {
  return {
    id: fact.id,
    text: factLine(fact),
    basis: fact.basis,
    confidence: fact.confidence,
    sourceCount: fact.sources.length,
    observationCount: fact.observationCount,
    lastSeen: fact.recordedAt,
    sensitivity: fact.sensitivity,
    status: fact.status,
    pinned: fact.pinned,
    trust: fact.trust,
  };
}
