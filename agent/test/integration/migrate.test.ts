import { describe, expect, it } from 'vitest';
import { NodeHashing } from '../../src/substrate/hash.js';
import { SqliteStorage } from '../../src/substrate/storage/sqlite.js';
import { MIGRATIONS, migrate } from '../../src/substrate/storage/migrate.js';

const hashing = new NodeHashing();
const sha = (s: string): string => hashing.sha256Hex(s);

describe('schema migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    const first = migrate(storage, sha, 0);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));

    const second = migrate(storage, sha, 1);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(first.currentVersion);
    storage.close();
  });

  it('refuses to run if an applied migration was edited afterwards', () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    migrate(storage, sha, 0, [{ version: 1, name: 'x', sql: 'CREATE TABLE a (id TEXT)' }]);
    expect(() =>
      migrate(storage, sha, 1, [{ version: 1, name: 'x', sql: 'CREATE TABLE a (id TEXT, b TEXT)' }]),
    ).toThrow(/was modified after being applied/);
    storage.close();
  });

  it('rolls a failing migration back entirely', () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    expect(() =>
      migrate(storage, sha, 0, [
        { version: 1, name: 'bad', sql: 'CREATE TABLE ok (id TEXT); CREATE TABLE ok (id TEXT);' },
      ]),
    ).toThrow();
    const tables = storage.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ok'",
    );
    expect(tables).toHaveLength(0);
    storage.close();
  });
});

describe('transactions', () => {
  it('rolls back everything on a throw', () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(() =>
      storage.transaction(() => {
        storage.run('INSERT INTO t (id) VALUES (1)');
        throw new Error('nope');
      }),
    ).toThrow(/nope/);
    expect(storage.get<{ n: number }>('SELECT COUNT(*) n FROM t')?.n).toBe(0);
    storage.close();
  });

  it('joins a nested transaction to the outer one rather than committing early', () => {
    const storage = new SqliteStorage({ path: ':memory:' });
    storage.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(() =>
      storage.transaction(() => {
        storage.run('INSERT INTO t (id) VALUES (1)');
        storage.transaction(() => {
          storage.run('INSERT INTO t (id) VALUES (2)');
        });
        throw new Error('outer failure');
      }),
    ).toThrow(/outer failure/);
    // The inner insert must not have survived the outer rollback.
    expect(storage.get<{ n: number }>('SELECT COUNT(*) n FROM t')?.n).toBe(0);
    storage.close();
  });
});
