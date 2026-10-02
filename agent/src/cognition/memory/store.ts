/**
 * `MemoryStore` — the storage mechanics for §22's four stores.
 *
 * This file knows about rows and never about meaning. Deciding *whether* to
 * remember something is `gate.ts`; deciding *what* a change means is
 * `write.ts`; ranking is `read.ts`. Keeping those apart is what makes the
 * interesting rules testable without a database fixture the size of a
 * person's life.
 *
 * Two mechanics carry the weight:
 *
 * **Writes go through the event log, never straight to SQL.** Every mutating
 * method appends an event and lets the `facts` projector do the write. A
 * direct `UPDATE` here would be a second source of truth (invariant 1) and
 * would vanish the next time projections are rebuilt.
 *
 * **Nothing is ever edited in place.** A changed value supersedes; a wrong
 * value is corrected; a forgotten value is shredded. All three keep history.
 * §22.5: "both are kept. The trajectory is the asset."
 */
import { canonicalJson } from '../../substrate/hash.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { SourceRef, TrustLevel } from '../../substrate/events/types.js';
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import {
  AffectSchema,
  EpisodeSchema,
  FactSchema,
  RuleSchema,
  type Affect,
  type Episode,
  type Fact,
  type Rule,
} from './types.js';

/**
 * How many facts about one subject a caller gets unless it asks for
 * more. Large enough that no real person's subject is truncated, small
 * enough that a pathological one cannot stall a turn.
 */
export const DEFAULT_SUBJECT_LIMIT = 2_000;

export interface MemoryStoreDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
}

export interface FactWriteInput {
  principal: string;
  subject: { id: string; kind: Fact['subject']['kind']; label: string };
  predicate: string;
  object: unknown;
  basis: Fact['basis'];
  confidence: number;
  sources: SourceRef[];
  trust: TrustLevel;
  stability?: Fact['stability'];
  sensitivity?: Fact['sensitivity'];
  status?: Fact['status'];
  validFrom?: number;
  sessionId?: string | null;
  runId?: string | null;
}

interface FactRow {
  id: string;
  fact_id: string;
  subject: string;
  predicate: string;
  object: string;
  basis: string;
  confidence: number;
  sources: string;
  observation_count: number;
  valid_from: number;
  valid_to: number | null;
  recorded_at: number;
  superseded_at: number | null;
  superseded_by: string | null;
  stability: string;
  sensitivity: string;
  status: string;
  pinned: number;
  trust: string;
  key_id: string | null;
  last_used_at: number | null;
}

const FACT_COLUMNS = `id, fact_id, subject, predicate, object, basis, confidence, sources,
  observation_count, valid_from, valid_to, recorded_at, superseded_at, superseded_by,
  stability, sensitivity, status, pinned, trust, key_id, last_used_at`;

export class MemoryStore {
  constructor(private readonly deps: MemoryStoreDeps) {}

  /* ───────────────────────────── semantic ────────────────────────────── */

  /** Writes a new belief. Returns the logical fact id. */
  write(input: FactWriteInput): string {
    const now = this.deps.clock.now();
    const factId = this.deps.ids.ulid();
    this.deps.events.append({
      type: 'memory.written',
      principal: input.principal,
      trust: input.trust,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      payload: {
        factId,
        // The subject is stored as JSON so the entity's label travels with
        // the fact: a recalled memory that says "entity 01J2…" helps nobody.
        subject: canonicalJson(input.subject),
        predicate: input.predicate,
        object: input.object as never,
        basis: input.basis,
        confidence: input.confidence,
        sources: input.sources,
        validFrom: input.validFrom ?? now,
        validTo: null,
        stability: input.stability ?? 'slow',
        sensitivity: input.sensitivity ?? 'normal',
        status: input.status ?? 'active',
      },
    });
    return factId;
  }

