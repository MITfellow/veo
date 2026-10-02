/**
 * Context assembly: the data (L4, §21).
 *
 * Two arrays in this file carry most of the design:
 *
 *   SURVIVAL_ORDER — who dies last when the budget is short (§21's table)
 *   RENDER_ORDER   — what order the model reads things in
 *
 * They are deliberately **different**, and conflating them is the single
 * easiest bug to write here. Kernel instructions survive everything but are
 * read first; the conversation is read last but is one of the first things
 * squeezed. One array could not express that.
 */
import { z } from 'zod';
import type { TrustLevel } from '../../substrate/events/types.js';
import type { ModelMessage, ModelToolSpec } from '../../substrate/model/types.js';

/* ───────────────────────────────── blocks ───────────────────────────────── */

/** §21's fourteen blocks, in **survival priority**: first survives the squeeze. */
export const SURVIVAL_ORDER = [
  'kernel', //  1 invariants, tool protocol, trust-fence rules
  'constitution', //  2 user-editable behavioural contract (§25)
  'identity', //  3 the distilled person, ≤400 tokens, always pinned
  'constraints', //  4 allergies, "never contact X", legal/financial limits
  'situation', //  5 time, timezone, device, locale, trigger, degradation
  'commitments', //  6 what the agent owes the user right now
  'calibration', //  7 what it knows it doesn't know
  'pinned', //  8 user-pinned memories, never evicted
  'memories', //  9 retrieved for this turn, with confidence labels
  'working', // 10 artifacts and entities in play
  'conversation', // 11 recent turns verbatim
  'compacted', // 12 structured summaries with event pointers
  'tools', // 13 only tools permitted at this trust level
  'foreign', // 14 untrusted content, explicitly delimited
] as const;

export type BlockName = (typeof SURVIVAL_ORDER)[number];

/**
 * The order the model reads the blocks in.
 *
 * Situation sits late rather than early on purpose: "the context was
 * truncated" and "you are in degraded mode" are statements about everything
 * above them, and a model reading top-to-bottom should meet them after the
 * material they describe. The conversation is last because that is where
 * every provider expects the live turn to be, and `foreign` sits just before
 * it so untrusted data is bracketed by things the model trusts.
 */
export const RENDER_ORDER = [
  'kernel',
  'constitution',
  'identity',
  'constraints',
  'calibration',
  'commitments',
  'pinned',
  'memories',
  'compacted',
  'working',
  'tools',
  'situation',
  'foreign',
  'conversation',
] as const satisfies readonly BlockName[];

/**
 * Blocks that are never dropped to fit a budget.
 *
 * If these do not fit, assembly throws rather than shipping an agent with no
 * taboos and no instructions. A budget too small to hold "never contact this
 * person" is a configuration error, not a runtime condition to paper over.
 */
export const UNEVICTABLE: ReadonlySet<BlockName> = new Set<BlockName>([
  'kernel',
  'constitution',
  'identity',
  'constraints',
]);

/** §21: the identity card is capped at 400 tokens. Not a suggestion. */
export const IDENTITY_CARD_MAX_TOKENS = 400;

/* ──────────────────────────────── snapshot ──────────────────────────────── */

/**
 * Everything assembly is allowed to know, gathered **before** it runs.
 *
 * This type is why `assembleContext` can be pure. Reading the log, scoring
 * memories and listing permitted tools are all I/O; they happen in
 * `Snapshotter` (L5) and arrive here as plain data that a golden test can
 * check into a file.
 */
export interface StateSnapshot {
  /** Kernel instructions: invariants, tool protocol, fence rules. */
  kernel: string;
  /** The user-editable behavioural contract (§25). Empty string if unset. */
  constitution: string;
  /**
   * The structured constitution (§25, M7). When present it replaces the
   * free-text field above: articles render individually with their ids, so a
   * trace can say *which* article was in front of the model, and the block's
   * sentinel line is what `GovernedProvider` checks before any model call.
   * `null` only in fixtures predating M7.
   */
  constitutionDoc: import('../constitution/render.js').ConstitutionView | null;
  /** The distilled person (§22.7). `null` before consolidation has ever run. */
  identity: IdentityCard | null;
  constraints: readonly Constraint[];
  situation: Situation;
  commitments: readonly Commitment[];
  calibration: readonly CalibrationNote[];
  pinned: readonly MemoryItem[];
  memories: readonly MemoryItem[];
  working: readonly WorkingItem[];
  conversation: readonly Turn[];
  compacted: readonly CompactedChunk[];
  tools: readonly ToolSummary[];
  foreign: readonly ForeignItem[];
  /** Drives §24.4's honest-ignorance paragraph. */
  profile: ProfileStats;
}

