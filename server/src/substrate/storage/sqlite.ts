import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Statement, Storage } from '../ports.js';
import { MIGRATIONS } from './migrations.js';

/**
 * The SQLite implementation of the Storage port.
 *
 * Pragmas, and why each one:
 *
 *   `journal_mode = WAL`     a reader never blocks the writer, which matters
 *                            because the HTTP interface reads projections
 *                            while the run loop appends events.
 *   `foreign_keys = ON`      off by default in SQLite; a projection that
 *                            references a missing row should fail loudly.
 *   `synchronous = NORMAL`   with WAL this is durable across process crashes,
 *                            which is the failure we actually have. FULL
 *                            buys protection from power loss at roughly an
 *                            order of magnitude on append latency, and §57
 *                            budgets 2 ms.
 *   `busy_timeout = 5000`    a second process should wait, not throw.
 */
const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
];

export interface SqliteOptions {
  /** File path, or `:memory:` for a test database. */
  path: string;
}

export function openStorage(options: SqliteOptions): Storage {
  if (options.path !== ':memory:') {
    mkdirSync(dirname(options.path), { recursive: true });
  }
  const db = new Database(options.path);
  for (const pragma of PRAGMAS) db.pragma(pragma.replace('PRAGMA ', ''));

  const storage: Storage = {
    prepare(sql: string): Statement {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => stmt.run(...(params as never[])),
        get: <T>(...params: readonly unknown[]) => stmt.get(...(params as never[])) as T | undefined,
        all: <T>(...params: readonly unknown[]) => stmt.all(...(params as never[])) as T[],
        iterate: <T>(...params: readonly unknown[]) => stmt.iterate(...(params as never[])) as IterableIterator<T>,
      };
    },
    exec: (sql) => void db.exec(sql),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    userVersion: () => {
      const rows = db.pragma('user_version') as Array<{ user_version: number }>;
      return rows[0]?.user_version ?? 0;
    },
    setUserVersion: (version) => void db.pragma(`user_version = ${version}`),
    close: () => db.close(),
  };

  migrate(storage);
  return storage;
}

/**
 * Run every migration newer than the database's `user_version`.
 *
 * Each migration and its version bump commit together, so a crash halfway
 * through leaves the database on the last fully-applied version rather than
 * in a state the runner would skip over.
 */
export function migrate(storage: Storage): number {
  const from = storage.userVersion();
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    storage.transaction(() => {
      storage.exec(migration.sql);
      storage.setUserVersion(migration.version);
    });
  }
  return storage.userVersion();
}