  /** Confirms an existing belief: one more observation, a little more confident. */
  confirm(factId: string, principal: string, trust: TrustLevel): void {
    const current = this.get(factId);
    if (current === undefined) return;
    this.deps.events.append({
      type: 'memory.updated',
      principal,
      trust,
      payload: {
        factId,
        observationCount: current.observationCount + 1,
        confidence: raiseConfidence(current.confidence, current.observationCount + 1),
      },
    });
  }

  /**
   * The world changed. The old belief stays true *of its period* — only valid
   * time closes. (The projector is emphatic about this and it is right:
   * "where did she work in March?" must still answer.)
   */
  supersede(args: {
    oldFactId: string;
    principal: string;
    trust: TrustLevel;
    validTo: number;
    next: Omit<FactWriteInput, 'principal' | 'trust'> & { principal?: string; trust?: TrustLevel };
  }): string {
    const newId = this.write({
      ...args.next,
      principal: args.next.principal ?? args.principal,
      trust: args.next.trust ?? args.trust,
      validFrom: args.validTo,
    });
    this.deps.events.append({
      type: 'memory.superseded',
      principal: args.principal,
      trust: args.trust,
      payload: { factId: args.oldFactId, supersededBy: newId, validTo: args.validTo },
    });
    return newId;
  }

  /** We were wrong — a retraction, not a change in the world. */
  correct(args: {
    factId: string;
    principal: string;
    trust: TrustLevel;
    was: unknown;
    now: unknown;
    by: string;
  }): void {
    this.deps.events.append({
      type: 'memory.corrected',
      principal: args.principal,
      trust: args.trust,
      payload: { factId: args.factId, was: args.was as never, now: args.now as never, by: args.by },
    });
  }

  dispute(factId: string, against: string, reason: string, principal: string, trust: TrustLevel): void {
    this.deps.events.append({
      type: 'memory.disputed',
      principal,
      trust,
      payload: { factId, against, reason },
    });
  }

  pin(factId: string, pinned: boolean, principal: string, trust: TrustLevel): void {
    this.deps.events.append({
      type: 'memory.updated',
      principal,
      trust,
      payload: { factId, pinned },
    });
  }

  /**
   * Forget, properly (§22.8, §13.3).
   *
   * Crypto-shred: the key is destroyed, the row survives as a tombstone, the
   * FTS entry and the embedding go. Deleting the row instead would make
   * forgetting indistinguishable from never-happened and would leave the
   * audit trail of deletions empty — which is the one trail a person who has
   * just asked you to forget something most wants to be able to read.
   */
  forget(factId: string, reason: string, principal: string, trust: TrustLevel): void {
    const keyId = this.deps.ids.ulid();
    this.deps.events.append({
      type: 'memory.forgotten',
      principal,
      trust,
      payload: { factId, keyId, reason, shredded: true },
    });
    this.deps.storage.run('DELETE FROM fact_embeddings WHERE fact_id = ?', [factId]);
  }

  /**
   * Everything known about a subject, most-believed first.
   *
   * **Bounded.** Found by M9's 100k/50k pass: with 25k facts about one
   * subject this took half a second, not because the lookup is slow
   * (migration 013 added the expression index the query needs) but
   * because deserialising 25k facts takes that long whatever you do. No
   * interactive path wants 25k facts, so the default is a limit; callers
   * that genuinely need the lot — export, the "forget everything about
   * X" path — pass their own.
   */
  bySubject(
    subjectId: string,
    options: { includeInactive?: boolean; limit?: number } = {},
  ): Fact[] {
    const statusFilter = options.includeInactive === true ? '' : " AND status = 'active'";
    const rows = this.deps.storage.all<FactRow>(
      // The expression matches migration 013's index exactly — change one
      // and the other stops being used, silently, which is the usual way
      // an index quietly stops earning its keep.
      `SELECT ${FACT_COLUMNS} FROM facts
       WHERE (CASE WHEN json_valid(subject) THEN json_extract(subject, '$.id') ELSE subject END) = ?
         AND superseded_at IS NULL${statusFilter}
       ORDER BY confidence DESC, recorded_at DESC
       LIMIT ?`,
      [subjectId, options.limit ?? DEFAULT_SUBJECT_LIMIT],
    );
    return rows.map(toFact);
  }

