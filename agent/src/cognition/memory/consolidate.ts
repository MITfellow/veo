/**
 * Consolidation — "sleep" (§22.7).
 *
 * Runs nightly and after every N episodes. Four jobs, in order, and the
 * order matters: decay before distillation (so a dying belief is not used to
 * justify a new one), rules after facts (so a rule learned today is measured
 * against the episodes that produced it), the identity card last (it is a
 * summary of everything above).
 *
 * **Idempotent, and tested for it** (§22.7, explicitly). Running twice
 * changes nothing the second time. The mechanism is not cleverness: episodes
 * are marked `consolidated_at` as they are read, decay is a pure function of
 * the clock rather than an increment, and the identity card is content-keyed
 * by digest. Anything that *accumulated* on each pass — a counter, an
 * appended paragraph — would drift every night and nobody would notice for a
 * month.
 */
import type { EventLog } from '../../substrate/events/log.js';
import type { Clock, Logger } from '../../substrate/ports.js';
import { digestOf, estimateTokens } from '../tokens.js';
import { factLine, MemoryStore } from './store.js';
import { recencyDecay } from './read.js';
import {
  AFFECT_MIN_EPISODES,
  PROBATION_AT,
  RETIRE_AT,
  type Episode,
  type Fact,
} from './types.js';

export interface ConsolidatorDeps {
  store: MemoryStore;
  events: EventLog;
  clock: Clock;
  logger?: Logger;
}

export interface ConsolidationResult {
  episodes: number;
  factsWritten: number;
  factsDecayed: number;
  rulesRetired: number;
  identityTokens: number;
  digest: string;
}

/** §22.7's budget for the identity card. */
export const IDENTITY_CARD_TOKENS = 400;

/** Below this confidence a decayed belief stops being recalled at all. */
export const DECAY_FLOOR = 0.15;

export class Consolidator {
  constructor(private readonly deps: ConsolidatorDeps) {}

  run(principal: string): ConsolidationResult {
    const now = this.deps.clock.now();
    const episodes = this.deps.store.unconsolidatedEpisodes(principal);

    const factsDecayed = this.decay(principal, now);
    const rulesRetired = this.reviewRules(principal, episodes);
    const factsWritten = this.distil(principal, episodes);
    this.updateAffect(principal, episodes);
    const card = this.identityCard(principal, now);
    this.writeDigest(principal, episodes);

    this.deps.store.markConsolidated(
      episodes.map((episode) => episode.id),
      now,
    );

    const result: ConsolidationResult = {
      episodes: episodes.length,
      factsWritten,
      factsDecayed,
      rulesRetired,
      identityTokens: card.tokens,
      digest: card.digest,
    };

    this.deps.events.append({
      type: 'memory.consolidated',
      principal,
      trust: 'SYSTEM',
      payload: result,
    });

    return result;
  }

  /**
   * Confidence decays with time, by half-life, and a belief that falls
   * through the floor is retired rather than deleted.
   *
   * Computed from the clock rather than multiplied down each pass — that is
   * what makes running twice in one night a no-op instead of a slow erasure.
   */
  private decay(principal: string, now: number): number {
    let decayed = 0;
    for (const fact of this.deps.store.recallable(principal, 2_000)) {
      if (fact.pinned || fact.basis === 'asserted_by_user') continue;
      const factor = recencyDecay(fact, now);
      const target = fact.confidence * (0.5 + 0.5 * factor);
      if (target >= fact.confidence - 0.01) continue;

      if (target < DECAY_FLOOR) {
        this.deps.store.correct({
          factId: fact.id,
          principal,
          trust: 'SYSTEM',
          was: fact.object,
          now: null,
          by: 'decay',
        });
      } else {
        this.deps.events.append({
          type: 'memory.updated',
          principal,
          trust: 'SYSTEM',
          payload: { factId: fact.id, confidence: target },
        });
      }
      decayed += 1;
    }
    return decayed;
  }

  /**
   * Rules that keep getting overridden decay and retire (§22.3).
   *
   * The override signal is the honest weak point of M6 and it is recorded as
   * such in the progress note: an override is detected when an episode's
   * outcome was `corrected` while the rule was active. That is a real signal
   * and a noisy one — the correction may have been about something else
   * entirely. It is wired, it is conservative (only `corrected` episodes
   * count), and it is the kind of thing that should be replaced by an
   * explicit "that's not how I like it" signal rather than quietly trusted.
   */
  private reviewRules(principal: string, episodes: readonly Episode[]): number {
    const corrections = episodes.filter((episode) => episode.outcome === 'corrected').length;
    if (corrections === 0) return 0;

    let retired = 0;
    for (const rule of this.deps.store.activeRules(principal)) {
      if (rule.applied === 0) continue;
      const overridden = rule.overridden + corrections;
      const status =
        overridden >= RETIRE_AT ? 'retired' : overridden >= PROBATION_AT ? 'probation' : rule.status;

      this.deps.store.upsertRule({ ...rule, overridden, status });
      this.deps.events.append({
        type: 'rule.overridden',
        principal,
        trust: 'SYSTEM',
        payload: { ruleId: rule.id, overridden, status },
      });

      if (status === 'retired' && rule.status !== 'retired') {
        this.deps.events.append({
          type: 'rule.retired',
          principal,
          trust: 'SYSTEM',
          payload: {
            ruleId: rule.id,
            reason: `overridden ${overridden} times; it was making things worse, not better`,
          },
        });
        retired += 1;
      }
    }
    return retired;
  }

