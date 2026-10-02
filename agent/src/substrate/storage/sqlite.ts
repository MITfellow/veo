import Database from 'better-sqlite3';
import type { RunResult, SqlParams, SqlValue, Storage } from '../ports.js';

export interface SqliteOptions {
  /** `:memory:` for tests, a path for real life. */
  path?: string;
  readonly?: boolean;
}

/**
 * The SQLite adapter.
 *
 * Synchronous on purpose. The event log appends and the projections it drives
 * have to commit in one transaction, and an async driver makes that an
 * interleaving problem at every call site. `better-sqlite3` also gives us real
 * `IMMEDIATE` transactions, which is what prevents two writers from racing into
 * the same `seq`.
 */
export class SqliteStorage implements Storage {
  private readonly db: Database.Database;
  private depth = 0;

  constructor(options: SqliteOptions = {}) {
    const path = options.path ?? ':memory:';
    this.db = new Database(path, options.readonly === true ? { readonly: true } : {});

    if (options.readonly !== true) {
      // WAL: readers never block the writer, and a crash mid-write rolls back
      // cleanly — invariant 3 says the process may die at any instruction.
      this.db.pragma('journal_mode = WAL');
      // FULL rather than NORMAL. NORMAL can lose the last transactions on power
      // loss; for a log that claims to be the only source of truth, a lost tail
      // is a lost memory. The cost is one fsync per commit.
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  all<T>(sql: string, params?: SqlParams): T[] {
    return this.db.prepare(sql).all(...bind(params)) as T[];
  }

  get<T>(sql: string, params?: SqlParams): T | undefined {
    return this.db.prepare(sql).get(...bind(params)) as T | undefined;
  }

  run(sql: string, params?: SqlParams): RunResult {
    const info = this.db.prepare(sql).run(...bind(params));
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  /**
   * Nested calls join the outer transaction rather than opening a savepoint.
   * The log's append already runs projectors inside its own transaction; if a
   * projector opened a nested one that could commit independently, a projection
   * could outlive the event that caused it — which is invariant 1 broken.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }

    this.db.prepare('BEGIN IMMEDIATE').run();
    this.depth = 1;
    try {
      const result = fn();
      this.db.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try {
        this.db.prepare('ROLLBACK').run();
      } catch {
        // Rollback can fail if the transaction is already gone; the original
        // error is the one worth reporting.
      }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  inTransaction(): boolean {
    return this.depth > 0;
  }

  close(): void {
    this.db.close();
  }

  /** Escape hatch for maintenance (`VACUUM`, integrity checks) — not for kernel code. */
  raw(): Database.Database {
    return this.db;
  }
}

function bind(params?: SqlParams): [] | [Record<string, SqlValue>] | SqlValue[] {
  if (params === undefined) return [];
  return Array.isArray(params) ? params : [params];
}
