import { describe, expect, it } from 'vitest';
import { Runner } from '../../src/orchestration/runner.js';
import { ALL_PROJECTORS, createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { FakeModel, reply } from '../fakes/model.js';
import { FakeClock } from '../../src/substrate/clock.js';
import { canonicalJson } from '../../src/substrate/hash.js';

/**
 * The M2 bar (§33):
 *
 *   > a two-turn conversation streams to curl and **the whole run is
 *   > reconstructible from the log alone**.
 *
 * The streaming half lives in http.test.ts. This file is the second half,
 * and it is the one that matters architecturally: if any part of a run lives
 * only in a projection table or only in the runner's memory, this fails.
 */

const SESSION = 'sess-1';
const PRINCIPAL = 'user:ara';

/**
 * A "new process" against the same database.
 *
 * The seed and the clock offset matter. `fakeIds` is deterministic and
 * `FakeClock` restarts at the same instant, so a second substrate built with
 * identical arguments regenerates the *same ULIDs* and collides on
 * `events.id` — which the UNIQUE constraint caught, correctly, the first time
 * this test ran. A real restart has a real clock and real randomness; the
 * fixture has to model that rather than pretend time stood still.
 */
function freshSubstrate(dbPath: string, seed: number, atMs: number): Substrate {
  const clock = new FakeClock(new Date(atMs).toISOString());
  return createTestSubstrate({ dbPath, seed, clock });
}

function runnerFor(substrate: Substrate, model: FakeModel): Runner {
  return new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
  });
}

function seedSession(substrate: Substrate): void {
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'reconstruction' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
}

function userSays(substrate: Substrate, text: string): void {
  substrate.events.append({
    type: 'message.user',
    payload: { text, attachments: [] },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
}

/** Every projection table, dumped deterministically. */
function snapshot(substrate: Substrate): string {
  const tables = ['sessions', 'messages', 'runs', 'steps'];
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    dump[table] = substrate.storage.all(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return canonicalJson(dump);
}

describe('the whole run is reconstructible from the log alone', () => {
  it('drops every projection, replays, and comes back byte-identical', async () => {
    const substrate = createTestSubstrate();
    seedSession(substrate);

    const model = new FakeModel([reply('Nice to meet you, Ara.'), reply('Your name is Ara.')]);
    const runner = runnerFor(substrate, model);

    userSays(substrate, 'My name is Ara.');
    await runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    userSays(substrate, 'What is my name?');
    await runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    const before = snapshot(substrate);
    expect(before).toContain('Your name is Ara.');

    // Burn it all down.
    for (const projector of ALL_PROJECTORS) projector.reset(substrate.storage);
    expect(substrate.storage.all('SELECT * FROM messages')).toHaveLength(0);

    substrate.events.rebuild();

    expect(snapshot(substrate)).toBe(before);
    substrate.close();
  });

  it('reconstructs the full transcript from events with no projection at all', async () => {
    const substrate = createTestSubstrate();
    seedSession(substrate);
    const model = new FakeModel([reply('Hello Ara.'), reply('Goodbye Ara.')]);
    const runner = runnerFor(substrate, model);

    userSays(substrate, 'Hi.');
    await runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    userSays(substrate, 'Bye.');
    await runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    const transcript = substrate.events
      .read({ sessionId: SESSION, types: ['message.user', 'message.agent'] })
      .map((e) => `${e.type === 'message.user' ? 'user' : 'agent'}: ${(e.payload as { text: string }).text}`);

    expect(transcript).toEqual([
      'user: Hi.',
      'agent: Hello Ara.',
      'user: Bye.',
      'agent: Goodbye Ara.',
    ]);
    substrate.close();
  });

  it('survives a process restart: a new Runner on the same DB continues the conversation', async () => {
    const dbPath = '/tmp/arish-m2-restart.db';
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        (await import('node:fs')).rmSync(`${dbPath}${suffix}`);
      } catch {
        /* first run */
      }
    }

    // ── process 1 ──────────────────────────────────────────────────────────
    const t0 = Date.parse('2026-02-01T10:00:00Z');
    const first = freshSubstrate(dbPath, 1, t0);
    seedSession(first);
    userSays(first, 'My name is Ara.');
    await runnerFor(first, new FakeModel([reply('Nice to meet you, Ara.')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    first.close();

    // ── process 2: everything in memory is gone ────────────────────────────
    // Minutes later, a different process: new seed, clock moved on.
    const second = freshSubstrate(dbPath, 99, t0 + 600_000);
    const model = new FakeModel([reply('Your name is Ara.')]);
    userSays(second, 'What is my name?');
    await runnerFor(second, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    // The new process rebuilt the conversation from the log, because that is
    // the only place it ever lived.
    const contents = model.requests[0]!.messages.map((m) => m.content).join('\n');
    expect(contents).toContain('My name is Ara.');
    expect(contents).toContain('Nice to meet you, Ara.');
    expect(contents).toContain('What is my name?');

    expect(second.events.verifyChain().ok).toBe(true);
    second.close();
  });
});

describe('an interrupted step is detectable', () => {
  it('leaves a step row with no finished_at when the process dies mid-step', async () => {
    const substrate = createTestSubstrate();
    seedSession(substrate);
    userSays(substrate, 'go');

    // A provider that dies the way a real one does: the process is gone
    // before the step could be closed out.
    const model = new FakeModel([
      { chunks: [], throws: Object.assign(new Error('process died'), { fatal: true }) },
    ]);
    const outcome = await runnerFor(substrate, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    const unfinished = substrate.storage.all<{ id: string; idx: number }>(
      'SELECT id, idx FROM steps WHERE run_id = ? AND finished_at IS NULL',
      [outcome.runId],
    );
    // No status column had to be written by the thing that just died — the
    // absence of step.finished IS the signal.
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]?.idx).toBe(0);
    substrate.close();
  });

  it('pairs every started step with a finished one on a clean run', async () => {
    const substrate = createTestSubstrate();
    seedSession(substrate);
    userSays(substrate, 'go');
    const outcome = await runnerFor(substrate, new FakeModel([reply('done')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    const rows = substrate.storage.all<{ finished_at: number | null }>(
      'SELECT finished_at FROM steps WHERE run_id = ?',
      [outcome.runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.finished_at).not.toBeNull();
    substrate.close();
  });
});

describe('the trace renders from the log (§30)', () => {
  it('reports context blocks, tokens and timings for every step', async () => {
    const substrate = createTestSubstrate();
    seedSession(substrate);
    userSays(substrate, 'go');
    const outcome = await runnerFor(substrate, new FakeModel([reply('answer')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    const events = substrate.events.read({ runId: outcome.runId });
    const requested = events.find((e) => e.type === 'model.requested');
    const responded = events.find((e) => e.type === 'model.responded');

    const digest = (requested?.payload as { contextDigest: string }).contextDigest;
    expect(digest).toContain('system');
    expect(digest).toContain('history');
    expect((requested?.payload as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
    expect((responded?.payload as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);

    // The digest records block names and token counts, not the full text:
    // the context is a pure function of events already in the log, so
    // storing it again would double the log for no new information.
    expect(digest).not.toContain('You are a personal agent');
    substrate.close();
  });
});
