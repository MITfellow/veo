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
  const tables = ['entities'];
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
        case 'entity.renamed':
          storage.prepare('UPDATE entities SET name = ?, updated_at = ? WHERE id = ?')
            .run(str(event, 'name'), event.ts, str(event, 'entityId'));
          return;
        case 'entity.merged':
          storage.prepare('UPDATE entities SET canonical_id = ?, updated_at = ? WHERE id = ?')
            .run(str(event, 'canonicalId'), event.ts, str(event, 'entityId'));
          return;
        default:
          return;
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
