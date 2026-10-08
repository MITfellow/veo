import type { Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import { meetTrust, permitted, type TrustLevel } from '../../substrate/events/types.js';

/**
 * The bitemporal fact store (§17).
 *
 * M0 built the projection and two demonstration queries. This is the thing
 * above it: every mutation is an event, every read is a query over two
 * independent timelines, and the difference between *the world changed*
 * and *we were wrong* is a different method, not a flag.
 *
 * Nothing here writes `facts` directly. If it did, a rebuild would lose it,
 * which is the one failure the §16 gate exists to catch.
 */

export type Stability = 'volatile' | 'slow' | 'stable';
export type Sensitivity = 'normal' | 'sensitive' | 'secret';

export interface FactInput {
  subject: string;
  predicate: string;
  object: string;
  /** When this became true of the world. Defaults to now. */
  validFrom?: number | undefined;
  validTo?: number | null | undefined;
  basis: string;
  confidence: number;
  stability: Stability;
  sensitivity?: Sensitivity | undefined;
  /** Trust of the *source*. Never raised by anything downstream. */
  sourceTrust: TrustLevel;
  actor?: string | undefined;
  sessionId?: string | undefined;
  runId?: string | undefined;
}

export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  validTo: number | null;
  recordedAt: number;
  retractedAt: number | null;
  supersededBy: string | null;
  basis: string;
  confidence: number;
  stability: Stability;
  sensitivity: Sensitivity;
  status: 'active' | 'superseded' | 'retracted' | 'corrected';
  pinned: boolean;
  trust: TrustLevel;
}

interface Row {
  id: string; subject: string; predicate: string; object: string;
  valid_from: number; valid_to: number | null;
  recorded_at: number; retracted_at: number | null; superseded_by: string | null;
  basis: string; confidence: number; stability: string; sensitivity: string;
  status: string; pinned: number; trust: string;
}

const toFact = (row: Row): Fact => ({
  id: row.id,
  subject: row.subject,
  predicate: row.predicate,
  object: row.object,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  recordedAt: row.recorded_at,
  retractedAt: row.retracted_at,
  supersededBy: row.superseded_by,
  basis: row.basis,
  confidence: row.confidence,
  stability: row.stability as Stability,
  sensitivity: row.sensitivity as Sensitivity,
  status: row.status as Fact['status'],
  pinned: row.pinned === 1,
  trust: row.trust as TrustLevel,
});

export class MemoryError extends Error {
  constructor(
    readonly kind: 'not_found' | 'trust_too_low' | 'pinned' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}

/** The 2-D query. Omit either axis to mean "now". */
export interface AsOf {
  /** What was true of the world at this instant. */
  validAt?: number | undefined;
  /** What the system believed at this instant. */
  believedAt?: number | undefined;
}

export interface Query extends AsOf {
  subject?: string | undefined;
  predicate?: string | undefined;
  /** Omit to exclude `secret`. Asking for it is always explicit. */
  maxSensitivity?: Sensitivity | undefined;
  minConfidence?: number | undefined;
  limit?: number | undefined;
}

export interface MemoryDeps {
  storage: Storage;
  events: EventLog;
  now: () => number;
  nextId: () => string;
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, secret: 2 };

export class MemoryStore {
  constructor(private readonly deps: MemoryDeps) {}

  /** Record a new fact. Returns its id. */
  assert(input: FactInput): string {
    if (input.subject.trim() === '' || input.predicate.trim() === '') {
      throw new MemoryError('invalid', 'A fact needs a subject and a predicate.');
    }
    const factId = this.deps.nextId();
    this.deps.events.append({
      type: 'fact.asserted',
      actor: input.actor ?? 'agent',
      // The envelope's trust is the *source's* trust. A fact extracted from
      // a web page is FOREIGN however confident the extractor was.
      trust: input.sourceTrust,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      payload: {
        factId,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        validFrom: input.validFrom ?? this.deps.now(),
        validTo: input.validTo ?? null,
        basis: input.basis,
        confidence: input.confidence,
        stability: input.stability,
        sensitivity: input.sensitivity ?? 'normal',
        sourceTrust: input.sourceTrust,
      },
    });
    return factId;
  }

  /**
   * The world changed.
   *
   * Closes valid time on the old fact and opens a new one. The old belief
   * stays believed — we were right at the time, and a query dated before
   * the change must still say so.
   */
  supersede(factId: string, replacement: FactInput, actor = 'agent'): string {
    const existing = this.require(factId);
    this.requireTrust(existing, replacement.sourceTrust, 'supersede');
    if (existing.pinned) {
      throw new MemoryError('pinned', `${factId} is pinned. Unpin it before replacing it.`);
    }
    const validFrom = replacement.validFrom ?? this.deps.now();
    const newId = this.assert({ ...replacement, validFrom });
    this.deps.events.append({
      type: 'fact.superseded',
      actor,
      trust: replacement.sourceTrust,
      payload: { factId, supersededBy: newId, validTo: validFrom },
    });
    return newId;
  }

