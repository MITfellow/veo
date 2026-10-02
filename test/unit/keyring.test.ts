import { describe, expect, it } from 'vitest';
import { KeyringError, LockedError, normalizeRecoveryCode } from '../../src/security/keyring.js';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

const PASS = 'a passphrase long enough';

function setup(seed = 1) {
  const substrate = createTestSubstrate();
  const security = createTestSecurity(substrate, seed);
  return { substrate, security };
}

describe('keyring lifecycle', () => {
  it('initializes, locks and unlocks', async () => {
    const { security, substrate } = setup();
    expect(security.keyring.state()).toBe('uninitialized');

    const { recoveryCode } = await security.keyring.initialize(PASS);
    expect(recoveryCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    expect(security.keyring.state()).toBe('locked');

    await security.keyring.unlock(PASS);
    expect(security.keyring.state()).toBe('unlocked');

    security.keyring.lock();
    expect(security.keyring.state()).toBe('locked');
    substrate.close();
  });

  it('refuses a second initialization', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await expect(security.keyring.initialize(PASS)).rejects.toThrow(/already initialized/);
    substrate.close();
  });

  it('requires a passphrase with real length', async () => {
    const { security, substrate } = setup();
    await expect(security.keyring.initialize('short')).rejects.toThrow(/at least 12/);
    substrate.close();
  });

  it('fails a wrong passphrase without revealing why', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await expect(security.keyring.unlock('the wrong passphrase')).rejects.toThrow(
      /could not unlock/,
    );
    // Not "wrong passphrase" and not "corrupt wrap" — those distinctions are
    // an oracle and the user cannot act on them anyway.
    expect(security.keyring.isUnlocked()).toBe(false);
    substrate.close();
  });
});

describe('what reaches the disk', () => {
  it('never persists the Root Key or the MDK in the clear', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);

    // The only key material legitimately reachable: derive one and prove it
    // appears nowhere on disk.
    const itemKey = await security.keyring.itemKey('probe');
    const indexKey = security.keyring.getIndexKey();

    const tables = substrate.storage.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    let dump = '';
    for (const { name } of tables) {
      for (const row of substrate.storage.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        for (const value of Object.values(row)) {
          dump +=
            value instanceof Uint8Array
              ? Buffer.from(value).toString('hex')
              : String(value ?? '');
          dump += '\u0000';
        }
      }
    }

    expect(dump).not.toContain(Buffer.from(itemKey).toString('hex'));
    expect(dump).not.toContain(Buffer.from(indexKey).toString('hex'));
    expect(dump).not.toContain(PASS);
    substrate.close();
  });

  it('stores the MDK only as two wrapped blobs', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    const row = substrate.storage.get<Record<string, unknown>>('SELECT * FROM keyring');
    expect(row?.passphrase_wrap).toBeInstanceOf(Uint8Array);
    expect(row?.recovery_wrap).toBeInstanceOf(Uint8Array);
    // AES-GCM over a 32-byte key = 12 nonce + 32 ct + 16 tag.
    expect((row?.passphrase_wrap as Uint8Array).length).toBe(60);
    // No column anywhere named like a key.
    expect(Object.keys(row ?? {}).some((k) => /(^|_)key$/.test(k))).toBe(false);
    substrate.close();
  });
});

describe('the recovery code', () => {
  it('unwraps the same MDK as the passphrase', async () => {
    const { security, substrate } = setup();
    const { recoveryCode } = await security.keyring.initialize(PASS);

    await security.keyring.unlock(PASS);
    const viaPassphrase = Buffer.from(await security.keyring.itemKey('item-1')).toString('hex');
    security.keyring.lock();

    await security.keyring.unlockWithRecoveryCode(recoveryCode);
    const viaRecovery = Buffer.from(await security.keyring.itemKey('item-1')).toString('hex');

    expect(viaRecovery).toBe(viaPassphrase);
    substrate.close();
  });

  it('is accepted however the user transcribes it off paper', async () => {
    const { security, substrate } = setup();
    const { recoveryCode } = await security.keyring.initialize(PASS);
    const mangled = recoveryCode.toLowerCase().replace(/-/g, ' ');
    await security.keyring.unlockWithRecoveryCode(mangled);
    expect(security.keyring.isUnlocked()).toBe(true);
    substrate.close();
  });

  it('normalizes the characters people confuse', () => {
    expect(normalizeRecoveryCode('o0-il1-u v')).toBe('00111VV');
  });

  it('rejects a wrong recovery code', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await expect(security.keyring.unlockWithRecoveryCode('AAAAA-BBBBB-CCCCC')).rejects.toThrow(
      /could not unlock/,
    );
    substrate.close();
  });
});

describe('rotation', () => {
  it('changes the passphrase without touching the data keys', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);
    const before = Buffer.from(await security.keyring.itemKey('memory-42')).toString('hex');
    security.keyring.lock();

    await security.keyring.rotatePassphrase(PASS, 'an entirely new passphrase');
    await security.keyring.unlock('an entirely new passphrase');
    const after = Buffer.from(await security.keyring.itemKey('memory-42')).toString('hex');

    // Same MDK ⇒ every encrypted memory is still readable. Rotation must not
    // be an outage on a database with years of data in it.
    expect(after).toBe(before);
    await expect(security.keyring.unlock(PASS)).rejects.toThrow(/could not unlock/);
    substrate.close();
  });

  it('refuses rotation with the wrong current passphrase', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await expect(
      security.keyring.rotatePassphrase('not the passphrase', 'another good passphrase'),
    ).rejects.toThrow(/could not unlock/);
    substrate.close();
  });
});

describe('lock and panic', () => {
  it('lock makes key material unreachable', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);
    security.keyring.lock();

    await expect(security.keyring.itemKey('x')).rejects.toBeInstanceOf(LockedError);
    expect(() => security.keyring.getIndexKey()).toThrow(LockedError);
    substrate.close();
  });

  it('panic makes the data unrecoverable even with the correct passphrase', async () => {
    const { security, substrate } = setup();
    const { recoveryCode } = await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);

    security.keyring.panic();

    await expect(security.keyring.unlock(PASS)).rejects.toThrow(/destroyed/);
    await expect(security.keyring.unlockWithRecoveryCode(recoveryCode)).rejects.toThrow(
      /destroyed/,
    );
    const row = substrate.storage.get<Record<string, unknown>>('SELECT * FROM keyring');
    expect(row?.passphrase_wrap).toBeNull();
    expect(row?.recovery_wrap).toBeNull();
    expect(row?.panicked_at).toBeTypeOf('number');
    substrate.close();
  });
});

describe('derived keys', () => {
  it('gives every item a different key', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);
    const a = Buffer.from(await security.keyring.itemKey('fact-1')).toString('hex');
    const b = Buffer.from(await security.keyring.itemKey('fact-2')).toString('hex');
    expect(a).not.toBe(b);
    substrate.close();
  });

  it('keeps the index key stable across unlocks, so blind indexes keep working', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);
    const first = Buffer.from(security.keyring.getIndexKey()).toString('hex');
    security.keyring.lock();
    await security.keyring.unlock(PASS);
    expect(Buffer.from(security.keyring.getIndexKey()).toString('hex')).toBe(first);
    substrate.close();
  });

  it('refuses an empty item id', async () => {
    const { security, substrate } = setup();
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);
    await expect(security.keyring.itemKey('')).rejects.toThrow(/item id/);
    substrate.close();
  });

  it('reports an uninitialized keyring clearly', async () => {
    const { security, substrate } = setup();
    await expect(security.keyring.unlock(PASS)).rejects.toBeInstanceOf(KeyringError);
    substrate.close();
  });
});
