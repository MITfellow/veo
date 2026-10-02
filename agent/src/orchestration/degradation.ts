/**
 * §27's degradation ladder.
 *
 * | L0 Full | — | everything available |
 * | L1 No embeddings | embedder down | lexical + recency retrieval only |
 * | L2 Primary model down | provider failure | fallback model, reduced budget |
 * | L3 Read-only | disk full / DB locked | answer from memory, refuse writes |
 * | L4 Locked | vault locked / auth failure | unlock endpoint only |
 *
 * The design decision worth stating is that **the level is computed from
 * signals, never assigned**. `report('embedder', …)` and
 * `clear('embedder')`; the current level is the maximum of what is
 * currently wrong. A settable level means the last caller wins, so clearing
 * an embedder failure would cheerfully announce L0 while the vault was
 * still locked — and §27 is explicit that silent degradation "destroys
 * trust faster than being honestly broken".
 *
 * Only *transitions* emit `degradation.changed`. An embedder that fails
 * once a second must not be able to fill the log with the news.
 */
import type { EventLog } from '../substrate/events/log.js';
import type { Clock } from '../substrate/ports.js';

export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/** A named thing that is wrong, and the level it forces. */
export type Signal = 'embedder' | 'model' | 'storage' | 'vault';

const SIGNAL_LEVEL: Record<Signal, Exclude<Level, 'L0'>> = {
  embedder: 'L1',
  model: 'L2',
  storage: 'L3',
  vault: 'L4',
};

const ORDER: Level[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export const LEVEL_MEANING: Record<Level, string> = {
  L0: 'Everything is available.',
  L1: 'The embedder is unavailable: recall is lexical and recency-based, so it may miss paraphrases.',
  L2: 'The main model is unavailable: answers come from a fallback with a smaller context budget.',
  L3: 'Storage is read-only: questions can be answered from memory, but nothing new is saved and no actions run.',
  L4: 'The vault is locked: only unlocking is available.',
};

export interface DegradationState {
  level: Level;
  meaning: string;
  signals: Array<{ signal: Signal; level: Level; detail: string; since: number }>;
}

export interface DegradationDeps {
  events: EventLog;
  clock: Clock;
  principal?: string;
}

export class Degradation {
  private readonly active = new Map<Signal, { detail: string; since: number }>();
  private level: Level = 'L0';

  constructor(private readonly deps: DegradationDeps) {}

  /** Record that something is wrong. Idempotent per signal. */
  report(signal: Signal, detail: string): Level {
    const existing = this.active.get(signal);
    if (existing !== undefined && existing.detail === detail) return this.level;
    this.active.set(signal, { detail, since: existing?.since ?? this.deps.clock.now() });
    return this.settle(signal, detail);
  }

  /** Record that it is fixed. The level falls to the next-worst signal. */
  clear(signal: Signal): Level {
    if (!this.active.has(signal)) return this.level;
    this.active.delete(signal);
    return this.settle(signal, 'recovered');
  }

  current(): Level {
    return this.level;
  }

  state(): DegradationState {
    return {
      level: this.level,
      meaning: LEVEL_MEANING[this.level],
      signals: [...this.active.entries()]
        .map(([signal, info]) => ({
          signal,
          level: SIGNAL_LEVEL[signal] as Level,
          detail: info.detail,
          since: info.since,
        }))
        .sort((a, b) => ORDER.indexOf(b.level) - ORDER.indexOf(a.level)),
    };
  }

  /**
   * Run something and report the signal if it throws.
   *
   * Kept here rather than at each call site so that "the embedder failed"
   * can never be handled by a `catch {}` that forgets to tell anyone.
   */
  async guard<T>(signal: Signal, detail: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn();
      this.clear(signal);
      return result;
    } catch (error) {
      this.report(signal, `${detail}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private settle(signal: Signal, detail: string): Level {
    const worst = [...this.active.keys()].reduce<Level>(
      (acc, s) => (ORDER.indexOf(SIGNAL_LEVEL[s]) > ORDER.indexOf(acc) ? SIGNAL_LEVEL[s] : acc),
      'L0',
    );
    if (worst === this.level) return this.level;

    const from = this.level;
    this.level = worst;
    this.deps.events.append({
      type: 'degradation.changed',
      principal: this.deps.principal ?? 'system',
      trust: 'SYSTEM',
      payload: {
        from,
        to: worst,
        signal,
        detail,
        active: [...this.active.keys()],
      },
    });
    return worst;
  }
}
