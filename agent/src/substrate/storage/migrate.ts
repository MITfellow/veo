import type { Storage } from '../ports.js';
import { SCHEMA_001 } from './schema/001-init.js';
import { SCHEMA_002 } from './schema/002-security.js';
import { SCHEMA_003 } from './schema/003-steps.js';
import { SCHEMA_004 } from './schema/004-effects.js';
import { SCHEMA_005 } from './schema/005-artifacts.js';
import { SCHEMA_006 } from './schema/006-approvals.js';
import { SCHEMA_007 } from './schema/007-memory.js';
import { SCHEMA_008 } from './schema/008-fact-principal.js';
import { SCHEMA_009 } from './schema/009-constitution.js';
import { SCHEMA_010 } from './schema/010-calibration.js';
import { SCHEMA_011 } from './schema/011-scheduling.js';
import { SCHEMA_012 } from './schema/012-persona.js';
import { SCHEMA_013 } from './schema/013-fact-subject-index.js';
import { SCHEMA_014 } from './schema/014-calendar.js';
import { SCHEMA_015 } from './schema/015-messages-fts.js';
import { SCHEMA_016 } from './schema/016-tasks.js';

/**
 * Schema migrations.
 *
 * Forward-only, numbered, each in a transaction, recorded in `schema_migrations`
 * with the hash of the SQL that ran. The hash check catches the failure mode
 * that actually bites: someone edits an already-applied migration, it silently
 * does nothing on existing databases, and dev and prod diverge for months.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'init', sql: SCHEMA_001 },
  { version: 2, name: 'security', sql: SCHEMA_002 },
  { version: 3, name: 'steps', sql: SCHEMA_003 },
  { version: 4, name: 'effects', sql: SCHEMA_004 },
  { version: 5, name: 'artifacts-widen', sql: SCHEMA_005 },
  { version: 6, name: 'approvals', sql: SCHEMA_006 },
  { version: 7, name: 'memory', sql: SCHEMA_007 },
  { version: 8, name: 'fact-principal', sql: SCHEMA_008 },
  { version: 9, name: 'constitution', sql: SCHEMA_009 },
  { version: 10, name: 'calibration', sql: SCHEMA_010 },
  { version: 11, name: 'scheduling', sql: SCHEMA_011 },
  { version: 12, name: 'persona', sql: SCHEMA_012 },
  { version: 13, name: 'fact-subject-index', sql: SCHEMA_013 },
  { version: 14, name: 'calendar', sql: SCHEMA_014 },
  { version: 15, name: 'messages-fts', sql: SCHEMA_015 },
  { version: 16, name: 'tasks', sql: SCHEMA_016 },
]);

export interface MigrationRow {
  version: number;
  name: string;
  applied_at: number;
  checksum: string;
}

export interface MigrateResult {
  applied: number[];
  currentVersion: number;
}

export function migrate(
  storage: Storage,
  hashSql: (s: string) => string,
  now: number,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  storage.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum   TEXT NOT NULL
    );
  `);

  const applied = new Map(
    storage
      .all<MigrationRow>('SELECT version, name, applied_at, checksum FROM schema_migrations')
      .map((r) => [r.version, r]),
  );

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const ran: number[] = [];

  for (const m of ordered) {
    const checksum = hashSql(m.sql);
    const prior = applied.get(m.version);

    if (prior) {
      if (prior.checksum !== checksum) {
        throw new Error(
          `migration ${m.version} (${m.name}) was modified after being applied — ` +
            `add a new migration instead of editing history`,
        );
      }
      continue;
    }

    storage.transaction(() => {
      storage.exec(m.sql);
      storage.run(
        `INSERT INTO schema_migrations (version, name, applied_at, checksum)
         VALUES (?, ?, ?, ?)`,
        [m.version, m.name, now, checksum],
      );
    });
    ran.push(m.version);
  }

  const current = storage.get<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );

  return { applied: ran, currentVersion: current?.v ?? 0 };
}
