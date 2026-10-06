import type { Storage } from '../ports.js';
import type { Projector } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';

/**
 * The bitemporal fact projection (§17).
 *
 * Two timelines, and the whole design turns on keeping them independent:
 *
 *   **valid time** (`valid_from`, `valid_to`) — when the statement was true
 *   of the world. "Ara worked at Acme from 2019 to 2023."
 *
 *   **transaction time** (`recorded_at`, `retracted_at`) — when the system
 *   believed it. "We thought that between March and June."
 *
 * The distinction is not academic. "I moved to Berlin last year" changes the
 * world, so it closes valid time and opens a new row. "No, I never worked at
 * Acme" changes only the belief, so it closes transaction time and leaves
 * valid time untouched. A system with one timeline cannot tell a correction
 * from a change, and will either lose history or invent it.
 *
 * Nothing is ever deleted or overwritten. That is what makes "what did you
 * believe in March, and what do you believe now" two different queries over
 * the same table.
 */

function clear(storage: Storage, tables: readonly string[]): void {
  for (const table of tables) storage.prepare(`DELETE FROM ${table}`).run();
}

function str(event: StoredEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === 'string' ? value : '';
}

function num(event: StoredEvent, key: string, fallback: number): number {
  const value = event.payload[key];
  return typeof value === 'number' ? value : fallback;
}

const INSERT_FACT = `
  INSERT OR REPLACE INTO facts
    (id, subject, predicate, object, valid_from, valid_to, recorded_at, retracted_at,
     superseded_by, basis, confidence, stability, sensitivity, status, pinned, trust, source_event)
  VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,'active',0,?,?)
`;

function assertFact(event: StoredEvent, storage: Storage): void {
  const validTo = event.payload['validTo'];
  storage.prepare(INSERT_FACT).run(
    str(event, 'factId'),
    str(event, 'subject'),
    str(event, 'predicate'),
    str(event, 'object'),
    num(event, 'validFrom', event.ts),
    typeof validTo === 'number' ? validTo : null,
    // recorded_at is the event's timestamp, never a fresh clock read: a
    // replay must reproduce the original belief time exactly.
    event.ts,
    str(event, 'basis'),
    num(event, 'confidence', 0.5),
    str(event, 'stability') || 'slow',
    str(event, 'sensitivity') || 'normal',
    str(event, 'sourceTrust') || event.trust,
    event.id,
  );
}

export function factsProjector(): Projector {
  const tables = ['facts'];
  return {
    name: 'facts',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      switch (event.type) {
        case 'fact.asserted':
          assertFact(event, storage);
          return;
        case 'fact.superseded':
          // The world changed. Close valid time; the old belief stays true
          // as a belief, so retracted_at is deliberately untouched.
          storage.prepare(`UPDATE facts SET valid_to = ?, superseded_by = ?, status = 'superseded' WHERE id = ?`)
            .run(num(event, 'validTo', event.ts), str(event, 'supersededBy'), str(event, 'factId'));
          return;
        case 'fact.corrected':
          // The belief was wrong. Close transaction time and point at the
          // replacement; valid time is deliberately untouched, because we
          // are not claiming the world changed.
          storage.prepare(
            `UPDATE facts SET retracted_at = ?, superseded_by = ?, status = 'corrected' WHERE id = ?`,
          ).run(event.ts, str(event, 'correctedBy'), str(event, 'factId'));
          return;
        case 'fact.retracted':
          // The belief was wrong. Close transaction time only: valid_to
          // stays as it was, because we are not claiming the world changed.
          storage.prepare(`UPDATE facts SET retracted_at = ?, status = 'retracted' WHERE id = ?`)
            .run(event.ts, str(event, 'factId'));
          return;
        case 'fact.pinned':
        case 'fact.unpinned':
          storage.prepare('UPDATE facts SET pinned = ? WHERE id = ?')
            .run(event.type === 'fact.pinned' ? 1 : 0, str(event, 'factId'));
          return;
        default:
          return;
      }
    },
  };
}

