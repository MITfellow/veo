import { describe, expect, it } from 'vitest';
import { LockedError, VaultError, parseSecretRef } from '../../src/security/index.js';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

const PASS = 'a passphrase long enough';
const API_KEY = 'sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c';

async function unlocked() {
  const substrate = createTestSubstrate();
  const security = createTestSecurity(substrate);
  await security.keyring.initialize(PASS);
  await security.keyring.unlock(PASS);
  return { substrate, security };
}

function dumpEverything(storage: ReturnType<typeof createTestSubstrate>['storage']): string {
  const tables = storage.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  let dump = '';
  for (const { name } of tables) {
    for (const row of storage.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
      for (const v of Object.values(row)) {
        dump += v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v ?? '');
        dump += '\u0000';
      }
    }
  }
  return dump;
}

describe('creating secrets', () => {
  it('returns a reference and never the value', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    expect(ref.ref).toBe('secret://openai/1');
    expect(JSON.stringify(ref)).not.toContain(API_KEY);
    expect(parseSecretRef(ref.ref)).toMatchObject({ name: 'openai', version: 1 });
    substrate.close();
  });

  it('keeps the value out of the event that records the creation', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    const events = substrate.events.read({ types: ['vault.secret.created'] });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(API_KEY);
    expect(events[0]?.payload).toEqual({ name: 'openai', version: 1 });
    substrate.close();
  });

  it('stores only ciphertext — the plaintext is nowhere in the database', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    expect(dumpEverything(substrate.storage)).not.toContain(API_KEY);
    substrate.close();
  });

  it('refuses a duplicate name and an invalid name', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    await expect(security.vault.create('openai', 'other', { principal: 'user:ara' })).rejects.toThrow(
      /already exists/,
    );
    await expect(security.vault.create('bad name!', 'x', { principal: 'user:ara' })).rejects.toThrow(
      VaultError,
    );
    substrate.close();
  });

  it('refuses to write while locked', async () => {
    const { security, substrate } = await unlocked();
    security.keyring.lock();
    await expect(security.vault.create('openai', API_KEY, { principal: 'user:ara' })).rejects.toBeInstanceOf(
      LockedError,
    );
    substrate.close();
  });
});

describe('using a secret', () => {
  it('yields the value to the callback and zeroizes it afterwards', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    let captured: Uint8Array | null = null;
    const result = await security.vault.useSecret(ref, { principal: 'user:ara' }, (value) => {
      captured = value;
      return new TextDecoder().decode(value);
    });

    expect(result).toBe(API_KEY);
    // The buffer the callback saw has been wiped — holding a reference past
    // the callback gets you zeroes, which is the point.
    expect(captured).not.toBeNull();
    expect([...(captured as unknown as Uint8Array)].every((b) => b === 0)).toBe(true);
    substrate.close();
  });

  it('zeroizes even when the callback throws', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    let captured: Uint8Array | null = null;

    await expect(
      security.vault.useSecret(ref, { principal: 'user:ara' }, (value) => {
        captured = value;
        throw new Error('the tool blew up');
      }),
    ).rejects.toThrow('the tool blew up');

    expect([...(captured as unknown as Uint8Array)].every((b) => b === 0)).toBe(true);
    substrate.close();
  });

  it('audits every read with who, when and which tool — never the value', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    await security.vault.useSecret(
      ref,
      { principal: 'user:ara', tool: 'http', runId: 'run-7', stepId: 'step-2' },
      () => 'done',
    );

    const [read] = substrate.events.read({ types: ['vault.secret.read'] });
    expect(read?.payload).toEqual({ ref: 'secret://openai/1', tool: 'http' });
    expect(read?.runId).toBe('run-7');
    expect(read?.stepId).toBe('step-2');
    expect(JSON.stringify(read)).not.toContain(API_KEY);
    substrate.close();
  });

  it('registers the value with the redactor, so a later leak into an event is stripped', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });

    await security.vault.useSecret(ref, { principal: 'user:ara' }, () => undefined);

    // A careless caller logs the key into an event payload after the fact.
    substrate.events.append({
      type: 'error.raised',
      payload: { kind: 'oops', message: `request failed with key ${API_KEY}`, fatal: false },
      principal: 'system',
      trust: 'SYSTEM',
    });

    const [err] = substrate.events.read({ types: ['error.raised'] });
    expect(JSON.stringify(err?.payload)).not.toContain(API_KEY);
    expect(JSON.stringify(err?.payload)).toContain('[REDACTED:openai]');
    substrate.close();
  });

  it('counts reads for the audit trail', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    await security.vault.useSecret(ref, { principal: 'user:ara' }, () => undefined);
    await security.vault.useSecret(ref, { principal: 'user:ara' }, () => undefined);
    expect(security.vault.list()[0]?.readCount).toBe(2);
    substrate.close();
  });

  it('refuses to read while locked', async () => {
    const { security, substrate } = await unlocked();
    const ref = await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    security.keyring.lock();
    await expect(
      security.vault.useSecret(ref, { principal: 'user:ara' }, () => undefined),
    ).rejects.toBeInstanceOf(LockedError);
    substrate.close();
  });

  it('refuses an unknown reference', async () => {
    const { security, substrate } = await unlocked();
    await expect(
      security.vault.useSecret('secret://nope/1', { principal: 'user:ara' }, () => undefined),
    ).rejects.toThrow(/no such secret/);
    await expect(
      security.vault.useSecret('not-a-ref', { principal: 'user:ara' }, () => undefined),
    ).rejects.toThrow(/not a secret reference/);
    substrate.close();
  });
});

