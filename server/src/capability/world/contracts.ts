import { z } from 'zod';
import type { TrustLevel } from '../../substrate/events/types.js';

/**
 * Phase 1 — the canonical domain contracts of one person's world.
 *
 * This file is the vocabulary. It holds no state, calls nothing, and is the
 * single place where "what kinds of things exist in a personal world" is
 * written down. Everything above it — the graph, the resolver, the context
 * pack — refers to these names rather than inventing its own.
 *
 * Three design positions, stated because each had a plausible alternative:
 *
 * **The ontology is deliberately small.** The brief lists thirty node kinds
 * and twenty-four relations. Most of that is aspiration, and an ontology
 * whose entries have no writer and no reader is documentation pretending to
 * be a schema. What is here is what the current build can actually populate
 * from the current sources, plus the edges needed to answer a reference
 * ("him", "it", "the project"). It grows when a source arrives to fill it.
 *
 * **Basis is not a string.** How we came to believe something is the field
 * that decides which claim wins when two disagree, so it is a closed set
 * with a defined order, not prose in a `basis` column.
 *
 * **UNKNOWN is a value, not a null.** Scope, identity and verification can
 * all be genuinely unresolved, and a system that writes `PERSONAL` when it
 * means "nobody has said" is lying in a field that gates retrieval.
 */

// ─────────────────────────────────────────────────────────────── the nodes

/**
 * What can exist in the world.
 *
 * `person`, `org`, `place`, `thing` and `project` are inherited from the
 * entity registry — the world model extends that table rather than opening
 * a second one, because two tables of "things that exist" is precisely the
 * duplication this phase is meant to end.
 */