export interface IdentityCard {
  text: string;
  /** When consolidation last rewrote it, for the staleness line. */
  updatedAt: number;
  /** How many facts it was distilled from — part of being honest about it. */
  factCount: number;
}

export interface Constraint {
  id: string;
  text: string;
  kind: 'health' | 'legal' | 'financial' | 'relational' | 'other';
}

export interface Situation {
  now: number;
  timezone: string;
  locale: string;
  device: string;
  trigger: string;
  /**
   * Why *this* run, when the trigger alone does not say (M8).
   *
   * A scheduled run that only knows it was "triggered by: schedule" cannot
   * tell the person why it is talking to them at 9am. Naming the schedule
   * is the difference between a notification and an explanation.
   */
  triggerDetail?: string;
  degradation: 'L0' | 'L1' | 'L2' | 'L3';
  sessionTitle?: string;
}

export interface Commitment {
  id: string;
  text: string;
  dueAt: number | null;
  madeAt: number;
}

export interface CalibrationNote {
  id: string;
  question: string;
  /** The fact this uncertainty is about, when there is one. */
  aboutFactId: string | null;
}

/** A memory as the context renders it — epistemics included (invariant 5). */
export interface MemoryItem {
  id: string;
  text: string;
  basis: 'observed' | 'inferred' | 'asserted_by_user' | 'imported';
  confidence: number;
  sourceCount: number;
  observationCount: number;
  lastSeen: number;
  sensitivity: 'normal' | 'private' | 'secret';
  status: 'active' | 'disputed' | 'quarantined' | 'retired';
  pinned: boolean;
  /** Provenance of the content this came from. */
  trust: TrustLevel;
}

export interface WorkingItem {
  id: string;
  kind: string;
  label: string;
  summary: string;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  trust: TrustLevel;
  /** Stable id (the event id) so eviction reporting can point at it. */
  id: string;
}

export interface CompactedChunk {
  id: string;
  summary: CompactionSummary;
}

/** Untrusted content that is not a conversation turn: tool output, fetched text. */
export interface ForeignItem {
  id: string;
  source: string;
  text: string;
  trust: TrustLevel;
}

export interface ToolSummary {
  name: string;
  description: string;
  /** JSON Schema, produced from zod (decision 020). */
  parameters: unknown;
  minTrust: TrustLevel;
}

export interface ProfileStats {
  /** Total active facts known about the principal. */
  factCount: number;
  /** Mean confidence across them, 0..1. */
  meanConfidence: number;
  /** How many sessions this person has had. Turn one of session one is 0. */
  sessionsObserved: number;
}

/* ─────────────────────────────── compaction ─────────────────────────────── */

/**
 * §23: summaries are **structured**, not prose soup, and they keep pointers
 * so the detail can be re-expanded with `history.expand`.
 */
export const CompactionSummarySchema = z.object({
  decisions: z.array(z.string()),
  openThreads: z.array(z.string()),
  entities: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
  span: z.object({
    fromEventId: z.string().min(1),
    toEventId: z.string().min(1),
    turnCount: z.number().int().positive(),
    fromTime: z.number().int().nonnegative(),
    toTime: z.number().int().nonnegative(),
  }),
});
export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

/* ───────────────────────────────── output ───────────────────────────────── */

export interface AssembledBlock {
  name: BlockName;
  tokens: number;
  items: number;
}

export interface Eviction {
  block: BlockName;
  /** Stable id of what was dropped, so a trace can point at it. */
  id: string;
  reason: 'budget' | 'policy' | 'sensitivity' | 'trust';
  tokens: number;
}

export interface AssembledContext {
  messages: ModelMessage[];
  /** Tools the provider should be offered — already filtered by trust. */
  tools: ModelToolSpec[];
  blocks: AssembledBlock[];
  totalTokens: number;
  evictions: Eviction[];
  truncated: boolean;
  /**
   * Stable content digest. Logged with `context.assembled` so "why did it say
   * that?" can be answered months later by re-assembling and comparing.
   */
  digest: string;
  /** Echoed into the event so the budget split in force that day is recoverable. */
  policyVersion: string;
}

/** Raised when the budget cannot hold the unevictable blocks. */
export class ContextTooSmallError extends Error {
  constructor(
    readonly needed: number,
    readonly available: number,
  ) {
    super(
      `The context budget is ${available} tokens but the blocks that may never be ` +
        `dropped (kernel instructions, constitution, identity card, hard constraints) ` +
        `need ${needed}. Assembly refuses to continue: an agent running without its ` +
        `constraints is more dangerous than an agent that does not run. Raise the ` +
        `budget or shorten the constitution.`,
    );
    this.name = 'ContextTooSmallError';
  }
}
