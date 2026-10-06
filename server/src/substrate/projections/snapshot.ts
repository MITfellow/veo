import type { CryptoPort, Storage } from '../ports.js';
import { canonicalJson } from '../events/hash.js';

/**
 * The snapshot digest — the instrument §16 is measured with.
 *
 * "Byte-identical" needs an operational definition, and the obvious ones are
 * wrong:
 *
 *   * Comparing the SQLite **file** fails for reasons that have nothing to do
 *     with correctness: page allocation order, freelist contents, the WAL, and
 *     `AUTOINCREMENT` sequence counters all differ after a delete-and-reinsert
 *     even when every row is identical.
 *   * Comparing `SELECT *` output without an `ORDER BY` fails intermittently,
 *     because SQLite may return rows in any order and usually changes its mind
 *     once the pages are laid out differently. That is the worst kind of test:
 *     one that passes until it matters.
 *
 * So the digest is taken over **logical content**: every projection table,
 * every row, every column, in a total order, canonically serialised. Two
 * databases with the same digest hold the same facts regardless of how SQLite
 * chose to store them.
 */

/**
 * The tables a rebuild must reproduce. `events` is deliberately absent — it is
 * the log, not a projection, and including it would make the test tautological.
 */
export const PROJECTION_TABLES = [
  'sessions',
  'messages',
  'runs',
  'captures',
  'facts',
  'entities',
  'tool_calls',
] as const;

export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

/** Column names for a table, in the order SQLite declared them. */
function columnsOf(storage: Storage, table: string): string[] {
  const rows = storage.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return rows.map((row) => row.name).sort();
}

/**
 * Rows of one table, canonically ordered and serialised.
 *
 * The sort is by every column, not by primary key: two rows could share a key
 * only if the schema were broken, but ordering by the full tuple means the
 * digest is well-defined even then, instead of being silently unstable.
 */
function tableLines(storage: Storage, table: string): string[] {
  const columns = columnsOf(storage, table);
  if (columns.length === 0) return [];
  const select = columns.map((c) => `"${c}"`).join(', ');
  const order = columns.map((c) => `"${c}"`).join(', ');
  const rows = storage.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${order}`).all<Record<string, unknown>>();
  return rows.map((row) => canonicalJson(row));
}

/** A per-table digest, so a failure names the table that diverged. */
export function tableDigests(
  storage: Storage,
  crypto: CryptoPort,
  tables: readonly string[] = PROJECTION_TABLES,
): Record<string, { rows: number; digest: string }> {
  const out: Record<string, { rows: number; digest: string }> = {};
  for (const table of tables) {
    const lines = tableLines(storage, table);
    out[table] = { rows: lines.length, digest: crypto.sha256(lines.join('\n')) };
  }
  return out;
}

/**
 * One digest over every projection.
 *
 * Returned alongside the per-table map so a failing assertion can report
 * *which* projection drifted rather than just "the bytes differ", which is a
 * useless thing to read at 2am.
 */
export function snapshotDigest(
  storage: Storage,
  crypto: CryptoPort,
  tables: readonly string[] = PROJECTION_TABLES,
): { digest: string; tables: Record<string, { rows: number; digest: string }> } {
  const perTable = tableDigests(storage, crypto, tables);
  const combined = [...tables].sort().map((table) => `${table}:${perTable[table]?.digest ?? ''}`).join('\n');
  return { digest: crypto.sha256(combined), tables: perTable };
}

/** Human-readable diff of two snapshots. Used by the test and by `arish rebuild`. */
export function diffSnapshots(
  before: ReturnType<typeof snapshotDigest>,
  after: ReturnType<typeof snapshotDigest>,
): string[] {
  const problems: string[] = [];
  for (const table of Object.keys(before.tables)) {
    const a = before.tables[table];
    const b = after.tables[table];
    if (!b) {
      problems.push(`${table}: missing after rebuild`);
      continue;
    }
    if (a && a.digest !== b.digest) {
      problems.push(`${table}: ${a.rows} rows → ${b.rows} rows, digest ${a.digest.slice(0, 12)} → ${b.digest.slice(0, 12)}`);
    }
  }
  return problems;
}