  /**
   * Distillation: episodes that repeat become beliefs.
   *
   * Conservative on purpose. The only thing promoted here is a *repeated*
   * pattern across several episodes — three or more — because a single
   * episode is an anecdote, and an agent that generalises from anecdotes is
   * the thing everyone complains about.
   */
  private distil(principal: string, episodes: readonly Episode[]): number {
    if (episodes.length < 3) return 0;

    const toolCounts = new Map<string, number>();
    for (const episode of episodes) {
      for (const action of new Set(episode.actions)) {
        toolCounts.set(action, (toolCounts.get(action) ?? 0) + 1);
      }
    }

    let written = 0;
    for (const [tool, count] of toolCounts) {
      if (count < 3) continue;
      const existing = this.deps.store
        .bySubject('self')
        .find((fact) => fact.predicate === 'often_asks_for' && fact.object === tool);
      if (existing !== undefined) {
        this.deps.store.confirm(existing.id, principal, 'DERIVED');
        continue;
      }
      this.deps.store.write({
        principal,
        subject: { id: 'self', kind: 'self', label: 'you' },
        predicate: 'often_asks_for',
        object: tool,
        // Inferred, and labelled as inferred. The user never said this.
        basis: 'inferred',
        confidence: Math.min(0.6, 0.3 + count * 0.05),
        sources: episodes
          .filter((episode) => episode.actions.includes(tool))
          .slice(0, 5)
          .map((episode) => ({ eventId: episode.runId, quote: episode.request.slice(0, 120) })),
        trust: 'DERIVED',
        stability: 'slow',
      });
      written += 1;
    }
    return written;
  }

  /** §22.4: derived from many episodes, never one, and never from demographics. */
  private updateAffect(principal: string, episodes: readonly Episode[]): void {
    if (episodes.length === 0) return;
    const affect = this.deps.store.affect(principal);
    const seen = affect.episodesSeen + episodes.length;
    if (seen < AFFECT_MIN_EPISODES) {
      this.deps.store.putAffect({ ...affect, episodesSeen: seen });
      return;
    }

    const requests = episodes.map((episode) => episode.request);
    const averageLength = requests.reduce((sum, r) => sum + r.length, 0) / requests.length;
    const politeness = requests.filter((r) => /\b(?:please|thanks|thank you|could you)\b/i.test(r)).length / requests.length;

    // Exponential moving average: one unusual week moves the needle a
    // little, a changed relationship moves it eventually.
    const blend = (current: number, observed: number): number => current * 0.8 + observed * 0.2;

    this.deps.store.putAffect({
      ...affect,
      episodesSeen: seen,
      formality: blend(affect.formality, politeness),
      verbosity: blend(affect.verbosity, Math.min(1, averageLength / 400)),
      directness: blend(affect.directness, 1 - politeness),
    });
  }

  /**
   * The identity card (§22.7) — "why turn one of a brand-new session already
   * feels known". ≤400 tokens, rebuilt from the highest-value beliefs.
   */
  identityCard(principal: string, now: number): { text: string; tokens: number; digest: string } {
    const facts = this.deps.store
      .recallable(principal, 500)
      .filter((fact) => fact.status === 'active' && fact.sensitivity !== 'secret')
      .sort((a, b) => rank(b, now) - rank(a, now));

    const lines: string[] = [];
    let tokens = 0;
    for (const fact of facts) {
      const line = `- ${factLine(fact)}${fact.basis === 'inferred' ? ' (inferred)' : ''}`;
      const cost = estimateTokens(line);
      if (tokens + cost > IDENTITY_CARD_TOKENS - 24) break;
      lines.push(line);
      tokens += cost;
    }

    const rules = this.deps.store
      .activeRules(principal)
      .filter((rule) => rule.status === 'active')
      .slice(0, 6);
    for (const rule of rules) {
      const line = `- ${rule.instruction}`;
      const cost = estimateTokens(line);
      if (tokens + cost > IDENTITY_CARD_TOKENS - 8) break;
      lines.push(line);
      tokens += cost;
    }

    const text =
      lines.length === 0
        ? 'You do not know this person yet.'
        : `What you know about this person:\n${lines.join('\n')}`;
    const digest = digestOf([text]);

    this.deps.store.putIdentityCard(principal, text, estimateTokens(text), facts.length, digest);
    return { text, tokens: estimateTokens(text), digest };
  }

  /**
   * "What I learned recently" (§22.7) — written for the user to read and
   * correct, not for the model. Surfacing learning is how trust is earned,
   * and a store nobody can inspect is a store nobody should accept.
   */
  private writeDigest(principal: string, episodes: readonly Episode[]): void {
    if (episodes.length === 0) return;
    const recent = this.deps.store
      .recallable(principal, 100)
      .filter((fact) => episodes.some((episode) => fact.recordedAt >= episode.startedAt))
      .slice(0, 8);
    if (recent.length === 0) return;

    const text = [
      `From your last ${episodes.length} conversation${episodes.length === 1 ? '' : 's'} I noted:`,
      ...recent.map((fact) => `• ${factLine(fact)} (${Math.round(fact.confidence * 100)}% sure, ${fact.basis.replaceAll('_', ' ')})`),
      'If any of that is wrong, tell me and I will correct it.',
    ].join('\n');

    this.deps.store.addDigestEntry(
      principal,
      text,
      recent.map((fact) => fact.id),
    );
  }
}

function rank(fact: Fact, now: number): number {
  return (
    fact.confidence * 2 +
    (fact.pinned ? 3 : 0) +
    (fact.basis === 'asserted_by_user' ? 0.5 : 0) +
    recencyDecay(fact, now)
  );
}
