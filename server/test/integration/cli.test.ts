import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type CliIo } from '../../src/interface/cli.js';
import { createSubstrate } from '../../src/substrate/index.js';
import { FakeClock } from '../fakes/clock.js';
import { FakeCrypto } from '../fakes/crypto.js';
import { FakeLogger } from '../fakes/logger.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arish-cli-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), env: {} };
}

function seed(count: number): void {
  const clock = new FakeClock();
  const substrate = createSubstrate({ dbPath: join(dir, 'arish.db'), clock, crypto: new FakeCrypto(), log: new FakeLogger() });
  for (let i = 0; i < count; i++) {
    clock.advance(1000);
    substrate.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: `s${i}`, payload: { channel: 'veo' } });
  }
  substrate.close();
}

describe('CLI', () => {
  it('doctor reports environment and exits 0', () => {
    const o = io();
    expect(run(['doctor', '--data-dir', dir, '--json'], o)).toBe(0);
    const report = JSON.parse(o.stdout.join('\n')) as { ok: boolean; checks: Array<{ name: string; detail: string }> };
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toContain('clock');
    // §46: the build lives at L1 and says so out loud.
    expect(report.checks.find((c) => c.name === 'model')?.detail).toMatch(/none configured/);
  });

  it('status reports the chain head and the degradation rung', () => {
    seed(5);
    const o = io();
    expect(run(['status', '--data-dir', dir, '--json'], o)).toBe(0);
    const status = JSON.parse(o.stdout.join('\n')) as { events: number; headSeq: number; degradation: string };
    expect(status.events).toBe(5);
    expect(status.headSeq).toBe(5);
    expect(status.degradation).toBe('L1');
  });

  it('verify-chain exits 0 on a sound log', () => {
    seed(10);
    expect(run(['verify-chain', '--data-dir', dir, '--json'], io())).toBe(0);
  });

  it('verify-chain exits NON-ZERO on a tampered log', () => {
    seed(10);
    const clock = new FakeClock();
    const s = createSubstrate({ dbPath: join(dir, 'arish.db'), clock, crypto: new FakeCrypto(), log: new FakeLogger() });
    s.storage.prepare('UPDATE events SET payload = ? WHERE seq = 4').run(JSON.stringify({ channel: 'evil' }));
    s.close();

    const o = io();
    expect(run(['verify-chain', '--data-dir', dir, '--json'], o)).toBe(1);
    expect(o.stdout.join('\n')).toMatch(/"brokenAt": 4/);
  });

  it('rebuild replays and reports identical projections', () => {
    seed(20);
    const o = io();
    expect(run(['rebuild', '--data-dir', dir, '--json'], o)).toBe(0);
    const result = JSON.parse(o.stdout.join('\n')) as { events: number; identical: boolean; problems: string[] };
    expect(result.events).toBe(20);
    expect(result.identical).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('reports an unknown command without throwing', () => {
    const o = io();
    expect(run(['frobnicate'], o)).toBe(2);
    expect(o.stderr.join('')).toMatch(/unknown command/);
  });

  it('reports every config problem at once and exits 2', () => {
    const o = io();
    o.env['ARISH_PORT'] = '99999';
    o.env['ARISH_AUTONOMY'] = '12';
    expect(run(['status'], o)).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/port/);
    expect(o.stderr.join('\n')).toMatch(/autonomy/);
  });

  it('help lists only the commands that actually exist', () => {
    // §61: later commands are absent, not stubbed. A help text advertising
    // `arish start` before it works is a lie told in documentation.
    const o = io();
    expect(run(['help'], o)).toBe(0);
    const help = o.stdout.join('\n');
    expect(help).toMatch(/doctor/);
    expect(help).toMatch(/absent rather than stubbed/);
  });
});
