import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsync, type CliIo } from '../../src/interface/cli.js';
import { must } from '../fakes/must.js';

/**
 * M3's commands, driven the way a person drives them.
 *
 * Through `runAsync` rather than through the module under it, because the
 * bug these catch is never in the executor — it is in the wiring: a command
 * that never reached the dispatcher, a vault built with the wrong KDF, a
 * plan file read relative to the wrong directory. Every one of those passes
 * a unit test and fails the first time someone types the command.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'arish-run-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), env: {} };
}

function planFile(plan: unknown): string {
  const path = join(dir, 'plan.json');
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

const timePlan = {
  goal: 'find out what time it is',
  steps: [{ tool: 'time.now', input: {}, why: 'the user asked for the time' }],
  allowedTools: ['time.now'],
};

interface RunJson {
  status: string;
  steps: Array<{ tool: string; status: string; approvalId?: string }>;
  effectiveRung: number;
  autonomyCapped: boolean;
}

describe('arish tools', () => {
  it('lists every tool with the rung it needs', async () => {
    const o = io();
    expect(await runAsync(['tools', '--data-dir', dir, '--json'], o)).toBe(0);
    const { tools } = JSON.parse(o.stdout.join('\n')) as { tools: Array<{ name: string; minAutonomy: number; irreversible: boolean }> };
    expect(tools.map((t) => t.name)).toEqual([
      'file.read', 'http.fetch', 'memory.assert', 'memory.recall', 'note.write', 'time.now',
    ]);
    expect(must(tools.find((t) => t.name === 'time.now'), 'time.now').minAutonomy).toBe(1);
    // An irreversible tool is L4 whatever its tier says.
    expect(must(tools.find((t) => t.name === 'http.fetch'), 'http.fetch').minAutonomy).toBe(4);
  });

  it('reads as a human-readable table without --json', async () => {
    const o = io();
    await runAsync(['tools', '--data-dir', dir], o);
    const text = o.stdout.join('\n');
    expect(text).toContain('time.now');
    expect(text).toMatch(/6 tools/);
    expect(text).not.toContain('{');
  });
});

describe('arish run', () => {
  it('runs a plan and reports each step', async () => {
    const o = io();
    const code = await runAsync(['run', planFile(timePlan), '--data-dir', dir, '--json'], o);
    expect(code).toBe(0);
    const result = JSON.parse(o.stdout.join('\n')) as RunJson;
    expect(result.status).toBe('finished');
    expect(must(result.steps[0], 'step').status).toBe('succeeded');
  });

  it('says what is wrong with a plan file, by field', async () => {
    const o = io();
    const code = await runAsync(['run', planFile({ goal: 'x', steps: [{ tool: 'time.now' }] }), '--data-dir', dir], o);
    expect(code).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/steps\.0\.why/);
  });

  it('refuses a file that is not a plan rather than guessing', async () => {
    const path = join(dir, 'junk.json');
    writeFileSync(path, 'not json at all');
    const o = io();
    expect(await runAsync(['run', path, '--data-dir', dir], o)).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/not JSON/);
  });

  it('proposes and runs nothing at L0', async () => {
    const o = io();
    await runAsync(['run', planFile(timePlan), '--autonomy', '0', '--data-dir', dir, '--json'], o);
    const result = JSON.parse(o.stdout.join('\n')) as RunJson;
    expect(result.status).toBe('proposed');
    expect(must(result.steps[0], 'step').status).toBe('proposed');
  });

  it('changes nothing on --dry-run', async () => {
    const dryRun = io();
    const plan = planFile({
      goal: 'remember something',
      steps: [{ tool: 'memory.assert', input: { subject: 'user', predicate: 'likes', object: 'tea' }, why: 'remember it' }],
      allowedTools: ['memory.assert'],
    });
    await runAsync(['run', plan, '--autonomy', '3', '--dry-run', '--data-dir', dir], dryRun);
    expect(dryRun.stdout.join('\n')).toMatch(/would:/);

    const status = io();
    await runAsync(['status', '--data-dir', dir, '--json'], status);
    expect((JSON.parse(status.stdout.join('\n')) as { facts: number }).facts).toBe(0);
  });

  it('caps the rung when the input is untrusted, and says so', async () => {
    const o = io();
    await runAsync(['run', planFile(timePlan), '--autonomy', '4', '--trust', 'FOREIGN', '--data-dir', dir, '--json'], o);
    const result = JSON.parse(o.stdout.join('\n')) as RunJson;
    expect(result.effectiveRung).toBe(1);
    expect(result.autonomyCapped).toBe(true);
  });

  it('rejects an autonomy rung that is not on the ladder', async () => {
    const o = io();
    expect(await runAsync(['run', planFile(timePlan), '--autonomy', '7', '--data-dir', dir], o)).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/autonomy must be one of/);
  });
});

describe('arish approvals', () => {
  const needsApproval = {
    goal: 'remember where I live',
    steps: [{ tool: 'memory.assert', input: { subject: 'user', predicate: 'lives_in', object: 'Berlin' }, why: 'remember where you live' }],
    allowedTools: ['memory.assert'],
  };

  it('says so plainly when there is nothing to approve', async () => {
    const o = io();
    expect(await runAsync(['approvals', '--data-dir', dir], o)).toBe(0);
    expect(o.stdout.join('\n')).toMatch(/nothing to approve/);
  });

  it('pauses a run, lists it, and proceeds once granted', async () => {
    const path = planFile(needsApproval);

    // 1. The run asks. Exit 0: a pause is not a failure.
    const first = io();
    expect(await runAsync(['run', path, '--autonomy', '1', '--data-dir', dir, '--json'], first)).toBe(0);
    const paused = JSON.parse(first.stdout.join('\n')) as RunJson;
    expect(paused.status).toBe('awaiting-approval');
    const approvalId = must(must(paused.steps[0], 'step').approvalId, 'approval id');

    // 2. It is visible from a *separate process-equivalent* invocation,
    //    which is the real test: the approval is in the database, not in
    //    the memory of the run that asked.
    const listed = io();
    await runAsync(['approvals', '--data-dir', dir, '--json'], listed);
    const { pending } = JSON.parse(listed.stdout.join('\n')) as { pending: Array<{ id: string; tool: string }> };
    expect(pending.map((p) => p.id)).toEqual([approvalId]);

    // 3. A human grants it.
    const granted = io();
    expect(await runAsync(['approvals', 'grant', approvalId, '--data-dir', dir], granted)).toBe(0);

    // 4. The same plan now runs the step.
    const second = io();
    await runAsync(['run', path, '--autonomy', '1', '--data-dir', dir, '--json'], second);
    expect((JSON.parse(second.stdout.join('\n')) as RunJson).status).toBe('finished');

    const status = io();
    await runAsync(['status', '--data-dir', dir, '--json'], status);
    expect((JSON.parse(status.stdout.join('\n')) as { facts: number }).facts).toBe(1);
  });

  it('ends the run as cancelled when the human says no', async () => {
    const path = planFile(needsApproval);
    const first = io();
    await runAsync(['run', path, '--autonomy', '1', '--data-dir', dir, '--json'], first);
    const approvalId = must(must((JSON.parse(first.stdout.join('\n')) as RunJson).steps[0], 'step').approvalId, 'id');

    await runAsync(['approvals', 'deny', approvalId, '--reason', 'not that one', '--data-dir', dir], io());

    const second = io();
    const code = await runAsync(['run', path, '--autonomy', '1', '--data-dir', dir, '--json'], second);
    expect((JSON.parse(second.stdout.join('\n')) as RunJson).status).toBe('cancelled');
    // Exit 0: the user answered the question. Nothing broke.
    expect(code).toBe(0);
  });

  it('refuses to answer the same request twice', async () => {
    const path = planFile(needsApproval);
    const first = io();
    await runAsync(['run', path, '--autonomy', '1', '--data-dir', dir, '--json'], first);
    const approvalId = must(must((JSON.parse(first.stdout.join('\n')) as RunJson).steps[0], 'step').approvalId, 'id');

    await runAsync(['approvals', 'grant', approvalId, '--data-dir', dir], io());
    const again = io();
    expect(await runAsync(['approvals', 'deny', approvalId, '--data-dir', dir], again)).toBe(1);
    expect(again.stderr.join('\n')).toMatch(/already_settled/);
  });

  it('needs an id to grant one', async () => {
    const o = io();
    expect(await runAsync(['approvals', 'grant', '--data-dir', dir], o)).toBe(2);
    expect(o.stderr.join('\n')).toMatch(/needs an approval id/);
  });
});

describe('help', () => {
  it('names the M3 commands', async () => {
    const o = io();
    await runAsync(['help'], o);
    const text = o.stdout.join('\n');
    for (const command of ['tools', 'run <plan>', 'approvals']) expect(text).toContain(command);
  });
});
