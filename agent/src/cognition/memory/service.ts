/**
 * `MemoryService` — the one object the composition root has to know about.
 *
 * Everything under `src/cognition/memory/` is a part: a store, a gate, an
 * extractor, a reader, a writer, an entity resolver, a consolidator. Wiring
 * seven of those by hand in `main.ts` would put memory's internal structure
 * into the composition root, where every future change to memory becomes a
 * change to the root. This assembles them once, exposes the three things the
 * rest of the system actually needs — a context source, a tool dependency
 * bundle, a run observer — and keeps the rest private.
 */
import type { EventLog } from '../../substrate/events/log.js';
import type { Clock, Embedder, Ids, Logger, Storage } from '../../substrate/ports.js';
import type { RunObserver, RunOutcome, RunRequest } from '../../orchestration/runner.js';
import { Consolidator } from './consolidate.js';
import { EntityResolver } from './entities.js';
import { PatternExtractor, type Extractor } from './extract.js';
import { MemoryReader } from './read.js';
import { StoredMemorySource } from './source.js';
import { MemoryStore } from './store.js';
import { MemoryWriter } from './write.js';
import type { MemoryToolDeps } from '../../tools/memory.js';

export interface MemoryServiceDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
  principal: string;
  /** Absent means lexical-only recall and no stored vectors. */
  embedder?: Embedder;
  /** Absent means the deterministic pattern extractor only. */
  extractor?: Extractor;
  logger?: Logger;
}

/**
 * Consolidate after this many unconsolidated episodes.
 *
 * §22.7 says "nightly, and after every N episodes". There is no scheduler
 * until M8, so the episode trigger is the only one wired, and it is wired
 * *after* the run rather than before: consolidation is housekeeping and the
 * user should never wait for it.
 */
export const CONSOLIDATE_EVERY = 12;

export class MemoryService implements RunObserver {
  readonly store: MemoryStore;
  readonly reader: MemoryReader;
  readonly writer: MemoryWriter;
  readonly entities: EntityResolver;
  readonly consolidator: Consolidator;
  readonly source: StoredMemorySource;

  constructor(private readonly deps: MemoryServiceDeps) {
    this.store = new MemoryStore({
      storage: deps.storage,
      events: deps.events,
      clock: deps.clock,
      ids: deps.ids,
    });
    this.entities = new EntityResolver({
      storage: deps.storage,
      events: deps.events,
      clock: deps.clock,
      ids: deps.ids,
      principal: deps.principal,
    });
    this.reader = new MemoryReader({
      store: this.store,
      ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
    });
    this.writer = new MemoryWriter({
      store: this.store,
      events: deps.events,
      clock: deps.clock,
      extractor: deps.extractor ?? new PatternExtractor(),
      entities: this.entities,
      ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
    this.consolidator = new Consolidator({
      store: this.store,
      events: deps.events,
      clock: deps.clock,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
    this.source = new StoredMemorySource({
      store: this.store,
      reader: this.reader,
      clock: deps.clock,
    });
  }

  /** Dependency bundle for the `memory.*` tools (§22.8). */
  toolDeps(): MemoryToolDeps {
    return { store: this.store, reader: this.reader, principal: this.deps.principal };
  }

  /**
   * Warm the synchronous recall cache before a run assembles its context.
   *
   * Called from the HTTP layer with the user's text, which is the only
   * place that has it before the loop starts.
   */
  async prime(principal: string, sessionId: string, text: string, limit = 8): Promise<void> {
    try {
      await this.source.prime({ principal, sessionId, text, limit });
    } catch (error) {
      this.deps.logger?.warn('memory prime failed; falling back to lexical recall', {
        error: String(error),
      });
    }
  }

  /** Learn from a completed run (§22.5, §22.7). */
  async afterRun(outcome: RunOutcome, request: RunRequest): Promise<void> {
    const now = this.deps.clock.now();
    const userText = this.lastUserText(request.sessionId);

    const episode = this.store.recordEpisode({
      runId: outcome.runId,
      sessionId: request.sessionId,
      principal: request.principal,
      request: userText ?? '',
      response: outcome.text,
      actions: this.toolsUsed(outcome.runId),
      entities: [],
      // The episode's own verdict on itself. `corrected` arrives later, from
      // the next turn, if the user pushes back — it is not knowable here.
      outcome:
        outcome.status === 'finished'
          ? 'satisfied'
          : outcome.status === 'cancelled'
            ? 'abandoned'
            : 'unknown',
      outcomeReason: outcome.reason,
      trust: 'USER',
      startedAt: now,
      endedAt: now,
      costMicros: outcome.costMicros,
    });

    if (userText !== null && userText !== '') {
      await this.writer.observe({
        principal: request.principal,
        sessionId: request.sessionId,
        runId: outcome.runId,
        episodeId: episode.id,
        text: userText,
        eventId: outcome.runId,
        trust: 'USER',
      });
    }

    if (this.store.unconsolidatedEpisodes(request.principal).length >= CONSOLIDATE_EVERY) {
      this.consolidator.run(request.principal);
    }
  }

  /** The user's own words from this session — never the agent's. */
  private lastUserText(sessionId: string): string | null {
    const row = this.deps.storage.get<{ text: string }>(
      `SELECT text FROM messages
        WHERE session_id = ? AND role = 'user'
        ORDER BY seq DESC
        LIMIT 1`,
      [sessionId],
    );
    return row?.text ?? null;
  }

  private toolsUsed(runId: string): string[] {
    const rows = this.deps.storage.all<{ type: string; payload: string }>(
      `SELECT type, payload FROM events
        WHERE run_id = ? AND type = 'tool.succeeded'
        ORDER BY seq ASC`,
      [runId],
    );
    const names: string[] = [];
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (typeof parsed === 'object' && parsed !== null && 'tool' in parsed) {
          const name = (parsed as { tool: unknown }).tool;
          if (typeof name === 'string') names.push(name);
        }
      } catch {
        // A malformed payload is a log problem, not a memory problem.
      }
    }
    return names;
  }
}
