import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEffects } from '../../src/interface/effects-cli.js';
import { Outbox } from '../../src/capability/outbox.js';
import { createSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { FakeLogger } from '../fakes/logger.js';
import { must } from '../fakes/must.js';

/**
 * `arish effects` — the human end of the outbox.
 *
 * The point of these tests is the last one: the CLI must offer no way to
 * retry. Everything else is presentation.
 */

let dir: string;
let substrate: Substrate;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arish-effects-'));
  substrate = createSubstrate({
    dbPath: join(dir, 'arish.db'), clock: new FakeClock(), crypto: new FakeCrypto(), log: new FakeLogger(),
  });
});
afterEach(() => {
  substrate.close();
  rmSync(dir, { recursive: true, force: true });
});

function io(): { stdout: string[]; stderr: string[]; out(l: string): void; err(l: string): void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

function outbox(): Outbox {
  return new Outbox({ storage: substrate.storage, events: substrate.events, crypto: substrate.crypto });
}

const EMAIL = {
  tool: 'mail.send', version: '1', stepId: 'step-1',
  input: { to: 'ana@example.com' }, reversible: false, idempotent: false,
  summary: 'email Ana about Thursday', runId: 'run-1',
};

describe('arish effects', () => {
  it('says plainly when there is nothing to report', async () => {
    const o = io();
    expect(await runEffects(['pending'], { substrate }, o)).toBe(0);
    expect(o.stdout.join('\n')).toContain('(nothing)');
  });

  it('lists an unsettled effect with what it was meant to do', async () => {
    outbox().intend(EMAIL);
    const o = io();
    expect(await runEffects(['pending'], { substrate }, o)).toBe(0);

    const text = o.stdout.join('\n');
    expect(text).toContain('Intended, not settled: 1');
    expect(text).toContain('email Ana about Thursday');
    expect(text).toContain('mail.send');
  });

  it('never prints the arguments of an effect', async () => {
    outbox().intend(EMAIL);
    const o = io();
    await runEffects(['list'], { substrate }, o);
    expect(o.stdout.join('\n')).not.toContain('ana@example.com');
  });

  it('reconcile moves an unprobeable effect to the human queue and says so', async () => {
    outbox().intend(EMAIL);
    const o = io();
    expect(await runEffects(['reconcile'], { substrate }, o)).toBe(0);

    const text = o.stdout.join('\n');
    expect(text).toContain('need you to decide:     1');
    expect(text).toContain('Nothing was retried.');
    expect(must(outbox().needsAttention()[0], 'entry').tool).toBe('mail.send');
  });

  it('shows the human queue after reconciliation', async () => {
    outbox().intend(EMAIL);
    await runEffects(['reconcile'], { substrate }, io());

    const o = io();
    expect(await runEffects(['attention'], { substrate }, o)).toBe(0);
    expect(o.stdout.join('\n')).toContain('Waiting on you: 1');
  });

  it('answers in JSON when asked', async () => {
    outbox().intend(EMAIL);
    const o = io();
    await runEffects(['pending'], { substrate }, o, true);
    const body = JSON.parse(o.stdout.join('\n')) as { ok: boolean; count: number };
    expect(body).toMatchObject({ ok: true, count: 1 });
  });

  it('offers no way to retry — not even a hidden one', async () => {
    outbox().intend(EMAIL);
    const o = io();
    expect(await runEffects(['retry'], { substrate }, o)).toBe(2);
    expect(o.stderr.join('\n')).toContain("unknown subcommand 'retry'");

    const help = io();
    await runEffects(['help'], { substrate }, help);
    const text = help.stdout.join('\n');
    expect(text).not.toMatch(/^\s+effects retry/m);
    expect(text).toContain("There is no 'retry'");
  });

  it('a committed effect leaves the pending list', async () => {
    const box = outbox();
    const { key } = box.intend(EMAIL);
    box.commit(key, { remoteRef: 'msg-1' });

    const pending = io();
    await runEffects(['pending'], { substrate }, pending);
    expect(pending.stdout.join('\n')).toContain('(nothing)');

    const all = io();
    await runEffects(['list'], { substrate }, all);
    expect(all.stdout.join('\n')).toContain('→ msg-1');
  });
});
