/**
 * The write gate (§22.5 step 2) — the most important forty lines in M6.
 *
 * Everything else in memory makes the agent know more. This makes it know
 * *less*, on purpose, and it is the difference between an agent that becomes
 * more useful over two years and one that becomes a liability. An agent that
 * remembers everything it hears has been trained by whoever talked to it
 * last.
 *
 * Seven refusals, each from §22.5, each with its reason recorded (decision
 * 027). The gate is pure: same candidates, same decisions, every time. No
 * clock, no model, no I/O — which is what makes the rules in here testable
 * one at a time instead of only in aggregate.
 */
import type { TrustLevel } from '../../substrate/events/types.js';
import type { Candidate, GateDecision, RejectionReason } from './types.js';

/**
 * Framing that makes a sentence not an assertion about the world.
 *
 * Matched against the originating utterance, not the extracted value: "if I
 * were vegetarian I'd order the pasta" yields a perfectly well-formed
 * `prefers: vegetarian` candidate, and the only thing that reveals it as
 * hypothetical is the sentence it came from.
 */
const HYPOTHETICAL = [
  /\bif i (?:were|was|had|lived|worked)\b/i,
  /\bsuppose\b/i,
  /\bimagine (?:that |if )?\b/i,
  /\bpretend\b/i,
  /\bhypothetical/i,
  /\bwhat if\b/i,
  /\bin (?:a|the) (?:story|game|novel|roleplay|simulation)\b/i,
  /\bfor the sake of argument\b/i,
  /\byou are now\b/i,
  /\bact as\b/i,
];