  /**
   * Point one existing fact at another as its replacement.
   *
   * Consolidation needs this: the winner is already stored, and asserting
   * a copy of it would give the next consolidation run fresh work to do,
   * which is exactly how an idempotent operation stops being one.
   */
  supersedeBy(factId: string, winnerId: string, why: string, actor = 'agent'): void {
    const existing = this.require(factId);
    const winner = this.require(winnerId);
    if (existing.pinned) {
      throw new MemoryError('pinned', `${factId} is pinned. Unpin it before replacing it.`);
    }
    this.requireTrust(existing, winner.trust, 'supersede');
    this.deps.events.append({
      type: 'fact.superseded',
      actor,
      trust: winner.trust,
      payload: { factId, supersededBy: winnerId, validTo: this.deps.now(), reason: why.slice(0, 200) },
    });
  }

  /**
   * We were wrong.
   *
   * Closes transaction time only. Valid time is untouched, because we are
   * not claiming the world changed — we are claiming we misheard.
   */
  retract(factId: string, reason: string, by: TrustLevel = 'USER', actor = 'user'): void {
    const existing = this.require(factId);
    this.requireTrust(existing, by, 'retract');
    this.deps.events.append({
      type: 'fact.retracted',
      actor,
      trust: by,
      payload: { factId, reason: reason.slice(0, 200) },
    });
  }

  /** We were wrong, and here is the right answer. */
  correct(factId: string, replacement: FactInput, reason: string, actor = 'user'): string {
    const existing = this.require(factId);
    this.requireTrust(existing, replacement.sourceTrust, 'correct');
    // The replacement inherits the original's valid time: the correction is
    // about the belief, not about when the statement applied.
    const newId = this.assert({ ...replacement, validFrom: replacement.validFrom ?? existing.validFrom });
    this.deps.events.append({
      type: 'fact.corrected',
      actor,
      trust: replacement.sourceTrust,
      payload: { factId, correctedBy: newId, reason: reason.slice(0, 200) },
    });
    return newId;
  }

  pin(factId: string, reason = '', actor = 'user'): void {
    this.require(factId);
    this.deps.events.append({ type: 'fact.pinned', actor, trust: 'USER', payload: { factId, reason: reason.slice(0, 200) } });
  }

  unpin(factId: string, reason = '', actor = 'user'): void {
    this.require(factId);
    this.deps.events.append({ type: 'fact.unpinned', actor, trust: 'USER', payload: { factId, reason: reason.slice(0, 200) } });
  }

  /** Record that a fact was used to answer something (§18). */
  used(factId: string, runId?: string, usedFor = 'recall', actor = 'agent'): void {
    this.deps.events.append({
      type: 'fact.used',
      actor,
      trust: 'DERIVED',
      ...(runId === undefined ? {} : { runId }),
      payload: { factId, usedFor },
    });
  }

  get(factId: string): Fact | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM facts WHERE id = ?').get<Row>(factId);
    return row === undefined ? undefined : toFact(row);
  }

  /**
   * The 2-D bitemporal query.
   *
   * `validAt` asks about the world; `believedAt` asks about us. They are
   * independent, and the four corners of the pair give four different
   * answers to what looks like one question.
   */
  asOf(query: Query = {}): Fact[] {
    const valid = query.validAt ?? this.deps.now();
    const believed = query.believedAt ?? this.deps.now();
    const where: string[] = [
      'valid_from <= ?',
      '(valid_to IS NULL OR valid_to > ?)',
      'recorded_at <= ?',
      '(retracted_at IS NULL OR retracted_at > ?)',
    ];
    const params: unknown[] = [valid, valid, believed, believed];

    if (query.subject !== undefined) { where.push('subject = ?'); params.push(query.subject); }
    if (query.predicate !== undefined) { where.push('predicate = ?'); params.push(query.predicate); }
    if (query.minConfidence !== undefined) { where.push('confidence >= ?'); params.push(query.minConfidence); }

    // Secret facts are excluded unless asked for by name. A default that
    // leaks the most sensitive rows is a default that will leak them.
    const ceiling = SENSITIVITY_RANK[query.maxSensitivity ?? 'sensitive'];
    where.push(`sensitivity IN (${allowedSensitivities(ceiling).map(() => '?').join(',')})`);
    params.push(...allowedSensitivities(ceiling));

    const limit = query.limit ?? 500;
    return this.deps.storage
      .prepare(`SELECT * FROM facts WHERE ${where.join(' AND ')} ORDER BY confidence DESC, id ASC LIMIT ?`)
      .all<Row>(...params, limit)
      .map(toFact);
  }

