/**
 * The snapshotter (L5): the impure half of context assembly.
 *
 * §21 says the assembler is pure and takes a snapshot "gathered beforehand".
 * This is beforehand. Everything that touches the log, the memory stores or
 * the tool registry happens here, and what crosses the seam is plain data a
 * golden test can check into a file.
 *
 * ## It also fixes something M4 left broken
 *
 * M4 computed the step's trust floor by scanning the session's events, and
 * separately rebuilt the conversation by scanning them again — twice per
 * step, every step, O(n) in session length. At 200 turns that is the whole
 * 100ms budget (§33) spent on reads whose answer barely changed.
 *
 * The fix is not a cache with an invalidation rule nobody will maintain. It
 * is that the snapshotter reads the session **once per turn** and derives
 * both from the same pass, then remembers the log sequence it read up to and
 * only reads *forward* from there. The log is append-only, so "what is new
 * since seq N" is always a correct incremental question — the one place
 * where an immutable log makes caching trivial instead of dangerous.
 */
import type { Event } from '../substrate/events/envelope.js';
import type { EventLog } from '../substrate/events/log.js';
import { minTrust, type TrustLevel } from '../substrate/events/types.js';
import type { ConstitutionView } from '../cognition/constitution/render.js';
import type { Clock } from '../substrate/ports.js';
import type { Compactor } from '../cognition/compaction.js';
import type {
  Constraint,
  ForeignItem,
  IdentityCard,
  MemoryItem,
  ProfileStats,
  StateSnapshot,
  ToolSummary,
  Turn,
} from '../cognition/context/types.js';

/**
 * Where the long-term stores plug in at M6.
 *
 * Declared now, empty-by-default, so the assembler is built against the real
 * shape rather than against three blocks and a promise. An implementation
 * that returns nothing is honest — the context then says "you do not know
 * this person yet", which is exactly true today.
 */
export interface MemorySource {
  recall(query: RecallQuery): readonly MemoryItem[];
  pinned(principal: string): readonly MemoryItem[];
  identity(principal: string): IdentityCard | null;
  constraints(principal: string): readonly Constraint[];
  commitments(principal: string): readonly import('../cognition/context/types.js').Commitment[];
  openQuestions(
    principal: string,
  ): readonly import('../cognition/context/types.js').CalibrationNote[];
  profile(principal: string): ProfileStats;
}

export interface RecallQuery {
  principal: string;
  sessionId: string;
  /** The live turn, as the retrieval query. */
  text: string;
  limit: number;
}

export interface ToolSource {
  /** Tools the registry knows, with their trust floors. */
  summaries(): readonly ToolSummary[];
}

export interface SnapshotterDeps {
  events: EventLog;
  clock: Clock;
  compactor?: Compactor;
  memory?: MemorySource;
  tools?: ToolSource;
  /** The user's constitution (§25). A function, because the user may edit it. */
  constitution?: () => string;
  /**
   * The structured constitution (§25, M7). A function for the same reason:
   * the document can be amended between two turns of one session, and a
   * value captured at construction would render yesterday's contract.
   */
  constitutionDoc?: () => ConstitutionView;
  kernel?: () => string;
  /** §29's persona, rendered (decision 036). A function: the user may edit
   * their agent's voice between two turns of one session. */
  persona?: (principal: string) => string[];
  timezone?: string;
  locale?: string;
  device?: string;
}

export interface GatherInput {
  principal: string;
  sessionId: string;
  /**
   * Replay only (M9): ignore anything the session learned *after* this
   * event seq. A run's own answer is in the log by the time anyone
   * replays it, and including it would make every historical run look
   * like its conversation block had grown.
   */
  asOfSeq?: number;
  trigger: string;
  triggerDetail?: string;
  degradation: 'L0' | 'L1' | 'L2' | 'L3';
  /** Tool results from the previous step, not yet in the log as turns. */
  observations: readonly ForeignItem[];
  /** The run's own events are part of the trust closure (decision 023). */
  runId: string;
  /** Floor used when nothing in the log says otherwise. */
  fallbackTrust: TrustLevel;
}

export interface Gathered {
  snapshot: StateSnapshot;
  /** Minimum trust over the whole causal closure (§12.2, decision 023). */
  effectiveTrust: TrustLevel;
}

interface SessionCache {
  /** Log sequence we have consumed up to. */
  seq: number;
  turns: Turn[];
  /** Running minimum over every message in the session. */
  trustFloor: TrustLevel;
}

export class Snapshotter {
  private readonly sessions = new Map<string, SessionCache>();

  constructor(private readonly deps: SnapshotterDeps) {}