export function entitiesProjector(): Projector {
  const tables = ['entities', 'entity_aliases'];
  return {
    name: 'entities',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      switch (event.type) {
        case 'entity.created':
          storage.prepare(
            `INSERT OR REPLACE INTO entities (id, kind, name, canonical_id, created_at, updated_at)
             VALUES (?,?,?,NULL,?,?)`,
          ).run(str(event, 'entityId'), str(event, 'kind'), str(event, 'name'), event.ts, event.ts);
          return;
        case 'entity.renamed': {
          const id = str(event, 'entityId');
          storage.prepare('UPDATE entities SET name = ?, updated_at = ? WHERE id = ?')
            .run(str(event, 'name'), event.ts, id);
          // The old name becomes an alias. A note from 2023 says "Acme";
          // the company is now "Acme Global"; a question about 2023 must
          // still find it.
          addAlias(storage, id, str(event, 'previousName'), str(event, 'normalizedPrevious'), 'renamed', event.ts);
          return;
        }
        case 'entity.merged': {
          const absorbed = str(event, 'entityId');
          const canonical = str(event, 'canonicalId');
          storage.prepare('UPDATE entities SET canonical_id = ?, updated_at = ? WHERE id = ?')
            .run(canonical, event.ts, absorbed);
          // The canonical entity inherits every name the absorbed one
          // answered to, or the merge loses the ability to find it.
          const aliases = event.payload['aliases'];
          if (Array.isArray(aliases)) {
            for (const entry of aliases) {
              if (typeof entry !== 'object' || entry === null) continue;
              const { alias, normalized } = entry as { alias?: unknown; normalized?: unknown };
              if (typeof alias !== 'string' || typeof normalized !== 'string') continue;
              addAlias(storage, canonical, alias, normalized, 'merged', event.ts);
            }
          }
          return;
        }
        default:
          return;
      }
    },
  };
}

function addAlias(
  storage: Storage,
  entityId: string,
  alias: string,
  normalized: string,
  source: string,
  at: number,
): void {
  if (alias === '' || normalized === '') return;
  storage.prepare(
    `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized, source, created_at) VALUES (?,?,?,?,?)`,
  ).run(entityId, alias, normalized, source, at);
}

/**
 * Items: what exists, under which key, and whether it has been shredded.
 *
 * Metadata only. The ciphertext is in `item_blobs`, which is not a
 * projection. Shredding is a tombstone, not a delete — "we had this and it
 * is gone" has to stay auditable after the content cannot be read.
 */
export function itemsProjector(): Projector {
  const tables = ['items'];
  return {
    name: 'items',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      if (event.type === 'artifact.created') {
        storage.prepare(
          `INSERT OR REPLACE INTO items (id, kind, label, key_id, bytes, trust, created_at, shredded_at)
           VALUES (?,?,?,?,?,?,?,NULL)`,
        ).run(
          str(event, 'itemId'), str(event, 'kind'), str(event, 'label'),
          str(event, 'keyId'), num(event, 'bytes', 0), event.trust, event.ts,
        );
        return;
      }
      if (event.type === 'artifact.deleted') {
        storage.prepare('UPDATE items SET shredded_at = ? WHERE id = ?').run(event.ts, str(event, 'itemId'));
      }
    },
  };
}

/**
 * Queries that demonstrate the two timelines are genuinely independent.
 * Memory proper is M5; these exist so M0 can prove the shape works.
 */
export interface FactRow {
  id: string; subject: string; predicate: string; object: string;
  valid_from: number; valid_to: number | null;
  recorded_at: number; retracted_at: number | null; status: string;
}

/** What the system believes *now* was true *at* `instant`. */
export function validAt(storage: Storage, instant: number): FactRow[] {
  return storage.prepare(
    `SELECT * FROM facts
      WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND retracted_at IS NULL
      ORDER BY id ASC`,
  ).all<FactRow>(instant, instant);
}

/** What the system believed *at* `instant`, right or wrong, about any time. */
export function believedAt(storage: Storage, instant: number): FactRow[] {
  return storage.prepare(
    `SELECT * FROM facts
      WHERE recorded_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)
      ORDER BY id ASC`,
  ).all<FactRow>(instant, instant);
}