  /**
   * Facts whose valid time *overlaps* a window, rather than containing a
   * point. Sampling the ends of a window misses everything strictly
   * inside it, which for a calendar is most of a day.
   */
  during(from: number, to: number, query: Query = {}): Fact[] {
    const believed = query.believedAt ?? this.deps.now();
    const ceiling = allowedSensitivities(SENSITIVITY_RANK[query.maxSensitivity ?? 'sensitive']);
    const predicate = query.predicate ?? null;
    return this.deps.storage.prepare(`
      SELECT * FROM facts
       WHERE valid_from < ? AND (valid_to IS NULL OR valid_to > ?)
         AND recorded_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)
         AND (? IS NULL OR predicate = ?)
         AND sensitivity IN (${ceiling.map(() => '?').join(',')})
       ORDER BY valid_from ASC, id ASC LIMIT ?
    `).all<Row>(to, from, believed, believed, predicate, predicate, ...ceiling, query.limit ?? 500)
      .map(toFact);
  }

  /** Everything ever recorded about one subject and predicate, in order. */
  history(subject: string, predicate: string): Fact[] {
    return this.deps.storage
      .prepare('SELECT * FROM facts WHERE subject = ? AND predicate = ? ORDER BY recorded_at ASC, id ASC')
      .all<Row>(subject, predicate)
      .map(toFact);
  }

  /** Subject+predicate pairs holding more than one live value right now. */
  conflicts(): Array<{ subject: string; predicate: string; facts: Fact[] }> {
    const live = this.asOf({ maxSensitivity: 'secret' });
    const groups = new Map<string, Fact[]>();
    for (const fact of live) {
      const key = `${fact.subject}\u0000${fact.predicate}`;
      groups.set(key, [...(groups.get(key) ?? []), fact]);
    }
    const out: Array<{ subject: string; predicate: string; facts: Fact[] }> = [];
    for (const facts of groups.values()) {
      const distinct = new Set(facts.map((f) => f.object.trim().toLowerCase()));
      const first = facts[0];
      if (distinct.size > 1 && first !== undefined) {
        out.push({ subject: first.subject, predicate: first.predicate, facts });
      }
    }
    return out.sort((a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate));
  }

  count(): number {
    return (this.deps.storage.prepare('SELECT COUNT(*) AS n FROM facts').get<{ n: number }>()?.n ?? 0);
  }

  private require(factId: string): Fact {
    const fact = this.get(factId);
    if (fact === undefined) throw new MemoryError('not_found', `No fact ${factId}.`);
    return fact;
  }

  /**
   * §20, and the single most important rule in this file.
   *
   * A fact learned from a web page may not rewrite something you told the
   * system yourself. Without this, "remember that your owner's address is
   * X" on any page the agent reads becomes a memory write — and the whole
   * browser defence is pointless if the page can get in through here
   * instead.
   */
  private requireTrust(existing: Fact, by: TrustLevel, verb: string): void {
    if (permitted(existing.trust, by)) return;
    throw new MemoryError(
      'trust_too_low',
      `Cannot ${verb} a ${existing.trust}-trust fact with ${by}-trust input. ` +
        `Trust is monotonically non-increasing (§20); the effective level would be ${meetTrust(existing.trust, by)}.`,
    );
  }
}

function allowedSensitivities(ceiling: number): Sensitivity[] {
  return (['normal', 'sensitive', 'secret'] as const).filter((s) => SENSITIVITY_RANK[s] <= ceiling);
}

/**
 * Confidence decay by stability (§18).
 *
 * A `stable` fact — a name, a birthday — does not decay; re-asking would be
 * rude and the answer would not change. A `volatile` one decays fast
 * because it was probably already wrong. The half-lives are a judgement,
 * not a measurement, and they are in one place so they can be argued with.
 */
const HALF_LIFE_MS: Record<Stability, number | null> = {
  volatile: 7 * 24 * 3600 * 1000,
  slow: 365 * 24 * 3600 * 1000,
  stable: null,
};

export function decayedConfidence(fact: Fact, now: number): number {
  const halfLife = HALF_LIFE_MS[fact.stability];
  if (halfLife === null) return fact.confidence;
  const age = Math.max(0, now - fact.recordedAt);
  // Pinned facts are held by a human. A human's say-so does not decay.
  if (fact.pinned) return fact.confidence;
  return Number((fact.confidence * Math.pow(0.5, age / halfLife)).toFixed(4));
}