  get(factId: string): Fact | undefined {
    const row = this.deps.storage.get<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM facts WHERE fact_id = ? AND superseded_at IS NULL
       ORDER BY recorded_at DESC LIMIT 1`,
      [factId],
    );
    return row === undefined ? undefined : toFact(row);
  }

  /**
   * Any version of a belief, including one whose transaction time is closed.
   *
   * `get()` deliberately hides corrected beliefs from the agent — a
   * retracted fact must not come back as something it knows. But the
   * *inspector* has to show it: a correction the user can no longer open is
   * a correction they cannot verify happened, and §22.8 exists precisely so
   * someone can audit what the agent did with their words.
   */
  getAny(factId: string): Fact | undefined {
    const row = this.deps.storage.get<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM facts WHERE fact_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      [factId],
    );
    return row === undefined ? undefined : toFact(row);
  }

  /** Every version of one belief, oldest first — the "explain" view (§22.8). */
  history(factId: string): Fact[] {
    return this.deps.storage
      .all<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM facts WHERE fact_id = ? ORDER BY recorded_at ASC, id ASC`,
        [factId],
      )
      .map(toFact);
  }

  /**
   * Candidates for recall. Status filtering happens here, in SQL, rather
   * than in the scorer: `retired` and `quarantined` must be unreachable no
   * matter what the weights say (§22.6), and a filter that lives in the
   * ranking function is a filter one refactor away from being a tie-break.
   */
  recallable(principal: string, limit = 500): Fact[] {
    return this.deps.storage
      .all<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM facts
         WHERE principal = ? AND superseded_at IS NULL AND valid_to IS NULL
           AND status IN ('active','disputed')
         ORDER BY pinned DESC, confidence DESC, recorded_at DESC LIMIT ?`,
        [principal, limit],
      )
      .map(toFact);
  }

  /**
   * Everything, for the user's own eyes (§22.8).
   *
   * Distinct from `recallable()` on purpose: recall is what the agent gets
   * to use, this is what the person gets to see. The quarantined claim that
   * must never reach a prompt is exactly the thing someone most wants shown
   * — "here is what a web page tried to make me believe about you" — so
   * filtering it out of the inspector would defeat the point.
   */
  allFacts(principal: string, options: { includeInactive?: boolean } = {}): Fact[] {
    const statusFilter =
      options.includeInactive === true ? '' : " AND status IN ('active','disputed')";
    return this.deps.storage
      .all<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM facts
         WHERE principal = ?${statusFilter}
         ORDER BY pinned DESC, recorded_at DESC`,
        [principal],
      )
      .map(toFact);
  }

  /**
   * What the gate turned away (§22.5, decision 027).
   *
   * Surfaced to the user because over-rejection is otherwise undetectable:
   * a memory that was never written leaves no trace in the store, and "why
   * don't you know that?" has no answer without this list.
   */
  rejections(
    principal: string,
    limit = 50,
  ): Array<{ reason: string; predicate: string; subjectHint: string; ts: number }> {
    return this.deps.storage
      .all<{ payload: string; ts: number }>(
        `SELECT payload, ts FROM events
         WHERE type = 'memory.rejected' AND principal = ?
         ORDER BY seq DESC LIMIT ?`,
        [principal, limit],
      )
      .map((row) => {
        const payload = JSON.parse(row.payload) as {
          reason: string;
          predicate: string;
          subjectHint: string;
        };
        return { ...payload, ts: row.ts };
      });
  }

  pinned(principal: string): Fact[] {
    return this.deps.storage
      .all<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM facts
         WHERE principal = ? AND pinned = 1 AND superseded_at IS NULL AND valid_to IS NULL
           AND status = 'active'`,
        [principal],
      )
      .map(toFact);
  }

  /** Lexical half of hybrid recall (§22.6). FTS5 is already indexed by M1. */
  searchText(query: string, limit = 50): Array<{ factId: string; rank: number }> {
    const sanitized = query
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.slice(0, 16)
      .map((token) => `"${token}"`)
      .join(' OR ');
    if (sanitized === undefined || sanitized === '') return [];
    try {
      return this.deps.storage.all<{ factId: string; rank: number }>(
        `SELECT fact_id AS factId, bm25(facts_fts) AS rank FROM facts_fts
         WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?`,
        [sanitized, limit],
      );
    } catch {
      // A malformed FTS query is a bad search, not a broken agent.
      return [];
    }
  }

  /**
   * Record that these facts were put in front of the model.
   *
   * An **event**, not a direct write. It used to be an `UPDATE facts SET
   * use_count = use_count + 1`, which made the usage counters state that
   * existed nowhere in the log: a rebuild reset them, and §34.2's
   * "byte-identical" claim was quietly false on any database that had
   * been used. Found by pointing `POST /backup/verify` at a real one.
   */
  markUsed(factIds: readonly string[], principal: string): void {
    if (factIds.length === 0) return;
    this.deps.events.append({
      type: 'memory.used',
      principal,
      trust: 'SYSTEM',
      payload: { factIds: [...factIds], offered: factIds.length },
    });
  }

  /* ──────────────────────────── embeddings ───────────────────────────── */

  putEmbedding(factId: string, model: string, vector: Float32Array): void {
    this.deps.storage.run(
      `INSERT INTO fact_embeddings (fact_id, model, dimensions, vector, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(fact_id) DO UPDATE SET model=excluded.model, dimensions=excluded.dimensions,
         vector=excluded.vector, updated_at=excluded.updated_at`,
      [
        factId,
        model,
        vector.length,
        new Uint8Array(vector.buffer.slice(0) as ArrayBuffer),
        this.deps.clock.now(),
      ],
    );
  }

  embeddings(): Map<string, Float32Array> {
    const rows = this.deps.storage.all<{ fact_id: string; vector: Uint8Array }>(
      'SELECT fact_id, vector FROM fact_embeddings',
    );
    const out = new Map<string, Float32Array>();
    for (const row of rows) {
      const bytes = row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector);
      out.set(
        row.fact_id,
        new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      );
    }
    return out;
  }

  factsWithoutEmbeddings(limit = 200): Fact[] {
    return this.deps.storage
      .all<FactRow>(
        `SELECT ${FACT_COLUMNS} FROM facts f
         WHERE superseded_at IS NULL AND status IN ('active','disputed')
           AND NOT EXISTS (SELECT 1 FROM fact_embeddings e WHERE e.fact_id = f.fact_id)
         LIMIT ?`,
        [limit],
      )
      .map(toFact);
  }

  /* ───────────────────────────── episodic ────────────────────────────── */

  recordEpisode(episode: Omit<Episode, 'id'>): Episode {
    const parsed = EpisodeSchema.parse({ ...episode, id: this.deps.ids.ulid() });
    this.deps.storage.run(
      `INSERT INTO episodes (id, run_id, session_id, principal, request, response, actions,
         entities, outcome, outcome_reason, trust, started_at, ended_at, cost_micros)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO NOTHING`,
      [
        parsed.id,
        parsed.runId,
        parsed.sessionId,
        parsed.principal,
        parsed.request,
        parsed.response,
        canonicalJson(parsed.actions),
        canonicalJson(parsed.entities),
        parsed.outcome,
        parsed.outcomeReason,
        parsed.trust,
        parsed.startedAt,
        parsed.endedAt,
        parsed.costMicros,
      ],
    );
    this.deps.events.append({
      type: 'episode.recorded',
      principal: parsed.principal,
      trust: parsed.trust,
      sessionId: parsed.sessionId,
      runId: parsed.runId,
      payload: { episodeId: parsed.id, outcome: parsed.outcome, actions: parsed.actions },
    });
    return parsed;
  }

  episodes(principal: string, limit = 40): Episode[] {
    return this.deps.storage
      .all<EpisodeRow>(
        `SELECT * FROM episodes WHERE principal = ? ORDER BY ended_at DESC LIMIT ?`,
        [principal, limit],
      )
      .map(toEpisode);
  }

  unconsolidatedEpisodes(principal: string, limit = 200): Episode[] {
    return this.deps.storage
      .all<EpisodeRow>(
        `SELECT * FROM episodes WHERE principal = ? AND consolidated_at IS NULL
         ORDER BY ended_at ASC LIMIT ?`,
        [principal, limit],
      )
      .map(toEpisode);
  }

  markConsolidated(episodeIds: readonly string[], at: number): void {
    for (const id of episodeIds) {
      this.deps.storage.run('UPDATE episodes SET consolidated_at = ? WHERE id = ?', [at, id]);
    }
  }

  setEpisodeOutcome(runId: string, outcome: Episode['outcome'], reason: string): void {
    this.deps.storage.run(
      'UPDATE episodes SET outcome = ?, outcome_reason = ? WHERE run_id = ?',
      [outcome, reason, runId],
    );
  }

  /* ──────────────────────────── procedural ───────────────────────────── */

  upsertRule(rule: Omit<Rule, 'id'> & { id?: string }): Rule {
    const now = this.deps.clock.now();
    const existing = this.deps.storage.get<{ id: string }>(
      `SELECT id FROM rules WHERE principal = ? AND trigger_kind = ? AND trigger_value = ?
         AND instruction = ?`,
      [rule.principal, rule.trigger.kind, rule.trigger.value, rule.instruction],
    );
    const parsed = RuleSchema.parse({ ...rule, id: existing?.id ?? rule.id ?? this.deps.ids.ulid() });

    if (existing !== undefined) {
      // The counters and the status have to be writable here, not just the
      // confidence. Rule review (§22.3) is *entirely* about moving a rule
      // from active to probation to retired; an upsert that silently drops
      // those fields makes retirement impossible and leaves a bad rule
      // running forever, which is the exact failure the mechanism exists
      // to prevent.
      this.deps.storage.run(
        `UPDATE rules SET confidence = ?, applied = ?, overridden = ?,
           last_applied = ?, last_overridden = ?, status = ?, updated_at = ?
         WHERE id = ?`,
        [
          Math.min(1, parsed.confidence),
          parsed.applied,
          parsed.overridden,
          parsed.lastApplied,
          parsed.lastOverridden,
          parsed.status,
          now,
          existing.id,
        ],
      );
      return this.rule(existing.id) ?? parsed;
    }

    this.deps.storage.run(
      `INSERT INTO rules (id, principal, trigger_kind, trigger_value, instruction, scope, source,
         basis, confidence, applied, overridden, last_applied, last_overridden, status, trust,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        parsed.id,
        parsed.principal,
        parsed.trigger.kind,
        parsed.trigger.value,
        parsed.instruction,
        parsed.scope,
        canonicalJson(parsed.sources),
        parsed.basis,
        parsed.confidence,
        parsed.applied,
        parsed.overridden,
        parsed.lastApplied,
        parsed.lastOverridden,
        parsed.status,
        parsed.trust,
        now,
        now,
      ],
    );
    this.deps.events.append({
      type: 'rule.learned',
      principal: parsed.principal,
      trust: parsed.trust,
      payload: {
        ruleId: parsed.id,
        instruction: parsed.instruction,
        trigger: `${parsed.trigger.kind}:${parsed.trigger.value}`,
        confidence: parsed.confidence,
      },
    });
    return parsed;
  }

  rule(id: string): Rule | undefined {
    const row = this.deps.storage.get<RuleRow>('SELECT * FROM rules WHERE id = ?', [id]);
    return row === undefined ? undefined : toRule(row);
  }

  activeRules(principal: string): Rule[] {
    return this.deps.storage
      .all<RuleRow>(
        `SELECT * FROM rules WHERE principal = ? AND status IN ('active','probation')
         ORDER BY confidence DESC`,
        [principal],
      )
      .map(toRule);
  }

  allRules(principal: string): Rule[] {
    return this.deps.storage
      .all<RuleRow>('SELECT * FROM rules WHERE principal = ? ORDER BY created_at ASC', [principal])
      .map(toRule);
  }

  /* ───────────────────────────── affective ───────────────────────────── */

  affect(principal: string): Affect {
    const row = this.deps.storage.get<AffectRow>('SELECT * FROM affect WHERE principal = ?', [
      principal,
    ]);
    if (row === undefined) return AffectSchema.parse({ principal });
    return AffectSchema.parse({
      principal: row.principal,
      formality: row.formality,
      humor: row.humor,
      verbosity: row.verbosity,
      directness: row.directness,
      hedging: row.hedging,
      sensitiveTopics: JSON.parse(row.sensitive_topics) as string[],
      episodesSeen: row.episodes_seen,
    });
  }

  putAffect(affect: Affect): void {
    this.deps.storage.run(
      `INSERT INTO affect (principal, formality, humor, verbosity, directness, hedging,
         sensitive_topics, episodes_seen, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(principal) DO UPDATE SET formality=excluded.formality, humor=excluded.humor,
         verbosity=excluded.verbosity, directness=excluded.directness, hedging=excluded.hedging,
         sensitive_topics=excluded.sensitive_topics, episodes_seen=excluded.episodes_seen,
         updated_at=excluded.updated_at`,
      [
        affect.principal,
        affect.formality,
        affect.humor,
        affect.verbosity,
        affect.directness,
        affect.hedging,
        canonicalJson(affect.sensitiveTopics),
        affect.episodesSeen,
        this.deps.clock.now(),
      ],
    );
  }

  /* ────────────────────────── identity + digest ──────────────────────── */

  putIdentityCard(principal: string, text: string, tokens: number, factCount: number, digest: string): void {
    this.deps.storage.run(
      `INSERT INTO identity_cards (principal, text, tokens, fact_count, digest, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(principal) DO UPDATE SET text=excluded.text, tokens=excluded.tokens,
         fact_count=excluded.fact_count, digest=excluded.digest, updated_at=excluded.updated_at`,
      [principal, text, tokens, factCount, digest, this.deps.clock.now()],
    );
  }

  identityCard(principal: string): { text: string; tokens: number; updatedAt: number } | null {
    const row = this.deps.storage.get<{ text: string; tokens: number; updated_at: number }>(
      'SELECT text, tokens, updated_at FROM identity_cards WHERE principal = ?',
      [principal],
    );
    return row === undefined ? null : { text: row.text, tokens: row.tokens, updatedAt: row.updated_at };
  }

  addDigestEntry(principal: string, text: string, factIds: readonly string[]): void {
    this.deps.storage.run(
      'INSERT INTO learning_digest (id, principal, text, fact_ids, created_at) VALUES (?,?,?,?,?)',
      [this.deps.ids.ulid(), principal, text, canonicalJson(factIds), this.deps.clock.now()],
    );
  }

  digest(principal: string, limit = 20): Array<{ id: string; text: string; createdAt: number }> {
    return this.deps.storage.all<{ id: string; text: string; createdAt: number }>(
      `SELECT id, text, created_at AS createdAt FROM learning_digest
       WHERE principal = ? ORDER BY created_at DESC LIMIT ?`,
      [principal, limit],
    );
  }

  /* ─────────────────────────────── queue ─────────────────────────────── */

  enqueue(kind: 'observe' | 'consolidate', principal: string, payload: unknown): string {
    const id = this.deps.ids.ulid();
    this.deps.storage.run(
      'INSERT INTO memory_jobs (id, kind, principal, payload, enqueued_at) VALUES (?,?,?,?,?)',
      [id, kind, principal, canonicalJson(payload), this.deps.clock.now()],
    );
    return id;
  }

  pendingJobs(limit = 20): Array<{ id: string; kind: string; principal: string; payload: unknown }> {
    return this.deps.storage
      .all<{ id: string; kind: string; principal: string; payload: string }>(
        `SELECT id, kind, principal, payload FROM memory_jobs
         WHERE finished_at IS NULL AND attempts < 3 ORDER BY enqueued_at ASC LIMIT ?`,
        [limit],
      )
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  finishJob(id: string, error?: string): void {
    this.deps.storage.run(
      'UPDATE memory_jobs SET finished_at = ?, attempts = attempts + 1, last_error = ? WHERE id = ?',
      [error === undefined ? this.deps.clock.now() : null, error ?? null, id],
    );
    if (error !== undefined) {
      this.deps.storage.run('UPDATE memory_jobs SET attempts = attempts + 1 WHERE id = ?', [id]);
    }
  }
}

