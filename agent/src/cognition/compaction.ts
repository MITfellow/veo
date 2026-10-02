/**
 * Compaction (§23, L4).
 *
 * Rules, all four of which are load-bearing:
 *
 *   - summarize the **oldest** contiguous chunk, never the newest
 *   - summaries are **structured**, not prose soup
 *   - keep event-id pointers so detail can be re-expanded (`history.expand`)
 *   - originals are never destroyed — compaction is a view, not a deletion
 *
 * The last one is invariant 2 restated: a summary is a *new event*, never an
 * edit. The raw turns stay in the log forever and the summary points at
 * them, so "what did they actually say in March?" has an answer in year ten.
 *
 * ## Why the default summarizer is extractive, not a model call
 *
 * The obvious implementation asks the model to summarize. That makes
 * compaction cost money, take a second, vary between runs, and fail when the
 * provider is down — on a path that runs *while the user is waiting*. It
 * also makes the context a function of when you asked rather than of what
 * happened, which quietly breaks determinism (invariant 4).
 *
 * So the default is extractive and pure: it pulls decisions, questions and
 * entities out of the turns themselves. It is visibly worse prose than a
 * model would write, and visibly more honest — every line in a summary is
 * something that was literally said. A model summarizer can be injected
 * (`Compactor({summarize})`) when one is available and the result is logged
 * with the summarizer's name either way, so you can always tell which
 * produced a given summary.
 */
import { z } from 'zod';
import type { Event } from '../substrate/events/envelope.js';
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Ids } from '../substrate/ports.js';
import { CompactionSummarySchema, type CompactedChunk, type CompactionSummary } from './context/types.js';
import { estimateTokens } from './tokens.js';

export { CompactionSummarySchema } from './context/types.js';
export type { CompactionSummary } from './context/types.js';

/** A conversation turn as compaction sees it: the event plus its text. */
export interface SourceTurn {
  eventId: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export type Summarizer = (turns: readonly SourceTurn[]) => CompactionSummary;

export interface CompactionPolicy {
  /** Compact once the session exceeds this many turns. */
  compactAfterTurns: number;
  /** How many of the oldest turns to fold into one summary. */
  chunkTurns: number;
  /** Never compact the most recent N turns, whatever the pressure. */
  keepVerbatim: number;
}

export const DEFAULT_COMPACTION: CompactionPolicy = {
  compactAfterTurns: 40,
  chunkTurns: 20,
  keepVerbatim: 12,
};

/* ─────────────────────────── the summarizer ─────────────────────────────── */

const DECISION_MARKERS = [
  "let's",
  'lets ',
  'i will',
  "i'll",
  'we will',
  "we'll",
  'decided',
  'going with',
  'agreed',
  'plan is',
  'i am going to',
];
const OPEN_MARKERS = ['todo', 'still need', 'next step', 'follow up', 'waiting on', 'later'];

/**
 * Extract structure from turns, deterministically.
 *
 * Crude on purpose. The alternative is prose soup that *sounds* like
 * understanding; this at least cannot hallucinate, because every string it
 * emits is a substring of something that was actually said. §23 asks for
 * decisions, open threads, entities and unresolved questions, and an
 * honestly incomplete list of real sentences beats a fluent invented one.
 */
export const extractiveSummarizer: Summarizer = (turns) => {
  const decisions: string[] = [];
  const openThreads: string[] = [];
  const unresolvedQuestions: string[] = [];
  const entities = new Set<string>();

  const answered = new Set<number>();
  for (const [index, turn] of turns.entries()) {
    for (const sentence of sentences(turn.text)) {
      const lower = sentence.toLowerCase();
      if (DECISION_MARKERS.some((marker) => lower.includes(marker))) {
        decisions.push(`${turn.role}: ${sentence}`);
      }
      if (OPEN_MARKERS.some((marker) => lower.includes(marker))) {
        openThreads.push(`${turn.role}: ${sentence}`);
      }
      if (sentence.endsWith('?')) {
        // A question is unresolved only if nobody said anything afterwards.
        // The next turn is a weak signal, and a weak signal honestly labelled
        // is better than dropping the question entirely.
        const hasReply = turns[index + 1] !== undefined;
        if (!hasReply) unresolvedQuestions.push(`${turn.role}: ${sentence}`);
        else answered.add(index);
      }
    }
    for (const name of properNouns(turn.text)) entities.add(name);
  }

  const first = turns[0]!;
  const last = turns[turns.length - 1]!;

  return CompactionSummarySchema.parse({
    decisions: dedupe(decisions).slice(0, 12),
    openThreads: dedupe(openThreads).slice(0, 8),
    entities: [...entities].sort().slice(0, 20),
    unresolvedQuestions: dedupe(unresolvedQuestions).slice(0, 6),
    span: {
      fromEventId: first.eventId,
      toEventId: last.eventId,
      turnCount: turns.length,
      fromTime: first.at,
      toTime: last.at,
    },
  });
};

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && sentence.length < 240);
}

/**
 * Capitalised words that are not sentence-initial. A name detector this
 * simple will miss things and occasionally catch a stray capital; it is a
 * retrieval hint, not a claim about the world, and M6's entity graph
 * replaces it with something that knows what a person is.
 */
