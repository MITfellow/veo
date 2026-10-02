/**
 * The entity graph and entity resolution (§22.2).
 *
 * This is what lets the agent say "your sister Priya" instead of "someone you
 * mentioned". It is also the single easiest place in memory to do real
 * damage: merge two people who share a first name and every fact about one
 * becomes a fact about the other, with full confidence and a clean audit
 * trail pointing at the wrong person.
 *
 * So resolution here is **explicit, thresholded, reversible and logged**
 * (§22.2, verbatim):
 *
 * - *Explicit* — a merge is an `entity.merged` event, never a side effect of
 *   a write.
 * - *Thresholded* — below the threshold the system does not guess. §22.5
 *   step 3: "ambiguous → ask later, not guess now". An unresolved mention
 *   becomes its own entity and a queued question, which is recoverable;
 *   a wrong merge is not.
 * - *Reversible* — `merged_into` is a pointer, not a rewrite. Unmerging is
 *   clearing the pointer, and the facts never moved.
 * - *Logged* — both directions.
 */
import type { EventLog } from '../../substrate/events/log.js';
import type { TrustLevel } from '../../substrate/events/types.js';
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import type { Candidate, EntityRef } from './types.js';

export interface EntityRow {
  id: string;
  kind: string;
  name: string;
  aliases: string;
  merged_into: string | null;
  created_at: number;
  updated_at: number;
}

export interface Entity {
  id: string;
  kind: EntityRef['kind'];
  name: string;
  aliases: string[];
  mergedInto: string | null;
}

export interface EntityResolverDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
  principal: string;
}

/**
 * Above this, two mentions are the same entity. Below it, they are two
 * entities and a question.
 *
 * 0.82 is high, and deliberately so: the cost of a missed merge is the agent
 * asking "is this the same Priya?", and the cost of a wrong merge is two
 * people's lives fused in a store that is explicitly designed to never
 * forget. Those are not comparable costs, so the threshold is not a midpoint.
 */
export const MERGE_THRESHOLD = 0.82;

export class EntityResolver {
  constructor(private readonly deps: EntityResolverDeps) {}

  /** Find or create the entity a mention refers to. */
  resolve(mention: { label: string; kind: EntityRef['kind'] }): {
    entity: Entity;
    created: boolean;
    ambiguous: Entity[];
  } {
    if (mention.kind === 'self') {
      return { entity: this.self(), created: false, ambiguous: [] };
    }

    const normalized = normalize(mention.label);
    const candidates = this.all().filter((entity) => entity.kind === mention.kind);

    const scored = candidates
      .map((entity) => ({ entity, score: similarity(normalized, entity) }))
      .filter((row) => row.score > 0.4)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best !== undefined && best.score >= MERGE_THRESHOLD) {
      return { entity: this.follow(best.entity), created: false, ambiguous: [] };
    }

    // An abbreviation resolves when exactly one person could be meant.
    //
    // "P." scores only 0.5 as a string, and rightly so — but if there is
    // one Priya and no other P in the graph, treating "P." as a new person
    // is not caution, it is a bug that fills the store with ghosts. The
    // uniqueness, not the string, is what carries the resolution, so this
    // is deliberately limited to single-character mentions: "Priyanka" has
    // a prefix in common with "Priya" and must still ask.
    const abbreviation = normalized.length === 1;
    if (abbreviation && scored.length === 1 && best !== undefined) {
      return { entity: this.follow(best.entity), created: false, ambiguous: [] };
    }