/** "Don't remember this" — and the near-misses people actually type. */
const REFUSALS = [
  /\b(?:do ?n[o']?t|please don'?t|never) (?:remember|save|store|keep|record)\b/i,
  /\bforget (?:this|that|what i)\b/i,
  /\boff the record\b/i,
  /\bthis is (?:private|confidential), (?:do ?n[o']?t|please don'?t)\b/i,
  /\bdon'?t add (?:this|that) to (?:your )?memory\b/i,
];

/** Right-now state, not how things are. Episodic only (§22.5). */
const TRANSIENT_PREDICATES = new Set([
  'feels',
  'feeling',
  'mood',
  'is_tired',
  'is_busy',
  'is_hungry',
  'location_now',
  'currently_doing',
  'weather',
]);

const TRANSIENT_PHRASES = [
  /\b(?:i'?m|i am|feeling) (?:so )?(?:tired|exhausted|hungry|sick|stressed|busy|bored|sleepy)\b/i,
  /\b(?:today|right now|at the moment|this morning|tonight|currently)\b/i,
];

/**
 * §3.2 / §22.5: protected attributes are never inferred.
 *
 * The distinction the code makes is between *inferring* and being *told*:
 * a user who says "I'm Jewish, so no meetings on Saturday" has asserted
 * something about themselves and the agent should respect it. What is
 * forbidden is the agent deducing it — from a name, a language, a location,
 * a holiday, a photo. So `asserted_by_user` passes and everything else does
 * not, which is a rule about provenance rather than about topic, and
 * provenance is the thing the system can actually verify.
 */
const PROTECTED_PREDICATES = new Set([
  'race',
  'ethnicity',
  'religion',
  'religious_belief',
  'sexual_orientation',
  'gender_identity',
  'political_affiliation',
  'health_condition',
  'disability',
  'immigration_status',
  'criminal_record',
  'union_membership',
  'pregnancy_status',
  'genetic_information',
]);

/** Marks content the user merely relayed rather than asserted. */
const THIRD_PARTY = [
  /\b(?:he|she|they|my (?:boss|friend|colleague|wife|husband|mother|father)) (?:said|says|wrote|told me|thinks)\b/i,
  /\bforwarded\b/i,
  /\baccording to\b/i,
  /\bthe (?:email|article|page|message) says\b/i,
  /^\s*["“>]/,
];

export interface GateInput {
  candidates: readonly Candidate[];
  /** Trust of the content the candidates were extracted from. */
  trust: TrustLevel;
  /** The user's own words this turn — where a refusal would be stated. */
  utterance: string;
  /** Below this, a candidate is not worth the storage or the risk. */
  minConfidence?: number;
}

export const DEFAULT_MIN_CONFIDENCE = 0.35;

export function gate(input: GateInput): GateDecision {
  const accepted: Candidate[] = [];
  const quarantined: Candidate[] = [];
  const rejected: GateDecision['rejected'] = [];
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // A refusal in *this turn* applies to everything extracted from it. Said
  // once, honoured for the whole utterance — asking the user to repeat
  // "don't remember that" per sentence would be an insult.
  const refused = REFUSALS.some((pattern) => pattern.test(input.utterance));

  for (const candidate of input.candidates) {
    const reason = reject(candidate, input, refused, minConfidence);
    if (reason !== null) {
      rejected.push({ candidate, reason: reason.reason, detail: reason.detail });
      continue;
    }

    // FOREIGN content never becomes an active belief (§22.5, §12). It is
    // kept, quarantined, so that "where did you get that idea?" has an
    // answer and so the injection itself is auditable — but no amount of
    // scoring can lift a quarantined fact into a prompt.
    if (input.trust === 'FOREIGN') {
      quarantined.push(candidate);
      continue;
    }

    accepted.push(candidate);
  }

  return { accepted, rejected, quarantined };
}

function reject(
  candidate: Candidate,
  input: GateInput,
  refused: boolean,
  minConfidence: number,
): { reason: RejectionReason; detail: string } | null {
  if (candidate.sources.length === 0) {
    // Invariant 5. A belief with no source cannot be explained, corrected or
    // trusted, and an agent that cannot say why it thinks something is an
    // agent you eventually stop believing.
    return { reason: 'no-source', detail: 'a fact with no source span cannot be explained later' };
  }

  if (candidate.predicate.trim() === '' || candidate.object === undefined || candidate.object === null) {
    return { reason: 'malformed', detail: 'empty predicate or object' };
  }

  if (refused) {
    return { reason: 'user-refused', detail: 'the user asked for this turn not to be remembered' };
  }

  const text = candidate.utterance === '' ? input.utterance : candidate.utterance;

  if (HYPOTHETICAL.some((pattern) => pattern.test(text))) {
    return { reason: 'hypothetical', detail: 'stated as a hypothetical, not as a fact' };
  }

  if (
    PROTECTED_PREDICATES.has(candidate.predicate) &&
    candidate.basis !== 'asserted_by_user'
  ) {
    // Not a topic ban — a provenance rule. The user may tell the agent
    // anything about themselves; the agent may not deduce this class of
    // thing about them (§3.2).
    return {
      reason: 'protected-attribute',
      detail: `'${candidate.predicate}' may be asserted by the user but never inferred`,
    };
  }

  // Relayed speech never becomes a fact *about the user*, whatever its
  // basis.
  //
  // This deliberately does not exempt `asserted_by_user`. The user really
  // did type "my boss said he works at Globex", so the assertion is theirs
  // — but what they asserted is something about their boss, and the
  // extractor's subject guess ('self', because the sentence starts with
  // "my") is the thing that is wrong. Exempting user assertions would make
  // this rule inert for the pattern extractor, which labels everything
  // asserted_by_user, which is to say it would make the rule decorative.
  if (candidate.subject.id === 'self' && THIRD_PARTY.some((pattern) => pattern.test(text))) {
    return {
      reason: 'third-party',
      detail: 'content the user relayed, not a claim the user made about themselves',
    };
  }

  if (
    candidate.transient ||
    TRANSIENT_PREDICATES.has(candidate.predicate) ||
    (candidate.stability === 'volatile' && TRANSIENT_PHRASES.some((p) => p.test(text)))
  ) {
    return { reason: 'transient', detail: 'right-now state belongs in the episode, not in facts' };
  }

  if (candidate.confidence < minConfidence) {
    return {
      reason: 'low-confidence',
      detail: `confidence ${candidate.confidence.toFixed(2)} is below the floor ${minConfidence}`,
    };
  }

  return null;
}

/** For `memory.rejected`: enough to answer "why don't you know that?", not
 *  enough to reconstruct what was dropped (decision 027). */
export function subjectHint(candidate: Candidate): string {
  return candidate.subject.id === 'self' ? 'self' : candidate.subject.kind;
}