  gather(input: GatherInput): Gathered {
    const cache = this.advance(input.sessionId);
    const runFloor = this.runTrust(input.runId);
    const observationFloor = input.observations.reduce<TrustLevel>(
      (floor, observation) => minTrust(floor, observation.trust),
      'SYSTEM',
    );
    const effectiveTrust = minTrust(
      input.fallbackTrust,
      cache.trustFloor,
      runFloor,
      observationFloor,
    );

    const memory = this.deps.memory;
    const compacted = this.deps.compactor?.chunks(input.sessionId) ?? [];
    const compactedThrough = this.deps.compactor?.compactedThroughSeq(input.sessionId) ?? 0;

    // Turns already folded into a summary are not repeated verbatim — that
    // would make compaction cost tokens instead of saving them.
    const seqOf = (turn: Turn): number | undefined => (turn as Turn & { seq?: number }).seq;
    const conversation = cache.turns.filter((turn) => {
      const seq = seqOf(turn);
      if (seq === undefined) return true;
      if (seq <= compactedThrough) return false;
      // Replay's "as of": see GatherInput.asOfSeq.
      return input.asOfSeq === undefined || seq < input.asOfSeq;
    });

    const lastUserTurn = [...conversation].reverse().find((turn) => turn.role === 'user');
    const now = this.deps.clock.now();

    const snapshot: StateSnapshot = {
      kernel: this.deps.kernel?.() ?? '',
      persona: this.deps.persona?.(input.principal) ?? [],
      constitution: this.deps.constitution?.() ?? '',
      constitutionDoc: this.deps.constitutionDoc?.() ?? null,
      identity: memory?.identity(input.principal) ?? null,
      constraints: memory?.constraints(input.principal) ?? [],
      situation: {
        now,
        timezone: this.deps.timezone ?? 'UTC',
        locale: this.deps.locale ?? 'en',
        device: this.deps.device ?? 'unknown',
        trigger: input.trigger,
        ...(input.triggerDetail === undefined ? {} : { triggerDetail: input.triggerDetail }),
        degradation: input.degradation,
      },
      commitments: memory?.commitments(input.principal) ?? [],
      calibration: memory?.openQuestions(input.principal) ?? [],
      pinned: memory?.pinned(input.principal) ?? [],
      memories:
        memory === undefined || input.degradation === 'L2'
          ? // L2 is "memory retrieval is unavailable". Returning stale
            // memories here instead of none would make the degradation note
            // a lie, and the model would act on recalled facts while being
            // told it has none.
            []
          : memory.recall({
              principal: input.principal,
              sessionId: input.sessionId,
              text: lastUserTurn?.content ?? '',
              limit: 20,
            }),
      working: [],
      conversation: conversation.map(stripSeq),
      compacted,
      tools: this.deps.tools?.summaries() ?? [],
      foreign: [...input.observations],
      profile: memory?.profile(input.principal) ?? {
        factCount: 0,
        meanConfidence: 0,
        sessionsObserved: 0,
      },
    };

    return { snapshot, effectiveTrust };
  }

  /** Drop a session's cache — used after compaction rewrites what is verbatim. */
  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Read forward from the last sequence we saw.
   *
   * Correctness rests entirely on the log being append-only (invariant 1):
   * nothing below `seq` can ever change, so re-reading it could only produce
   * the same answer. If events were mutable this would be a cache bug
   * waiting to happen; because they are not, it is just arithmetic.
   */
  private advance(sessionId: string): SessionCache {
    const cached = this.sessions.get(sessionId) ?? {
      seq: 0,
      turns: [],
      trustFloor: 'SYSTEM' as TrustLevel,
    };

    const fresh = this.deps.events.read({
      sessionId,
      fromSeq: cached.seq + 1,
      // `message.system` carries no turn but does carry trust, and M4's
      // closure counted it. Dropping it here would quietly raise the floor.
      types: ['message.user', 'message.agent', 'message.system'],
    });

    for (const event of fresh) {
      cached.seq = Math.max(cached.seq, event.seq);
      cached.trustFloor = minTrust(cached.trustFloor, event.trust);
      if (event.type === 'message.system') continue;
      const payload = event.payload as { text: string };
      const turn: Turn & { seq: number } = {
        role: event.type === 'message.user' ? 'user' : 'assistant',
        content: payload.text,
        trust: event.trust,
        id: event.id,
        seq: event.seq,
      };
      cached.turns.push(turn);
    }

    // Even with no new messages, later events may have moved the floor.
    this.sessions.set(sessionId, cached);
    return cached;
  }

  /**
   * The run's own trust floor. Read fresh every step and never cached:
   * this is the number the capability gate hangs off, and a stale value here
   * is a privilege escalation rather than a slow page (decision 023).
   */
  private runTrust(runId: string): TrustLevel {
    const events = this.deps.events.read({ runId });
    return events.reduce<TrustLevel>(
      (floor: TrustLevel, event: Event) => minTrust(floor, event.trust),
      'SYSTEM',
    );
  }
}

function stripSeq(turn: Turn & { seq?: number }): Turn {
  return { role: turn.role, content: turn.content, trust: turn.trust, id: turn.id };
}