function properNouns(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/);
    for (const [index, word] of words.entries()) {
      if (index === 0) continue;
      const cleaned = word.replace(/[^A-Za-z'-]/g, '');
      if (cleaned.length > 2 && /^[A-Z][a-z'-]+$/.test(cleaned)) found.push(cleaned);
    }
  }
  return found;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* ──────────────────────────── the compactor ─────────────────────────────── */

export interface CompactorDeps {
  events: EventLog;
  clock: Clock;
  ids: Ids;
  summarize?: Summarizer;
  summarizerName?: string;
  policy?: CompactionPolicy;
}

const TURN_TYPES = ['message.user', 'message.agent'] as const;

export class Compactor {
  private readonly policy: CompactionPolicy;
  private readonly summarize: Summarizer;
  private readonly summarizerName: string;

  constructor(private readonly deps: CompactorDeps) {
    this.policy = deps.policy ?? DEFAULT_COMPACTION;
    this.summarize = deps.summarize ?? extractiveSummarizer;
    this.summarizerName = deps.summarizerName ?? 'extractive-1';
  }

  /** Summaries already recorded for this session, oldest first. */
  chunks(sessionId: string): CompactedChunk[] {
    return this.deps.events
      .read({ sessionId, types: ['history.compacted'] })
      .map((event): CompactedChunk => {
        const payload = event.payload as { chunkId: string; summary: CompactionSummary };
        return { id: payload.chunkId, summary: payload.summary };
      });
  }

  /**
   * The log sequence number everything up to which is already summarized.
   * The snapshotter renders turns above this verbatim and everything below
   * it as the summary that replaced it — one number, no second index to
   * keep in step with the log.
   */
  compactedThroughSeq(sessionId: string): number {
    return this.compactedThrough(sessionId);
  }

  /**
   * Compact the oldest uncompacted chunk, if there is enough history to be
   * worth it. Returns the summary, or `null` when nothing was done.
   *
   * **Idempotent** (§22.7's rule, applied here too): calling it twice in a
   * row does nothing the second time, because the second call sees the first
   * call's summary in the log and starts after it. Tested.
   */
  compact(sessionId: string, force = false): CompactedChunk | null {
    const turns = this.turnsFor(sessionId);
    const alreadyCompacted = this.compactedThrough(sessionId);
    const pending = turns.filter((turn) => turn.seq > alreadyCompacted);

    const available = pending.length - this.policy.keepVerbatim;
    if (!force && pending.length < this.policy.compactAfterTurns) return null;
    if (available < 2) return null;

    const take = Math.min(force ? available : this.policy.chunkTurns, available);
    const chunk = pending.slice(0, take);
    if (chunk.length < 2) return null;

    const summary = this.summarize(chunk);
    const chunkId = this.deps.ids.ulid();
    const tokensBefore = chunk.reduce((sum, turn) => sum + estimateTokens(turn.text), 0);
    const tokensAfter = estimateTokens(JSON.stringify(summary));

    this.deps.events.append({
      type: 'history.compacted',
      payload: {
        chunkId,
        fromEventId: summary.span.fromEventId,
        toEventId: summary.span.toEventId,
        turnCount: chunk.length,
        tokensBefore,
        tokensAfter,
        summarizer: this.summarizerName,
        summary,
      },
      principal: 'system',
      // Kernel-authored, like every other derived artifact. A summary of
      // FOREIGN content does not inherit FOREIGN: the *quoted* text inside
      // it is still fenced where it is rendered, and tagging our own
      // bookkeeping as untrusted would fence the agent's own notes.
      trust: 'SYSTEM',
      sessionId,
    });

    return { id: chunkId, summary };
  }

  /** The highest log sequence number already folded into a summary. */
  private compactedThrough(sessionId: string): number {
    const summaries = this.deps.events.read({ sessionId, types: ['history.compacted'] });
    const last = summaries.at(-1);
    if (last === undefined) return 0;
    const payload = last.payload as { toEventId: string };
    const turns = this.turnsFor(sessionId);
    return turns.find((turn) => turn.eventId === payload.toEventId)?.seq ?? 0;
  }

  private turnsFor(sessionId: string): Array<SourceTurn & { seq: number }> {
    return this.deps.events
      .read({ sessionId, types: [...TURN_TYPES] })
      .map((event: Event) => ({
        eventId: event.id,
        seq: event.seq,
        role: event.type === 'message.user' ? ('user' as const) : ('assistant' as const),
        text: (event.payload as { text: string }).text,
        at: event.ts,
      }));
  }

  /**
   * The verbatim turns a summary stands in for (§23's "re-expandable").
   *
   * Reads the log by id range rather than storing the text twice: the
   * originals are already durable, and a second copy is a second thing that
   * can drift.
   */
  expand(sessionId: string, fromEventId: string, toEventId: string): SourceTurn[] {
    const turns = this.turnsFor(sessionId);
    const start = turns.findIndex((turn) => turn.eventId === fromEventId);
    const end = turns.findIndex((turn) => turn.eventId === toEventId);
    if (start === -1 || end === -1 || end < start) return [];
    return turns.slice(start, end + 1).map(({ eventId, role, text, at }) => ({
      eventId,
      role,
      text,
      at,
    }));
  }
}

/** Input schema for the `history.expand` tool (§16: zod at every boundary). */
export const HistoryExpandInput = z.object({
  fromEventId: z.string().min(1),
  toEventId: z.string().min(1),
});