describe('rotation and destruction', () => {
  it('rotates to v2 while v1 stays readable until destroyed', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', 'value-one-original', { principal: 'user:ara' });
    const v2 = await security.vault.rotate('openai', 'value-two-rotated', { principal: 'user:ara' });

    expect(v2.ref).toBe('secret://openai/2');
    expect(security.vault.current('openai')?.ref).toBe('secret://openai/2');

    const readV1 = await security.vault.useSecret('secret://openai/1', { principal: 'user:ara' }, (v) =>
      new TextDecoder().decode(v),
    );
    expect(readV1).toBe('value-one-original');

    security.vault.destroy('openai', 1, { principal: 'user:ara' });
    await expect(
      security.vault.useSecret('secret://openai/1', { principal: 'user:ara' }, () => undefined),
    ).rejects.toThrow(/was destroyed/);

    // v2 is untouched.
    const readV2 = await security.vault.useSecret(v2, { principal: 'user:ara' }, (v) =>
      new TextDecoder().decode(v),
    );
    expect(readV2).toBe('value-two-rotated');
    substrate.close();
  });

  it('destroys the ciphertext but keeps the audit trail', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', API_KEY, { principal: 'user:ara' });
    security.vault.destroy('openai', 'all', { principal: 'user:ara' });

    const row = substrate.storage.get<{ ciphertext: Uint8Array; destroyed_at: number }>(
      'SELECT ciphertext, destroyed_at FROM secrets WHERE name = ?',
      ['openai'],
    );
    expect(row?.ciphertext.length).toBe(0);
    expect(row?.destroyed_at).toBeTypeOf('number');

    // Both the creation and the destruction remain in the log.
    expect(substrate.events.read({ types: ['vault.secret.created'] })).toHaveLength(1);
    expect(substrate.events.read({ types: ['vault.secret.destroyed'] })).toHaveLength(1);
    substrate.close();
  });
});

describe('list()', () => {
  it('returns names and metadata only, field by field', async () => {
    const { security, substrate } = await unlocked();
    await security.vault.create('openai', API_KEY, { principal: 'user:ara', label: 'openai_key' });
    const [entry] = security.vault.list();

    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'createdAt',
      'destroyedAt',
      'label',
      'lastReadAt',
      'name',
      'readCount',
      'rotatedAt',
      'version',
    ]);
    expect(JSON.stringify(entry)).not.toContain(API_KEY);
    substrate.close();
  });
});