export const NODE_KINDS = [
  // inherited from the entity registry
  'person', 'org', 'place', 'thing', 'project',
  // the human and their accounts
  'user', 'identity', 'account', 'device',
  // things that carry content
  'conversation', 'message', 'document', 'file', 'artifact',
  // things that occupy time
  'meeting', 'event', 'task', 'commitment', 'routine',
  // things the agent did
  'session', 'run', 'observation', 'action',
  // the outside
  'website', 'application',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const NodeKindSchema = z.enum(NODE_KINDS);

/** The five the entity registry already stores, so a round-trip is lossless. */
export const LEGACY_ENTITY_KINDS = ['person', 'org', 'place', 'thing', 'project'] as const;

// ───────────────────────────────────────────────────────────── the edges

/**
 * How things relate.
 *
 * Written as the subject's verb — `A WORKS_ON B` — and stored in a reserved
 * predicate namespace (`rel:WORKS_ON`) in the existing bitemporal fact
 * table. A relation therefore inherits valid time, transaction time,
 * supersession, retraction, confidence and trust for free, which is the
 * whole argument for not building a second store.
 */
export const RELATION_KINDS = [
  'OWNS', 'BELONGS_TO', 'USES_ACCOUNT',
  'WORKS_WITH', 'WORKS_ON', 'PARTICIPATES_IN', 'ASSIGNED_TO',
  'MENTIONED_IN', 'ATTACHED_TO', 'DISCUSSED_IN', 'RELATED_TO',
  'CREATED', 'MODIFIED', 'SENT', 'RECEIVED',
  'DEPENDS_ON', 'BLOCKS', 'FOLLOWS', 'PRECEDES',
  'LOCATED_IN', 'OCCURRED_DURING', 'GENERATED_FROM', 'VERIFIED_BY',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export const RelationKindSchema = z.enum(RELATION_KINDS);

/** The reserved predicate namespace. A relation is a fact; a fact is not a relation. */
export const RELATION_PREFIX = 'rel:';

export function relationPredicate(kind: RelationKind): string {
  return `${RELATION_PREFIX}${kind}`;
}

export function relationKindOf(predicate: string): RelationKind | undefined {
  if (!predicate.startsWith(RELATION_PREFIX)) return undefined;
  const tail = predicate.slice(RELATION_PREFIX.length);
  return (RELATION_KINDS as readonly string[]).includes(tail) ? (tail as RelationKind) : undefined;
}

/**
 * The inverse of each edge, where one exists.
 *
 * Stored once and traversed both ways: writing both directions doubles the
 * rows and creates the possibility of a graph that disagrees with itself
 * after a retraction touches one copy.
 */
export const INVERSE: Partial<Record<RelationKind, RelationKind>> = {
  OWNS: 'BELONGS_TO',
  BELONGS_TO: 'OWNS',
  BLOCKS: 'DEPENDS_ON',
  DEPENDS_ON: 'BLOCKS',
  FOLLOWS: 'PRECEDES',
  PRECEDES: 'FOLLOWS',
  SENT: 'RECEIVED',
  RECEIVED: 'SENT',
};

// ───────────────────────────────────────────────────────────── the scopes

/**
 * Which part of a life something belongs to (§7, §109).
 *
 * Enforced at retrieval and at action time, so a work document cannot be
 * pulled into a personal thread by a ranking function that only knew about
 * relevance.
 */
export const SCOPES = ['PERSONAL', 'WORK', 'COMPANY', 'PROJECT', 'TEAM', 'SHARED', 'PUBLIC', 'UNKNOWN'] as const;
export type Scope = (typeof SCOPES)[number];
export const ScopeSchema = z.enum(SCOPES);

/**
 * Scopes are not a hierarchy, but they do have containment: a `PROJECT`
 * thing is reachable from a `WORK` question, and nothing is reachable from
 * `UNKNOWN` except by asking.
 */
const SCOPE_CONTAINS: Record<Scope, readonly Scope[]> = {
  PERSONAL: ['PERSONAL'],
  WORK: ['WORK', 'COMPANY', 'TEAM', 'PROJECT'],
  COMPANY: ['COMPANY', 'TEAM', 'PROJECT'],
  TEAM: ['TEAM', 'PROJECT'],
  PROJECT: ['PROJECT'],
  SHARED: ['SHARED'],
  PUBLIC: ['PUBLIC'],
  UNKNOWN: [],
};

/** May a question asked in `asking` scope see a thing in `holding` scope? */
export function scopePermits(asking: Scope, holding: Scope): boolean {
  if (holding === 'PUBLIC') return true;
  // UNKNOWN is visible to nobody implicitly: it is a prompt to resolve, not
  // a wildcard. A wildcard here is how a personal file reaches a work thread.
  if (holding === 'UNKNOWN' || asking === 'UNKNOWN') return asking === holding;
  return SCOPE_CONTAINS[asking].includes(holding);
}

// ───────────────────────────────────────────────────────────── the bases

/**
 * §4 and §14 — how we came to believe it.
 *
 * The order is the precedence order, strongest last, and it is the rule that
 * settles a disagreement between what we remember and what the world
 * currently says. Memory does not beat a verified observation of now.
 */
export const BASES = ['INFERENCE', 'OBSERVATION', 'USER_ASSERTION', 'VERIFIED'] as const;
export type Basis = (typeof BASES)[number];
export const BasisSchema = z.enum(BASES);

const BASIS_RANK: Record<Basis, number> = {
  INFERENCE: 0, OBSERVATION: 1, USER_ASSERTION: 2, VERIFIED: 3,
};

export function basisRank(basis: Basis): number {
  return BASIS_RANK[basis];
}

/**
 * Which of two claims about the same thing currently wins.
 *
 * Basis first, then valid time. Basis first because a verified reading of
 * the calendar beats a remembered sentence however recent the sentence —
 * that is §140, and it is the difference between a diary and a world model.
 * Valid time second because between two claims of equal standing, the one
 * about a later moment is the one about now.
 */
export function winner<T extends { basis: Basis; validFrom: number }>(a: T, b: T): T {
  if (BASIS_RANK[a.basis] !== BASIS_RANK[b.basis]) return BASIS_RANK[a.basis] > BASIS_RANK[b.basis] ? a : b;
  return a.validFrom >= b.validFrom ? a : b;
}

/**
 * The trust a basis may claim, as a ceiling (§20, §68).
 *
 * An inference drawn from FOREIGN content is still FOREIGN; a verified
 * observation of the world is DERIVED at best, because the system did the
 * verifying and the system is not the user. Nothing here can raise trust —
 * these are ceilings applied with `meetTrust`.
 */
export const BASIS_TRUST_CEILING: Record<Basis, TrustLevel> = {
  INFERENCE: 'DERIVED',
  OBSERVATION: 'TOOL',
  USER_ASSERTION: 'USER',
  VERIFIED: 'DERIVED',
};

// ─────────────────────────────────────────────────────── verification (§196)

export const VERIFICATION = ['STRONG', 'MODERATE', 'WEAK', 'UNVERIFIED'] as const;
export type Verification = (typeof VERIFICATION)[number];
export const VerificationSchema = z.enum(VERIFICATION);

// ──────────────────────────────────────────────────────── provenance (§11)

/**
 * Why a piece of context is in front of you.
 *
 * Every retrieval returns this alongside the content. It is not logging —
 * it is what makes "how did you know?" (§91) answerable from state instead
 * of from a generated explanation.
 */
export interface Provenance {
  /** What produced the claim: a connector id, a tool name, 'user', 'inference'. */
  source: string;
  basis: Basis;
  /** When the source reported it. */
  observedAt: number;
  /** The event that recorded it, so the whole chain is replayable. */
  eventId?: string | undefined;
  trust: TrustLevel;
  scope: Scope;
  confidence: number;
  verification: Verification;
}

export const ProvenanceSchema = z.object({
  source: z.string().min(1),
  basis: BasisSchema,
  observedAt: z.number().int(),
  eventId: z.string().optional(),
  trust: z.string(),
  scope: ScopeSchema,
  confidence: z.number().min(0).max(1),
  verification: VerificationSchema,
});

/** A statement of fact in the world, with its provenance attached. */
export interface Claim {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  validTo: number | null;
  basis: Basis;
  scope: Scope;
  confidence: number;
  trust: TrustLevel;
  /** Human-readable reason this claim is the one being shown. */
  because: string;
}

/**
 * Nothing in this file is a judgement about a particular person. It is the
 * shape a personal world has. What fills it is evidence, and what evidence
 * is admissible is decided by the trust lattice, not here.
 */