    // Ambiguous: create its own entity and hand back the near-misses so the
    // caller can queue a question. Guessing here is the failure mode.
    const created = this.create(mention.label, mention.kind);
    return { entity: created, created: true, ambiguous: scored.slice(0, 3).map((row) => row.entity) };
  }

  self(): Entity {
    const existing = this.deps.storage.get<EntityRow>(
      "SELECT * FROM entities WHERE id = 'self'",
    );
    if (existing !== undefined) return toEntity(existing);
    const now = this.deps.clock.now();
    this.deps.storage.run(
      `INSERT INTO entities (id, kind, name, aliases, merged_into, created_at, updated_at)
       VALUES ('self','self','you','[]',NULL,?,?)`,
      [now, now],
    );
    return { id: 'self', kind: 'self', name: 'you', aliases: [], mergedInto: null };
  }

  create(name: string, kind: EntityRef['kind']): Entity {
    const id = this.deps.ids.ulid();
    // The event is the only write. The projector creates the row inside the
    // same transaction, so the entity is readable the moment this returns —
    // and there is exactly one path by which an entity can come into
    // existence, which is the point.
    this.deps.events.append({
      type: 'entity.upserted',
      principal: this.deps.principal,
      trust: 'DERIVED',
      payload: { entityId: id, kind, name, aliases: [] },
    });
    return { id, kind, name, aliases: [], mergedInto: null };
  }

  addAlias(entityId: string, alias: string): void {
    const entity = this.get(entityId);
    if (entity === undefined) return;
    if (entity.aliases.some((a) => normalize(a) === normalize(alias))) return;
    const aliases = [...entity.aliases, alias];
    this.deps.events.append({
      type: 'entity.upserted',
      principal: this.deps.principal,
      trust: 'DERIVED',
      payload: { entityId, kind: entity.kind, name: entity.name, aliases },
    });
  }

  /** Both directions are logged, and nothing is rewritten. */
  merge(fromId: string, intoId: string, reason: string, trust: TrustLevel = 'USER'): void {
    if (fromId === intoId) return;
    const from = this.get(fromId);
    this.deps.events.append({
      type: 'entity.merged',
      principal: this.deps.principal,
      trust,
      payload: { from: fromId, into: intoId, reason },
    });
    // The absorbed name becomes an alias of the survivor, so the old label
    // keeps resolving. Done after the merge event so the ordering reads the
    // way it happened.
    if (from !== undefined) this.addAlias(intoId, from.name);
  }

  unmerge(entityId: string, reason: string): void {
    this.deps.events.append({
      type: 'entity.merged',
      principal: this.deps.principal,
      trust: 'USER',
      payload: { from: entityId, into: entityId, reason: `unmerged: ${reason}` },
    });
  }

  get(id: string): Entity | undefined {
    const row = this.deps.storage.get<EntityRow>('SELECT * FROM entities WHERE id = ?', [id]);
    return row === undefined ? undefined : toEntity(row);
  }

  all(): Entity[] {
    return this.deps.storage
      .all<EntityRow>('SELECT * FROM entities ORDER BY created_at ASC')
      .map(toEntity);
  }

  /** A merged entity answers as the one it was merged into. */
  private follow(entity: Entity, depth = 0): Entity {
    if (entity.mergedInto === null || depth > 8) return entity;
    const target = this.get(entity.mergedInto);
    return target === undefined ? entity : this.follow(target, depth + 1);
  }
}

/** Point a candidate at a resolved entity before it is written. */
export function resolveEntity(
  resolver: EntityResolver,
  candidate: Candidate,
  _principal: string,
): Candidate {
  if (candidate.subject.kind === 'self') {
    return { ...candidate, subject: { id: 'self', kind: 'self', label: 'you' } };
  }
  const { entity } = resolver.resolve({ label: candidate.subject.label, kind: candidate.subject.kind });
  return {
    ...candidate,
    subject: { id: entity.id, kind: candidate.subject.kind, label: entity.name },
  };
}

/* ──────────────────────────────── matching ────────────────────────────────── */

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();
}

/**
 * How alike two names are, in [0,1].
 *
 * An exact match on the name or on a recorded alias is 1 — aliases are the
 * user's own statement that two labels mean one thing, and no string metric
 * should second-guess that. Everything else is token overlap plus an
 * initial-match bonus ("P." against "Priya"), which is weak on purpose: weak
 * similarity lands below the threshold and asks, which is the correct
 * outcome.
 */
export function similarity(normalizedMention: string, entity: Entity): number {
  const names = [entity.name, ...entity.aliases].map(normalize);
  if (names.includes(normalizedMention)) return 1;

  const mentionTokens = normalizedMention.split(' ').filter(Boolean);
  let best = 0;

  for (const name of names) {
    const tokens = name.split(' ').filter(Boolean);
    const shared = mentionTokens.filter((token) => tokens.includes(token)).length;
    if (shared > 0) {
      best = Math.max(best, shared / Math.max(mentionTokens.length, tokens.length));
    }
    // "P." for "Priya": an initial is evidence, not proof.
    const initial = mentionTokens[0];
    if (
      mentionTokens.length === 1 &&
      initial !== undefined &&
      initial.length === 1 &&
      tokens.some((token) => token.startsWith(initial))
    ) {
      best = Math.max(best, 0.5);
    }

    // Shared prefixes: "Priyanka" against "Priya".
    //
    // This cannot reach the merge threshold by design — it exists so the
    // near-miss is *reported* rather than invisible. Two names that start
    // the same are a reason to ask, and a store that never surfaces them
    // silently accumulates duplicate people.
    for (const token of tokens) {
      for (const mentionToken of mentionTokens) {
        const shared = commonPrefix(token, mentionToken);
        if (shared >= 4) {
          best = Math.max(best, Math.min(0.7, shared / Math.max(token.length, mentionToken.length)));
        }
      }
    }
  }
  return best;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    kind: row.kind as EntityRef['kind'],
    name: row.name,
    aliases: JSON.parse(row.aliases) as string[],
    mergedInto: row.merged_into,
  };
}
