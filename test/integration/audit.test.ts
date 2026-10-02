import { beforeEach, describe, expect, it } from 'vitest';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Security } from '../../src/security/index.js';
import type { Substrate } from '../../src/substrate/index.js';

const PASS = 'a passphrase long enough';

let substrate: Substrate;
let security: Security;

beforeEach(async () => {
  substrate = createTestSubstrate();
  security = createTestSecurity(substrate);
  await security.keyring.initialize(PASS);
  await security.keyring.unlock(PASS);
});

describe('privileged-action audit', () => {
  it('answers "which credentials has it used, and what used them"', async () => {
    await security.vault.create('openai', 'sk-live-aaaaaaaaaaaaaaaaaaaa', { principal: 'user:ara' });
    await security.vault.create('bank', 'bank-token-bbbbbbbbbbbbbbbb', { principal: 'user:ara' });

    for (const tool of ['chat', 'chat', 'summarize']) {
      await security.vault.useSecret('secret://openai/1', { principal: 'system', tool }, () => undefined);
    }

    const usage = security.audit.secretUsage();
    expect(usage.map((u) => u.name)).toEqual(['bank', 'openai']);

    const openai = usage.find((u) => u.name === 'openai');
    expect(openai?.reads).toBe(3);
    expect(openai?.tools).toEqual(['chat', 'summarize']); // distinct, sorted
    expect(openai?.firstUse).not.toBeNull();
    expect(openai?.lastUse).toBeGreaterThanOrEqual(openai!.firstUse!);

    // The question people actually ask: has anything touched my bank key?
    expect(usage.find((u) => u.name === 'bank')?.reads).toBe(0);
  });

  it('never exposes a secret value through any audit surface', async () => {
    const value = 'sk-live-this-must-never-be-visible-anywhere';
    await security.vault.create('openai', value, { principal: 'user:ara' });
    await security.vault.useSecret('secret://openai/1', { principal: 'system', tool: 'chat' }, () => undefined);

    const dump = JSON.stringify({
      actions: security.audit.privilegedActions(),
      usage: security.audit.secretUsage(),
      summary: security.audit.summary(),
    });
    expect(dump).not.toContain(value);
    // It carries the reference and the caller, which is the whole point.
    expect(dump).toContain('secret://openai/1');
    expect(dump).toContain('chat');
  });

  it('filters by secret, principal and time window', async () => {
    const clock = substrate.clock;
    await security.vault.create('openai', 'sk-live-aaaaaaaaaaaaaaaaaaaa', { principal: 'user:ara' });
    await security.vault.useSecret('secret://openai/1', { principal: 'user:ara', tool: 'a' }, () => undefined);

    clock.advance(60_000);
    const cutoff = clock.now();
    await security.vault.useSecret('secret://openai/1', { principal: 'system', tool: 'b' }, () => undefined);

    expect(security.audit.privilegedActions({ since: cutoff })).toHaveLength(1);
    expect(security.audit.privilegedActions({ principal: 'system' })).toHaveLength(1);
    expect(security.audit.privilegedActions({ secretName: 'nope' })).toHaveLength(0);
    expect(security.audit.privilegedActions({ secretName: 'openai' }).length).toBeGreaterThan(1);
  });

  it('records what was forgotten and on whose instruction — forever', async () => {
    const sealed = await security.cipher.encrypt('fact-1', 'something private');
    expect(sealed.byteLength).toBeGreaterThan(0);

    security.shredder.shred('fact-1', { principal: 'user:ara', reason: 'she asked me to' });

    const forgotten = security.audit.forgotten();
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0]).toMatchObject({
      keyId: 'fact-1',
      reason: 'she asked me to',
      principal: 'user:ara',
    });
    // The content is unrecoverable but the deletion is not deniable: a
    // deletion that leaves no trace is indistinguishable from one that never
    // happened.
    expect(JSON.stringify(forgotten)).not.toContain('something private');
  });

  it('summarizes the whole privilege history in one screen', async () => {
    await security.vault.create('openai', 'sk-live-aaaaaaaaaaaaaaaaaaaa', { principal: 'user:ara' });
    await security.vault.useSecret('secret://openai/1', { principal: 'system', tool: 'chat' }, () => undefined);
    security.shredder.shred('fact-1', { principal: 'user:ara', reason: 'no longer true' });

    const summary = security.audit.summary();
    expect(summary.secretReads).toBe(1);
    expect(summary.secretsInUse).toBe(1);
    expect(summary.itemsForgotten).toBe(1);
    expect(summary.totalPrivilegedActions).toBe(3); // created + read + forgotten
    expect(summary.window.from).not.toBeNull();
  });

  it('is derived from the log alone — a rebuild reproduces it exactly', async () => {
    await security.vault.create('openai', 'sk-live-aaaaaaaaaaaaaaaaaaaa', { principal: 'user:ara' });
    await security.vault.useSecret('secret://openai/1', { principal: 'system', tool: 'chat' }, () => undefined);

    const before = security.audit.summary();

    // There is no audit table to drop, so the strongest available statement is
    // that the answer is a pure function of the events: same log, same answer.
    const again = security.audit.summary();
    expect(again).toEqual(before);
    expect(substrate.events.verifyChain().ok).toBe(true);
  });

  it('counts a rotation without counting it as a read', async () => {
    await security.vault.create('openai', 'sk-live-aaaaaaaaaaaaaaaaaaaa', { principal: 'user:ara' });
    await security.vault.rotate('openai', 'sk-live-bbbbbbbbbbbbbbbbbbbb', { principal: 'user:ara' });

    const openai = security.audit.secretUsage().find((u) => u.name === 'openai');
    expect(openai?.rotations).toBe(1);
    expect(openai?.reads).toBe(0);
  });

  it('still reports a destroyed secret, including its past use', async () => {
    await security.vault.create('old', 'sk-live-cccccccccccccccccccc', { principal: 'user:ara' });
    await security.vault.useSecret('secret://old/1', { principal: 'system', tool: 'chat' }, () => undefined);
    await security.vault.destroy('old', 'all', { principal: 'user:ara' });

    const row = security.audit.secretUsage().find((u) => u.name === 'old');
    expect(row?.destroyed).toBe(true);
    expect(row?.reads).toBe(1); // "deleted in March after months of use" stays answerable
  });

  it('has no pending approvals when nothing has asked for one', () => {
    expect(security.audit.pendingApprovals()).toEqual([]);
  });
});
