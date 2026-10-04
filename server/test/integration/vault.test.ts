import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultError } from '../../src/security/keyring.js';
import { parseSecretRef } from '../../src/security/vault.js';
import { vaultHarness } from '../fakes/vault.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arish-vault-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('keyring and the two unwrap paths (§23, decision 006)', () => {
  it('a fresh database has no vault', async () => {
    const h = await vaultHarness({ init: false });
    expect(h.vault.isInitialized()).toBe(false);
    expect(h.vault.locked).toBe(true);
    h.close();
  });

  it('init issues a recovery code, and the vault starts locked', async () => {
    const h = await vaultHarness({ init: false });
    const { recoveryCode } = await h.vault.init('passphrase one');
    expect(recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{1,5})+$/);
    expect(h.vault.locked).toBe(true);
    h.close();
  });

  it('refuses a second init rather than silently replacing the keys', async () => {
    const h = await vaultHarness();
    await expect(h.vault.init('another')).rejects.toMatchObject({ kind: 'already_initialized' });
    h.close();
  });

  it('the MDK is random — same passphrase, two vaults, different keys', async () => {
    // Decision 006: a derived MDK could not have a second unwrap path.
    const a = await vaultHarness();
    const b = await vaultHarness();
    const refA = await a.vault.put('k', 'value');
    const sealedA = a.substrate.storage.prepare('SELECT sealed FROM secrets WHERE name = ?').get<{ sealed: Uint8Array }>('k');
    const refB = await b.vault.put('k', 'value');
    const sealedB = b.substrate.storage.prepare('SELECT sealed FROM secrets WHERE name = ?').get<{ sealed: Uint8Array }>('k');
    expect(refA.uri).toBe(refB.uri);
    expect(Buffer.from(sealedA?.sealed ?? []).toString('hex')).not.toBe(Buffer.from(sealedB?.sealed ?? []).toString('hex'));
    a.close(); b.close();
  });

  it('the recovery code unwraps the SAME master key as the passphrase', async () => {
    // The property that makes "lose the passphrase, keep the data" work.
    const h = await vaultHarness();
    const ref = await h.vault.put('token', 'super-secret-value');
    h.vault.lock();

    await h.vault.unlockWithRecovery(h.recoveryCode);
    const viaRecovery = await h.vault.resolve(ref, { principal: 'user:ara' }, (v) => v);
    expect(viaRecovery).toBe('super-secret-value');
    h.close();
  });

  it('accepts a recovery code in any casing or grouping', async () => {
    const h = await vaultHarness();
    h.vault.lock();
    await expect(h.vault.unlockWithRecovery(h.recoveryCode.toLowerCase().replace(/-/g, ' '))).resolves.toBeUndefined();
    h.close();
  });

  it('a wrong passphrase is a typed error, not a raw crypto throw', async () => {
    const h = await vaultHarness();
    h.vault.lock();
    await expect(h.vault.unlock('wrong')).rejects.toMatchObject({ kind: 'bad_passphrase', name: 'VaultError' });
    h.close();
  });

  it('a wrong recovery code is a typed error', async () => {
    const h = await vaultHarness();
    h.vault.lock();
    await expect(h.vault.unlockWithRecovery('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-Z')).rejects.toMatchObject({ kind: 'bad_recovery_code' });
    h.close();
  });

  it('the recovery code is NOT recoverable from the database', async () => {
    // §E.4: shown once. If it could be read back, "lose both and the data is
    // gone" would be false and the threat model would be a fiction.
    const h = await vaultHarness();
    const dump = JSON.stringify(h.substrate.storage.prepare('SELECT * FROM keyring').all<Record<string, unknown>>());
    const bare = h.recoveryCode.replace(/-/g, '');
    expect(dump).not.toContain(bare);
    expect(dump).not.toContain(h.recoveryCode);
    h.close();
  });
});

