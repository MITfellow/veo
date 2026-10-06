import type { Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';

/**
 * The entity registry.
 *
 * Resolution itself is a Cognitive Job (`entity.resolve`) and lives in
 * `cognition/`. This is the part underneath: who exists, what they have
 * been called, and which record absorbed which. The registry supplies
 * candidates; the job decides. Keeping the decision out of here is what
 * lets a model take it over later without touching storage.
 */

export type EntityKind = 'person' | 'org' | 'place' | 'thing' | 'project';

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  canonicalId: string | null;
  aliases: string[];
}

export interface Candidate {
  id: string;
  name: string;
  aliases: string[];
}

export class EntityError extends Error {
  constructor(readonly kind: 'not_found' | 'cycle' | 'invalid', message: string) {
    super(message);
    this.name = 'EntityError';
  }
}

/**
 * Casefold, strip punctuation and accents, collapse whitespace.
 *
 * The same normalisation is applied when storing an alias and when looking
 * one up, so "O'Brien", "obrien" and "O’Brien" are one key. It is stored
 * alongside the original rather than replacing it, because the display
 * name is the user's and we do not get to mangle it.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface EntityRow { id: string; kind: string; name: string; canonical_id: string | null }

export interface EntityDeps {
  storage: Storage;
  events: EventLog;
  nextId: () => string;
}

/** A merge chain longer than this is a bug, not a deep hierarchy. */
const MAX_CHAIN = 32;

export class EntityRegistry {
  constructor(private readonly deps: EntityDeps) {}

  create(kind: EntityKind, name: string, actor = 'agent'): string {
    if (name.trim() === '') throw new EntityError('invalid', 'An entity needs a name.');
    const entityId = this.deps.nextId();
    this.deps.events.append({
      type: 'entity.created',
      actor,
      trust: 'DERIVED',
      payload: { entityId, kind, name: name.trim() },
    });
    return entityId;
  }

  get(entityId: string): Entity | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM entities WHERE id = ?').get<EntityRow>(entityId);
    if (row === undefined) return undefined;
    return {
      id: row.id,
      kind: row.kind as EntityKind,
      name: row.name,
      canonicalId: row.canonical_id,
      aliases: this.aliasesOf(row.id),
    };
  }

  /**
   * Renaming keeps the old name.
   *
   * A note from 2023 says "Acme"; the company is now "Acme Global"; a
   * question about 2023 must still find it. Dropping the old name would
   * silently break every historical reference.
   */
  rename(entityId: string, name: string, actor = 'user'): void {
    const existing = this.requireEntity(entityId);
    if (name.trim() === '') throw new EntityError('invalid', 'An entity needs a name.');
    this.deps.events.append({
      type: 'entity.renamed',
      actor,
      trust: 'USER',
      payload: {
        entityId,
        name: name.trim(),
        previousName: existing.name,
        normalizedPrevious: normalizeName(existing.name),
      },
    });
  }

  /**
   * Fold `absorbed` into `canonical`.
   *
   * The canonical record inherits every name the absorbed one answered to.
   * A cycle is refused rather than followed: two records that each claim
   * the other is canonical have no answer, and looping forever while
   * looking for one is the worst possible failure.
   */
  merge(absorbedId: string, canonicalId: string, actor = 'user'): void {
    const absorbed = this.requireEntity(absorbedId);
    this.requireEntity(canonicalId);
    if (absorbedId === canonicalId) throw new EntityError('cycle', 'An entity cannot absorb itself.');
    if (this.canonicalOf(canonicalId) === absorbedId) {
      throw new EntityError('cycle', `${canonicalId} already resolves to ${absorbedId}; merging would create a cycle.`);
    }
    const aliases = [
      { alias: absorbed.name, normalized: normalizeName(absorbed.name) },
      ...absorbed.aliases.map((a) => ({ alias: a, normalized: normalizeName(a) })),
    ];
    this.deps.events.append({
      type: 'entity.merged',
      actor,
      trust: 'USER',
      payload: { entityId: absorbedId, canonicalId, aliases },
    });
  }

  /** Follow the merge chain to the record that actually holds the facts. */
  canonicalOf(entityId: string): string {
    let current = entityId;
    const seen = new Set<string>([current]);
    for (let hop = 0; hop < MAX_CHAIN; hop++) {
      const row = this.deps.storage.prepare('SELECT canonical_id FROM entities WHERE id = ?')
        .get<{ canonical_id: string | null }>(current);
      const next = row?.canonical_id;
      if (next === undefined || next === null) return current;
      // A cycle in stored data is a bug somewhere upstream, but it must
      // not become a hang here.
      if (seen.has(next)) return current;
      seen.add(next);
      current = next;
    }
    return current;
  }

  /**
   * Candidates for a mention, cheaply narrowed.
   *
   * Exact normalised hits first — those are almost certainly the answer —
   * then anything sharing a token, capped. The *decision* is the job's;
   * this only avoids handing it the entire address book.
   */
  candidates(mention: string, limit = 25): Candidate[] {
    const normalized = normalizeName(mention);
    if (normalized === '') return [];

    const ids = new Set<string>();
    for (const stage of [this.byAlias(normalized), this.byName(normalized), this.byToken(normalized)]) {
      for (const id of stage) {
        if (ids.size >= limit) break;
        ids.add(this.canonicalOf(id));
      }
    }

    return [...ids]
      .map((id) => this.get(id))
      .filter((e): e is Entity => e !== undefined)
      .map((e) => ({ id: e.id, name: e.name, aliases: e.aliases }));
  }

  private byAlias(normalized: string): string[] {
    return this.deps.storage
      .prepare('SELECT entity_id FROM entity_aliases WHERE normalized = ?')
      .all<{ entity_id: string }>(normalized)
      .map((r) => r.entity_id);
  }

  private byName(normalized: string): string[] {
    return this.rows().filter((r) => normalizeName(r.name) === normalized).map((r) => r.id);
  }

  /** Last resort: anything sharing a word of three letters or more. */
  private byToken(normalized: string): string[] {
    const tokens = normalized.split(' ').filter((t) => t.length > 2);
    if (tokens.length === 0) return [];
    return this.rows()
      .filter((r) => {
        const theirs = normalizeName(r.name).split(' ');
        return tokens.some((t) => theirs.includes(t));
      })
      .map((r) => r.id);
  }

  private rows(): Array<{ id: string; name: string }> {
    return this.deps.storage.prepare('SELECT id, name FROM entities').all<{ id: string; name: string }>();
  }

  all(): Entity[] {
    return this.deps.storage
      .prepare('SELECT id FROM entities ORDER BY name ASC')
      .all<{ id: string }>()
      .map((r) => this.get(r.id))
      .filter((e): e is Entity => e !== undefined);
  }

  count(): number {
    return this.deps.storage.prepare('SELECT COUNT(*) AS n FROM entities').get<{ n: number }>()?.n ?? 0;
  }

  private aliasesOf(entityId: string): string[] {
    return this.deps.storage
      .prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias ASC')
      .all<{ alias: string }>(entityId)
      .map((r) => r.alias);
  }

  private requireEntity(entityId: string): Entity {
    const entity = this.get(entityId);
    if (entity === undefined) throw new EntityError('not_found', `No entity ${entityId}.`);
    return entity;
  }
}
