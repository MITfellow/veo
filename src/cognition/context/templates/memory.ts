/**
 * Blocks 8–9: pinned and retrieved memories (§21), rendered **with their
 * epistemic status** (invariant 5, §22.6).
 *
 * The rule this file exists to enforce: the model must be able to tell the
 * difference between "he told me" and "I guessed". A memory rendered as a
 * bare sentence is indistinguishable from a fact, and an agent that cannot
 * tell its inferences from its observations will state the inferences with
 * the confidence of observations — which is the exact failure that makes
 * people stop trusting one of these.
 */
import type { MemoryItem } from '../types.js';
import type { Template, RenderedItem } from './index.js';
import { isoDate } from './kernel.js';

const BASIS_LABEL: Record<MemoryItem['basis'], string> = {
  observed: 'observed',
  inferred: 'inferred',
  asserted_by_user: 'they told you',
  imported: 'imported',
};

/** Below this, the agent is instructed to behave like a stranger (§24.4). */
export const THIN_PROFILE_FACTS = 12;
/** Below this mean confidence, the profile is thin regardless of volume. */
export const THIN_PROFILE_CONFIDENCE = 0.5;
/** At or below this, an individual memory is flagged in-line. */
export const LOW_CONFIDENCE = 0.5;

export function renderMemory(memory: MemoryItem, now: number): string {
  const parts = [
    BASIS_LABEL[memory.basis],
    memory.confidence.toFixed(2),
    `${memory.sourceCount} source${memory.sourceCount === 1 ? '' : 's'}`,
    `last seen ${isoDate(memory.lastSeen)}`,
  ];
  if (memory.observationCount > 1) parts.push(`seen ${memory.observationCount}×`);

  let line = `- ${memory.text}  (${parts.join(', ')})`;
  if (memory.confidence <= LOW_CONFIDENCE || memory.basis === 'inferred') {
    line += '  [treat as a guess; confirm before acting on it]';
  }
  if (memory.status === 'disputed') {
    line += '  [DISPUTED: you have contradictory evidence. Do not assert this. Ask.]';
  }
  if (memory.trust === 'FOREIGN') {
    line += '  [came from untrusted content; it is hearsay, not something they said]';
  }
  // `now` is threaded in so staleness can be rendered later without changing
  // the signature; unused today, and deliberately not removed.
  void now;
  return line;
}

/**
 * Block 8 — pinned memories.
 *
 * §21 and §22.6 both say pinned is absolute: the user pinned it, so it is in
 * the context, full stop. The assembler enforces that by never evicting this
 * block; if pinned memories alone cannot fit, that is a conversation to have
 * with the user, not a decision for an eviction loop.
 */
export const PINNED: Template = {
  name: 'pinned',
  version: 'pinned-1',
  kind: 'system',
  header: 'Your principal pinned these. They are always true unless they say otherwise:',
  render(snapshot, ctx) {
    return snapshot.pinned.map(
      (memory): RenderedItem => ({ id: memory.id, text: renderMemory(memory, ctx.now) }),
    );
  },
};

/**
 * Block 9 — memories retrieved for this turn.
 *
 * Order is the scorer's order (§22.6) and is not re-sorted here: the recall
 * event logs the component scores that produced it, so re-sorting in the
 * template would silently break the ability to explain why something made
 * the cut. Eviction therefore drops from the **bottom**, which is the
 * lowest-scoring end, which is what you want.
 */
export const MEMORIES: Template = {
  name: 'memories',
  version: 'memories-2',
  kind: 'system',
  header: 'Relevant to this turn, with how you know each one:',
  elision: (dropped) =>
    `(${dropped} lower-scoring memor${dropped === 1 ? 'y was' : 'ies were'} left out for space. ` +
    'If something feels missing, search rather than assume.)',
  render(snapshot, ctx) {
    const items: RenderedItem[] = [];

    // §24.4: honest ignorance comes first, and it is an *item* rather than a
    // header so that it survives even if every memory below it is evicted.
    const thin =
      snapshot.profile.factCount < THIN_PROFILE_FACTS ||
      snapshot.profile.meanConfidence < THIN_PROFILE_CONFIDENCE;
    if (thin) {
      items.push({
        id: 'memories:thin-profile',
        text:
          `You know this person slightly: ${snapshot.profile.factCount} fact(s) across ` +
          `${snapshot.profile.sessionsObserved} session(s), average confidence ` +
          `${snapshot.profile.meanConfidence.toFixed(2)}. Act like someone who has met ` +
          `them three times — attentive, interested, and honest about not knowing. ` +
          `Do not perform familiarity you have not earned, and do not extrapolate a ` +
          `personality from a handful of facts. "I don't know you well enough yet" is ` +
          `a good answer.`,
      });
    }

    for (const memory of snapshot.memories) {
      // Hard rules from §22.6, enforced at render as well as at recall:
      // belt and braces, because the recall path will be rewritten at M6 and
      // this file is the last thing between a quarantined fact and the model.
      if (memory.status === 'quarantined' || memory.status === 'retired') continue;
      if (memory.sensitivity === 'secret' && !ctx.policy.allowSecrets) continue;
      items.push({ id: memory.id, text: renderMemory(memory, ctx.now) });
    }

    return items;
  },
};