/* ──────────────────────────────── helpers ─────────────────────────────────── */

/**
 * Confidence rises with observations and never reaches 1.
 *
 * The ceiling is the point. A fact observed four hundred times is still a
 * fact someone could have been wrong about, and an agent that reaches
 * certainty has lost the ability to be corrected gracefully.
 */
export function raiseConfidence(current: number, observations: number): number {
  const target = 1 - 1 / (observations + 1);
  return Math.min(0.97, Math.max(current, current + (target - current) * 0.4));
}

interface EpisodeRow {
  id: string;
  run_id: string;
  session_id: string | null;
  principal: string;
  request: string;
  response: string;
  actions: string;
  entities: string;
  outcome: string;
  outcome_reason: string | null;
  trust: string;
  started_at: number;
  ended_at: number;
  cost_micros: number;
}

interface RuleRow {
  id: string;
  principal: string;
  trigger_kind: string;
  trigger_value: string;
  instruction: string;
  scope: string;
  source: string;
  basis: string;
  confidence: number;
  applied: number;
  overridden: number;
  last_applied: number | null;
  last_overridden: number | null;
  status: string;
  trust: string;
}

interface AffectRow {
  principal: string;
  formality: number;
  humor: number;
  verbosity: number;
  directness: number;
  hedging: number;
  sensitive_topics: string;
  episodes_seen: number;
}

