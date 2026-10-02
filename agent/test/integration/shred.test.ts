import { describe, expect, it } from 'vitest';
import { DecryptionError } from '../../src/security/crypto.js';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

const PASS = 'a passphrase long enough';
const CONTENT = 'Ara is being treated for a condition she has told nobody about';

async function unlocked() {
  const substrate = createTestSubstrate();
  const security = createTestSecurity(substrate);
  await security.keyring.initialize(PASS);
  await security.keyring.unlock(PASS);
  substrate.storage.exec('CREATE TABLE memo (id TEXT PRIMARY KEY, body BLOB NOT NULL)');
  return { substrate, security };
}

describe('crypto-shredding', () => {
  it('makes an encrypted item unreadable, and the ciphertext is gone too', async () => {
    const { security, substrate } = await unlocked();

    const sealed = await security.cipher.encrypt('fact-7', CONTENT);
    substrate.storage.run('INSERT INTO memo (id, body) VALUES (?, ?)', ['fact-7', sealed]);
    expect(await security.cipher.decryptText('fact-7', sealed)).toBe(CONTENT);

    security.shredder.shred('fact-7', {
      principal: 'user:ara',
      reason: 'she asked me to forget it',
      ciphertextLocations: [{ table: 'memo', column: 'body', idColumn: 'id', id: 'fact-7' }],
    });

    // Even holding the original ciphertext in hand, it will not decrypt.
    await expect(security.cipher.decryptText('fact-7', sealed)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const row = substrate.storage.get<{ body: Uint8Array }>('SELECT body FROM memo WHERE id = ?', [
      'fact-7',
    ]);
    expect(row?.body.length).toBe(0);
    substrate.close();
  });

  it('is indistinguishable from a cryptographic failure, so forgetting is uniform', async () => {
    const { security, substrate } = await unlocked();
    const sealed = await security.cipher.encrypt('fact-8', CONTENT);
    security.shredder.shred('fact-8', { principal: 'user:ara', reason: 'forget' });

    // A caller must not be able to tell "forgotten" from "unreadable" and
    // handle them differently — invariant 8 is honored everywhere, uniformly.
    const forgotten = await security.cipher.decrypt('fact-8', sealed).catch((e: unknown) => e);
    const corrupt = await security.cipher
      .decrypt('fact-9', new Uint8Array(40))
      .catch((e: unknown) => e);
    expect((forgotten as Error).message).toBe((corrupt as Error).message);
    substrate.close();
  });

  it('records an auditable tombstone', async () => {
    const { security, substrate } = await unlocked();
    security.shredder.shred('fact-10', { principal: 'user:ara', reason: 'too personal' });

    const tombstone = security.shredder.tombstone('fact-10');
    expect(tombstone?.reason).toBe('too personal');
    expect(tombstone?.eventId).toBeTypeOf('string');

    const [event] = substrate.events.read({ types: ['memory.forgotten'] });
    expect(event?.payload).toMatchObject({ keyId: 'fact-10', shredded: true });
    substrate.close();
  });

  it('is idempotent — a crash-retry must be safe', async () => {
    const { security, substrate } = await unlocked();
    const first = security.shredder.shred('fact-11', { principal: 'user:ara', reason: 'r' });
    const second = security.shredder.shred('fact-11', { principal: 'user:ara', reason: 'r' });
    expect(second).toEqual(first);
    expect(substrate.events.read({ types: ['memory.forgotten'] })).toHaveLength(1);
    substrate.close();
  });

  it('cannot be undone — the tombstone is append-only', async () => {
    const { security, substrate } = await unlocked();
    security.shredder.shred('fact-12', { principal: 'user:ara', reason: 'r' });
    expect(() =>
      substrate.storage.run('DELETE FROM shred_tombstones WHERE item_id = ?', ['fact-12']),
    ).toThrow(/forgetting is permanent/);
    expect(() =>
      substrate.storage.run("UPDATE shred_tombstones SET reason = 'x' WHERE item_id = ?", [
        'fact-12',
      ]),
    ).toThrow(/cannot be altered/);
    substrate.close();
  });

  it('refuses to encrypt new content under a shredded id', async () => {
    const { security, substrate } = await unlocked();
    security.shredder.shred('fact-13', { principal: 'user:ara', reason: 'r' });
    // Otherwise "forget it" followed by "remember it again" would quietly
    // resurrect the same key for the same id.
    await expect(security.cipher.encrypt('fact-13', 'new content')).rejects.toBeInstanceOf(
      DecryptionError,
    );
    substrate.close();
  });

  it('stays shredded after the keyring is locked and unlocked again', async () => {
    const { security, substrate } = await unlocked();
    const sealed = await security.cipher.encrypt('fact-14', CONTENT);
    security.shredder.shred('fact-14', { principal: 'user:ara', reason: 'r' });

    security.keyring.lock();
    await security.keyring.unlock(PASS);

    await expect(security.cipher.decrypt('fact-14', sealed)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    substrate.close();
  });

  it('the plaintext appears nowhere in the database after a shred (full DB access)', async () => {
    const { security, substrate } = await unlocked();
    const sealed = await security.cipher.encrypt('fact-15', CONTENT);
    substrate.storage.run('INSERT INTO memo (id, body) VALUES (?, ?)', ['fact-15', sealed]);
    security.shredder.shred('fact-15', {
      principal: 'user:ara',
      reason: 'sensitive',
      ciphertextLocations: [{ table: 'memo', column: 'body', idColumn: 'id', id: 'fact-15' }],
    });

    const tables = substrate.storage.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const { name } of tables) {
      for (const row of substrate.storage.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        for (const v of Object.values(row)) {
          const text = v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v ?? '');
          expect(text, `plaintext survived in ${name}`).not.toContain('condition she has told');
        }
      }
    }
    substrate.close();
  });

  it('panic makes every item unrecoverable at once', async () => {
    const { security, substrate } = await unlocked();
    const sealed = await security.cipher.encrypt('fact-16', CONTENT);
    security.keyring.panic();
    // Not even with the correct passphrase.
    await expect(security.keyring.unlock(PASS)).rejects.toThrow(/destroyed/);
    await expect(security.cipher.decrypt('fact-16', sealed)).rejects.toThrow();
    substrate.close();
  });
});