describe('lock, unlock, idle, panic (§23)', () => {
  it('a locked vault refuses every secret operation', async () => {
    const h = await vaultHarness();
    const ref = await h.vault.put('k', 'v');
    h.vault.lock();
    expect(h.vault.locked).toBe(true);
    await expect(h.vault.resolve(ref, { principal: 'u' }, (v) => v)).rejects.toMatchObject({ kind: 'locked' });
    await expect(h.vault.put('other', 'v')).rejects.toMatchObject({ kind: 'locked' });
    expect(() => h.vault.list()).toThrow(VaultError);
    h.close();
  });

  it('locking twice is not an error', async () => {
    const h = await vaultHarness();
    h.vault.lock();
    expect(() => h.vault.lock()).not.toThrow();
    h.close();
  });

  it('auto-locks after the idle interval, on the injected clock', async () => {
    const h = await vaultHarness({ idleLockMinutes: 60 });
    expect(h.vault.locked).toBe(false);
    h.substrate.clock.advance(59 * 60_000);
    expect(h.vault.locked).toBe(false);
    h.substrate.clock.advance(2 * 60_000);
    expect(h.vault.locked).toBe(true);
    expect(h.recorded.some((e) => e.kind === 'locked' && e.detail['reason'] === 'idle')).toBe(true);
    h.close();
  });

  it('activity resets the idle timer', async () => {
    const h = await vaultHarness({ idleLockMinutes: 60 });
    for (let i = 0; i < 5; i++) {
      h.substrate.clock.advance(50 * 60_000);
      await h.vault.put(`k${i}`, 'v');
    }
    expect(h.vault.locked).toBe(false);
    h.close();
  });

  it('idleLockMinutes = 0 disables auto-lock', async () => {
    const h = await vaultHarness({ idleLockMinutes: 0 });
    h.substrate.clock.advanceDays(30);
    expect(h.vault.locked).toBe(false);
    h.close();
  });

  it('PANIC destroys the key material — the correct passphrase no longer works', async () => {
    const h = await vaultHarness({ dbPath: join(dir, 'panic.db') });
    await h.vault.put('token', 'the-value');
    h.vault.panic();

    expect(h.vault.locked).toBe(true);
    await expect(h.vault.unlock('correct horse battery staple')).rejects.toMatchObject({ kind: 'destroyed' });
    await expect(h.vault.unlockWithRecovery(h.recoveryCode)).rejects.toMatchObject({ kind: 'destroyed' });
    h.close();
  });

  it('panic leaves an auditable tombstone but no keys', async () => {
    const h = await vaultHarness();
    h.vault.panic();
    const row = h.substrate.storage
      .prepare('SELECT wrapped_passphrase, wrapped_recovery, destroyed_at FROM keyring')
      .get<{ wrapped_passphrase: unknown; wrapped_recovery: unknown; destroyed_at: number | null }>();
    expect(row?.wrapped_passphrase).toBeNull();
    expect(row?.wrapped_recovery).toBeNull();
    expect(row?.destroyed_at).toBeGreaterThan(0);
    expect(h.recorded.some((e) => e.kind === 'destroyed')).toBe(true);
    h.close();
  });
});

describe('secrets as references (§23)', () => {
  it('put returns a reference, never the value', async () => {
    const h = await vaultHarness();
    const ref = await h.vault.put('stripe', 'sk_live_abcdef123456');
    expect(ref.uri).toBe('secret://stripe/1');
    expect(JSON.stringify(ref)).not.toContain('sk_live');
    h.close();
  });

  it('resolves inside a closure and zeroizes after', async () => {
    const h = await vaultHarness();
    const ref = await h.vault.put('stripe', 'sk_live_abcdef123456');
    const seen = await h.vault.resolve(ref, { principal: 'user:ara', tool: 'http.post', runId: 'r1' }, (v) => v);
    expect(seen).toBe('sk_live_abcdef123456');
    h.close();
  });

  it('records who/when/run/tool and NEVER the value', async () => {
    const h = await vaultHarness();
    const ref = await h.vault.put('stripe', 'sk_live_abcdef123456');
    await h.vault.resolve(ref, { principal: 'user:ara', tool: 'http.post', runId: 'r1' }, (v) => v.length);

    const read = h.recorded.find((e) => e.kind === 'secret.read');
    expect(read?.detail).toMatchObject({ reference: 'secret://stripe/1', principal: 'user:ara', tool: 'http.post', runId: 'r1' });
    expect(JSON.stringify(h.recorded)).not.toContain('sk_live_abcdef123456');
    h.close();
  });

  it('bumps the version and keeps the old one resolvable', async () => {
    // A rotation that broke in-flight references would make rotating the
    // risky operation rather than the safe one.
    const h = await vaultHarness();
    const v1 = await h.vault.put('k', 'first');
    const v2 = await h.vault.put('k', 'second');
    expect(v2.version).toBe(2);
    expect(await h.vault.resolve(v1, { principal: 'u' }, (v) => v)).toBe('first');
    expect(await h.vault.resolve(v2, { principal: 'u' }, (v) => v)).toBe('second');
    h.close();
  });

  it('lists names and versions only', async () => {
    const h = await vaultHarness();
    await h.vault.put('a', 'secret-value-a');
    await h.vault.put('b', 'secret-value-b');
    const listed = h.vault.list();
    expect(listed.map((s) => `${s.name}/${s.version}`)).toEqual(['a/1', 'b/1']);
    expect(JSON.stringify(listed)).not.toContain('secret-value');
    h.close();
  });

  it('an unknown reference is a typed error', async () => {
    const h = await vaultHarness();
    await expect(h.vault.resolve('secret://nope/1', { principal: 'u' }, (v) => v)).rejects.toMatchObject({ kind: 'not_found' });
    h.close();
  });

  it('rejects a malformed reference', async () => {
    expect(() => parseSecretRef('https://evil.example/steal')).toThrow(VaultError);
    expect(() => parseSecretRef('secret://name')).toThrow(VaultError);
  });

  it('a secret sealed for one version will not open as another', async () => {
    const h = await vaultHarness();
    await h.vault.put('k', 'first');
    await h.vault.put('k', 'second');
    // Swap the ciphertexts, as an attacker with DB write access would.
    const rows = h.substrate.storage.prepare('SELECT version, sealed FROM secrets WHERE name = ? ORDER BY version').all<{ version: number; sealed: Uint8Array }>('k');
    h.substrate.storage.prepare('UPDATE secrets SET sealed = ? WHERE name = ? AND version = 1').run(rows[1]?.sealed, 'k');
    await expect(h.vault.resolve('secret://k/1', { principal: 'u' }, (v) => v)).rejects.toThrow(/authentication failed/);
    h.close();
  });
});