function toFact(row: FactRow): Fact {
  return FactSchema.parse({
    id: row.fact_id,
    subject: JSON.parse(row.subject) as unknown,
    predicate: row.predicate,
    object: JSON.parse(row.object) as unknown,
    basis: row.basis,
    confidence: row.confidence,
    sources: JSON.parse(row.sources) as unknown,
    observationCount: row.observation_count,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    recordedAt: row.recorded_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    stability: row.stability,
    sensitivity: row.sensitivity,
    trust: row.trust,
    status: row.status,
    pinned: row.pinned === 1,
    keyId: row.key_id,
  });
}

function toEpisode(row: EpisodeRow): Episode {
  return EpisodeSchema.parse({
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    principal: row.principal,
    request: row.request,
    response: row.response,
    actions: JSON.parse(row.actions) as unknown,
    entities: JSON.parse(row.entities) as unknown,
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    trust: row.trust,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costMicros: row.cost_micros,
  });
}

function toRule(row: RuleRow): Rule {
  return RuleSchema.parse({
    id: row.id,
    principal: row.principal,
    trigger: { kind: row.trigger_kind, value: row.trigger_value },
    instruction: row.instruction,
    scope: row.scope,
    sources: JSON.parse(row.source) as unknown,
    basis: row.basis,
    confidence: row.confidence,
    applied: row.applied,
    overridden: row.overridden,
    lastApplied: row.last_applied,
    lastOverridden: row.last_overridden,
    status: row.status,
    trust: row.trust,
  });
}

