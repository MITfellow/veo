import { canonicalJson } from '../hash.js';
import type { Hashing, Storage } from '../ports.js';

/**
 * A deterministic serialisation of every projection table.
 *
 * This exists for exactly one test — `rebuild-identity` — and that test is the
 * proof of invariant 1. Build state, snapshot it, destroy the projections,
 * replay the log, snapshot again: the two strings must be identical byte for
 * byte. Anything that differs is state that was never in the log, i.e. state
 * that a crash or a restore would silently lose.
 *
 * Every query here has a total ORDER BY. A snapshot that depends on SQLite's
 * physical row order would pass or fail depending on page layout, which would
 * make the test worse than useless.
 */

export const SNAPSHOT_TABLES = [
  { table: 'sessions', order: 'id' },
  { table: 'messages', order: 'seq, id' },
  { table: 'runs', order: 'id' },
  { table: 'entities', order: 'id' },
  { table: 'artifacts', order: 'id' },
  { table: 'facts', order: 'id' },
] as const;

export function snapshotProjections(storage: Storage): string {
  const parts: string[] = [];
  for (const { table, order } of SNAPSHOT_TABLES) {
    const rows = storage.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY ${order}`);
    parts.push(`${table}\n${rows.map((r) => canonicalJson(normalise(r))).join('\n')}`);
  }
  // FTS content is derived too, and a rebuild that silently loses the search
  // index would still "pass" if we only compared the base tables.
  const fts = storage.all<Record<string, unknown>>(
    'SELECT fact_id, row_id, text FROM facts_fts ORDER BY row_id',
  );
  parts.push(`facts_fts\n${fts.map((r) => canonicalJson(normalise(r))).join('\n')}`);
  return parts.join('\n\n');
}

export function snapshotDigest(storage: Storage, hashing: Hashing): string {
  return hashing.sha256Hex(snapshotProjections(storage));
}

/**
 * SQLite hands integers back as `number` or `bigint` depending on magnitude,
 * and that choice can differ between a fresh insert and a re-read. Normalising
 * stops the test failing for a reason that has nothing to do with correctness.
 */
function normalise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
  return out;
}