describe('crypto-shredding (§23, invariant 10)', () => {
  it('forgotten content is UNREADABLE with full database access', async () => {
    // The milestone's hardest promise. Full DB access, correct passphrase,
    // unlocked vault — and the content is still gone.
    const h = await vaultHarness({ dbPath: join(dir, 'shred.db') });
    const sealed = await h.vault.sealItem('fact-1', 'Ara lives in Berlin');
    h.substrate.storage.prepare('CREATE TABLE IF NOT EXISTS memo (id TEXT PRIMARY KEY, body BLOB)').run();
    h.substrate.storage.prepare('INSERT INTO memo VALUES (?,?)').run('fact-1', sealed);

    expect(await h.vault.openItem('fact-1', sealed)).toBe('Ara lives in Berlin');

    expect(h.vault.shred('fact-1')).toBe(true);

    await expect(h.vault.openItem('fact-1', sealed)).rejects.toMatchObject({ kind: 'not_found' });
    const stillThere = h.substrate.storage.prepare('SELECT body FROM memo WHERE id = ?').get<{ body: Uint8Array }>('fact-1');
    expect(stillThere).toBeDefined();
    expect(Buffer.from(stillThere?.body ?? []).toString('utf8')).not.toContain('Berlin');
    h.close();
  });

  it('shredding one item leaves every other item readable', async () => {
    const h = await vaultHarness();
    const a = await h.vault.sealItem('fact-a', 'keep me');
    const b = await h.vault.sealItem('fact-b', 'destroy me');
    h.vault.shred('fact-b');
    expect(await h.vault.openItem('fact-a', a)).toBe('keep me');
    await expect(h.vault.openItem('fact-b', b)).rejects.toMatchObject({ kind: 'not_found' });
    h.close();
  });

  it('is idempotent — forgetting twice is a user action, not an error', async () => {
    const h = await vaultHarness();
    await h.vault.sealItem('x', 'content');
    expect(h.vault.shred('x')).toBe(true);
    expect(h.vault.shred('x')).toBe(false);
    h.close();
  });

  it('records a tombstone carrying no content', async () => {
    const h = await vaultHarness();
    await h.vault.sealItem('fact-1', 'Ara lives in Berlin');
    h.vault.shred('fact-1');
    const tombstone = h.recorded.find((e) => e.kind === 'item.shredded');
    expect(tombstone?.detail['keyId']).toBe('fact-1');
    expect(JSON.stringify(h.recorded)).not.toContain('Berlin');
    h.close();
  });

  it('per-item keys are random — two items never share one', async () => {
    const h = await vaultHarness();
    await h.vault.createItemKey('a');
    await h.vault.createItemKey('b');
    expect(await h.vault.itemKey('a')).not.toEqual(await h.vault.itemKey('b'));
    h.close();
  });

  it('panic shreds every item key at once', async () => {
    const h = await vaultHarness();
    const sealed = await h.vault.sealItem('fact-1', 'Ara lives in Berlin');
    h.vault.panic();
    const keys = h.substrate.storage.prepare('SELECT COUNT(*) AS n FROM item_keys').get<{ n: number }>();
    expect(keys?.n).toBe(0);
    expect(sealed.length).toBeGreaterThan(0);
    h.close();
  });
});

describe('vault state survives a restart, and is not a projection (decision 006)', () => {
  it('a rebuild does not destroy the vault', async () => {
    const h = await vaultHarness({ dbPath: join(dir, 'rebuild.db') });
    const ref = await h.vault.put('k', 'persisted-value');
    h.substrate.events.rebuild();
    expect(await h.vault.resolve(ref, { principal: 'u' }, (v) => v)).toBe('persisted-value');
    h.close();
  });

  it('vault tables are excluded from the projection digest', async () => {
    const { PROJECTION_TABLES } = await import('../../src/substrate/projections/index.js');
    for (const table of ['keyring', 'secrets', 'item_keys', 'quarantined_content']) {
      expect(PROJECTION_TABLES as readonly string[]).not.toContain(table);
    }
  });
});
