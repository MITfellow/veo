import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural containment (§21.5, §23, §59.9).
 *
 * The other adversarial suites prove the security layer behaves. This one
 * proves nobody can route around it. It reads the source tree, because the
 * threat is not a bug in `vault.ts` — it is a future file, written in M6 by
 * someone in a hurry, that imports the raw-bytes path directly and is
 * perfectly correct on its own terms.
 *
 * ESLint enforces the *layer* rule. This enforces the *secrecy* rule, which
 * is narrower and more important: there is exactly one door to plaintext.
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, 'utf8') }));

const inSecurity = (p: string): boolean => p.startsWith('src/security/');

const SECRET_TABLES = ['secrets', 'keyring', 'item_keys', 'quarantined_content'] as const;

/** `FROM secrets`, `INTO keyring`, `DELETE FROM item_keys`, in any case. */
const queryRegex = (table: string): RegExp =>
  new RegExp(`(FROM|INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i');

describe('there is exactly one door to plaintext', () => {
  it('finds a source tree to check (guards against a vacuous pass)', () => {
    // A structural test that silently scans nothing is worse than no test.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.path === 'src/security/vault.ts')).toBe(true);
  });

  it('the detector actually detects (negative control)', () => {
    // Without this, a typo in the regex turns the next test into a no-op
    // that passes forever. The control is the test's own test.
    expect(queryRegex('secrets').test("SELECT * FROM secrets WHERE name = ?")).toBe(true);
    expect(queryRegex('keyring').test("insert into keyring (id) values (?)")).toBe(true);
    expect(queryRegex('item_keys').test('DELETE FROM item_keys WHERE key_id = ?')).toBe(true);
    expect(queryRegex('secrets').test('SELECT * FROM events')).toBe(false);
    // And it fires on the real file that legitimately does this.
    const vault = FILES.find((f) => f.path === 'src/security/vault.ts');
    expect(queryRegex('secrets').test(vault?.text ?? '')).toBe(true);
  });

  it('no file outside src/security reads the secrets or keyring tables', () => {
    for (const file of FILES) {
      if (inSecurity(file.path)) continue;
      // Allow the migration that *creates* them; forbid anyone querying them.
      if (file.path === 'src/substrate/storage/migrations.ts') continue;
      for (const table of SECRET_TABLES) {
        expect(queryRegex(table).test(file.text), `${file.path} queries '${table}' directly`).toBe(false);
      }
    }
  });

  it('no file outside src/security imports the crypto primitives', () => {
    // box.ts and kdf.ts are the raw-bytes layer. Everything else goes
    // through the vault, which owns the policy around them.
    for (const file of FILES) {
      if (inSecurity(file.path)) continue;
      for (const primitive of ['security/box.js', 'security/kdf.js', 'security/keyring.js']) {
        expect(file.text.includes(primitive), `${file.path} imports ${primitive}`).toBe(false);
      }
    }
  });

  it('the quarantined content table is touched only by quarantine.ts', () => {
    for (const file of FILES) {
      if (file.path === 'src/security/quarantine.ts') continue;
      if (file.path === 'src/substrate/storage/migrations.ts') continue;
      expect(file.text.includes('quarantined_content'), `${file.path}`).toBe(false);
    }
  });
});

describe('the durable secret tables are never projected', () => {
  it('PROJECTION_TABLES excludes every table a rebuild would destroy', async () => {
    // Decision 006. A rebuild drops projections; if the vault were listed
    // here, `arish rebuild` would be indistinguishable from `panic`.
    const { PROJECTION_TABLES } = await import('../../src/substrate/projections/index.js');
    for (const table of SECRET_TABLES) {
      expect(PROJECTION_TABLES as readonly string[]).not.toContain(table);
    }
  });
});

describe('no plaintext escape hatches were left behind', () => {
  it('SymbolicRef carries no accessor', () => {
    const ref = FILES.find((f) => f.path === 'src/security/quarantine.ts');
    expect(ref).toBeDefined();
    const iface = ref?.text.match(/export interface SymbolicRef \{[^}]*\}/)?.[0] ?? '';
    expect(iface).not.toContain('content');
    expect(iface).not.toContain('deref');
    expect(iface).not.toContain('()');
  });

  it('nothing in src disables a security check with a TODO or an escape comment', () => {
    for (const file of FILES) {
      if (!inSecurity(file.path)) continue;
      expect(file.text).not.toContain('eslint-disable');
      expect(file.text.toLowerCase()).not.toMatch(/todo:?\s*(security|encrypt|auth)/);
    }
  });
});
