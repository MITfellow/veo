/**
 * The four stores, as schemas (§22).
 *
 * §36: the schema is the single definition. Every type in this file is
 * inferred from a zod schema rather than declared alongside one, so a shape
 * cannot drift from its validator.
 *
 * The epistemic fields on `Fact` are not metadata. `basis`, `confidence` and
 * `sources` are what separate "I know where you work" from "someone once
 * typed a company name near your name", and invariant 5 says a belief
 * without a source is not a belief. The DB enforces the same thing with a
 * `CHECK (json_array_length(sources) >= 1)`, because a rule stated in two
 * places is a rule that holds when one of them is bypassed.
 */
import { z } from 'zod';
import {
  BasisSchema,
  FactStatusSchema,
  SensitivitySchema,
  SourceRefSchema,
  StabilitySchema,
  TrustLevelSchema,
} from '../../substrate/events/types.js';

/* ───────────────────────────── semantic (§22.2) ───────────────────────────── */

export const EntityRefSchema = z.object({
  /** `self` is the principal. Everything else is an entity id. */
  id: z.string().min(1),
  kind: z.enum(['person', 'project', 'org', 'place', 'device', 'account', 'self', 'other']),
  label: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const FactSchema = z.object({
  id: z.string().min(1),
  subject: EntityRefSchema,
  predicate: z.string().min(1).max(64),
  object: z.unknown(),

  basis: BasisSchema,
  confidence: z.number().min(0).max(1),
  /** REQUIRED, and `.min(1)` is load-bearing: invariant 5. */
  sources: z.array(SourceRefSchema).min(1),
  observationCount: z.number().int().nonnegative().default(1),
  contradictedCount: z.number().int().nonnegative().default(0),

  validFrom: z.number().int(),
  validTo: z.number().int().nullable().default(null),
  recordedAt: z.number().int(),
  supersededAt: z.number().int().nullable().default(null),
  supersedes: z.string().nullable().default(null),
  supersededBy: z.string().nullable().default(null),

  stability: StabilitySchema.default('slow'),
  sensitivity: SensitivitySchema.default('normal'),
  trust: TrustLevelSchema,
  status: FactStatusSchema.default('active'),
  pinned: z.boolean().default(false),
  keyId: z.string().nullable().default(null),
});
export type Fact = z.infer<typeof FactSchema>;

/**
 * What an extractor proposes. Not a fact yet — it has not passed the gate,
 * and most candidates never will.
 */
export const CandidateSchema = z.object({
  subject: EntityRefSchema,
  predicate: z.string().min(1).max(64),
  object: z.unknown(),
  basis: BasisSchema,
  confidence: z.number().min(0).max(1),
  sources: z.array(SourceRefSchema),
  stability: StabilitySchema.default('slow'),
  sensitivity: SensitivitySchema.default('normal'),
  /** Set by the extractor when the sentence was about right now, not about
      how things are. Transient state is episodic only (§22.5). */
  transient: z.boolean().default(false),
  /** The sentence it came from, kept for the gate to inspect. */
  utterance: z.string().default(''),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/* ──────────────────────────── procedural (§22.3) ──────────────────────────── */

export const TriggerSchema = z.object({
  kind: z.enum(['always', 'topic', 'tool', 'recipient']),
  value: z.string().default(''),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const RuleSchema = z.object({
  id: z.string().min(1),
  principal: z.string().min(1),
  trigger: TriggerSchema,
  instruction: z.string().min(1).max(400),
  scope: z.enum(['global', 'context']).default('global'),
  sources: z.array(SourceRefSchema).min(1),
  basis: BasisSchema.default('observed'),
  confidence: z.number().min(0).max(1).default(0.5),
  applied: z.number().int().nonnegative().default(0),
  overridden: z.number().int().nonnegative().default(0),
  lastApplied: z.number().int().nullable().default(null),
  lastOverridden: z.number().int().nullable().default(null),
  status: z.enum(['active', 'probation', 'retired']).default('active'),
  trust: TrustLevelSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

/** §22.3, verbatim: 3 overrides → probation, 5 → retired. */
export const PROBATION_AT = 3;
export const RETIRE_AT = 5;

/* ───────────────────────────── episodic (§22.1) ───────────────────────────── */

export const EpisodeSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sessionId: z.string().nullable().default(null),
  principal: z.string().min(1),
  request: z.string(),
  response: z.string().default(''),
  actions: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  outcome: z.enum(['satisfied', 'corrected', 'abandoned', 'unknown']).default('unknown'),
  outcomeReason: z.string().nullable().default(null),
  trust: TrustLevelSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int(),
  costMicros: z.number().int().nonnegative().default(0),
});
export type Episode = z.infer<typeof EpisodeSchema>;

/* ──────────────────────── affective / relational (§22.4) ──────────────────── */

/**
 * Six numbers and a list. The shape is the policy: there is no column here
 * that could hold a demographic, so §22.4's prohibition is not a rule someone
 * has to remember — it is a thing the schema cannot express.
 */
export const AffectSchema = z.object({
  principal: z.string().min(1),
  formality: z.number().min(0).max(1).default(0.5),
  humor: z.number().min(0).max(1).default(0.5),
  verbosity: z.number().min(0).max(1).default(0.5),
  directness: z.number().min(0).max(1).default(0.5),
  hedging: z.number().min(0).max(1).default(0.5),
  sensitiveTopics: z.array(z.string()).default([]),
  episodesSeen: z.number().int().nonnegative().default(0),
});
export type Affect = z.infer<typeof AffectSchema>;

/**
 * Affect is derived from *many* episodes, never one (§22.4). Below this
 * count the defaults stand and the store reports that it does not know yet,
 * which is the honest answer and also the one that avoids mirroring a single
 * bad day back at someone forever.
 */
export const AFFECT_MIN_EPISODES = 12;

/* ───────────────────────────── the write gate ─────────────────────────────── */

export const REJECTION_REASONS = [
  'no-source',
  'hypothetical',
  'third-party',
  'transient',
  'user-refused',
  'protected-attribute',
  'low-confidence',
  'malformed',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface GateDecision {
  accepted: Candidate[];
  rejected: Array<{ candidate: Candidate; reason: RejectionReason; detail: string }>;
  /** FOREIGN-trust candidates, written as `quarantined` and never recalled. */
  quarantined: Candidate[];
}

/* ───────────────────────────────── recall ─────────────────────────────────── */

export interface RecallWeights {
  semantic: number;
  lexical: number;
  recency: number;
  importance: number;
  entity: number;
  /** Deliberately positive. See §3.4 and `read.ts`. */
  contradiction: number;
  sensitivity: number;
}

/** §22.6's weights, in config rather than scattered through the scorer. */
export const DEFAULT_WEIGHTS: RecallWeights = {
  semantic: 0.3,
  lexical: 0.25,
  recency: 0.15,
  importance: 0.15,
  entity: 0.1,
  contradiction: 0.12,
  sensitivity: 0.2,
};

/** Half-lives in days, by stability (§22.6 "half-life by `stability`"). */
export const HALF_LIFE_DAYS: Record<'volatile' | 'slow' | 'stable', number> = {
  volatile: 7,
  slow: 180,
  stable: 3_650,
};

export interface ScoredFact {
  fact: Fact;
  score: number;
  components: Record<string, number>;
}