/** A fact as one readable line — for the context, the digest and the UI. */
/**
 * How a belief is phrased wherever a human or a model will read it.
 *
 * This is not cosmetic. The identity card, the recall block, the digest and
 * the `memory.*` tools all render through here, so a clumsy predicate
 * ("you name Ara") becomes clumsy *in the prompt*, and the model copies the
 * register it is given. A handful of phrasings for the predicates the
 * extractor actually produces costs nothing and makes the context read like
 * something written about a person.
 */
const PHRASING: Record<string, (subject: string, object: string) => string> = {
  name: (s, o) => `${s === 'you' ? 'your' : `${s}'s`} name is ${o}`,
  preferred_name: (s, o) => `${s === 'you' ? 'you prefer' : `${s} prefers`} to be called ${o}`,
  works_at: (s, o) => `${s} ${s === 'you' ? 'work' : 'works'} at ${o}`,
  lives_in: (s, o) => `${s} ${s === 'you' ? 'live' : 'lives'} in ${o}`,
  allergic_to: (s, o) => `${s} ${s === 'you' ? 'are' : 'is'} allergic to ${o}`,
  birthday: (s, o) => `${s === 'you' ? 'your' : `${s}'s`} birthday is ${o}`,
  often_asks_for: (s, o) => `${s} often ${s === 'you' ? 'ask' : 'asks'} for ${o}`,
  committed_to: (s, o) => `${s} promised to ${o}`,
};

/**
 * Predicates that name a relationship rather than an action.
 *
 * "you daughter Noor" is the kind of line that makes a model write like a
 * telegram. These read as possessives instead.
 */
function isShredded(object: unknown): boolean {
  return typeof object === 'object' && object !== null && '$shredded' in object;
}

const RELATIONS = new Set([
  'daughter', 'son', 'child', 'partner', 'spouse', 'wife', 'husband',
  'mother', 'father', 'sister', 'brother', 'manager', 'employer',
  'birthday', 'address', 'phone', 'email', 'pronouns', 'timezone',
]);

export function factLine(fact: Fact): string {
  // A shredded fact has no content left — only the marker that says content
  // was destroyed here. Rendering the marker's JSON would show the user a
  // key id where their sentence used to be, which reads like a bug rather
  // than like the deliberate destruction it was.
  if (isShredded(fact.object)) return '(forgotten — the content was destroyed)';

  const object =
    typeof fact.object === 'string' ? fact.object : canonicalJson(fact.object).replace(/^"|"$/g, '');
  const subject = fact.subject.id === 'self' ? 'you' : fact.subject.label;
  const phrase = PHRASING[fact.predicate];
  if (phrase !== undefined) return phrase(subject, object);

  if (RELATIONS.has(fact.predicate)) {
    return `${subject === 'you' ? 'your' : `${subject}'s`} ${fact.predicate} is ${object}`;
  }

  // Heuristic, and only for the user: a one-word predicate ending in -s is
  // almost always a third-person verb the extractor lifted from "she
  // prefers…", and "you prefers" is worse than any risk of mangling an
  // unusual predicate. Multi-word predicates are left alone.
  const predicate = fact.predicate.replaceAll('_', ' ');
  if (subject === 'you' && !predicate.includes(' ') && /[a-z]{3,}s$/.test(predicate) && !predicate.endsWith('ss')) {
    return `${subject} ${predicate.slice(0, -1)} ${object}`;
  }
  return `${subject} ${predicate} ${object}`;
}
