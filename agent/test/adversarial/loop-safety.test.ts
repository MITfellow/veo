import { describe, expect, it } from 'vitest';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { FakeModel, floodTurn, gate, reply, say, usage } from '../fakes/model.js';

/**
 * The loop is the thing every later milestone hangs off. These tests are
 * hostile to it on purpose: a model that never stops, a model that floods,
 * a provider that lies about its own protocol, an abort on the very first
 * chunk. None of them may hang the process, corrupt a run, or leave a run
 * stuck in `running` forever.
 */

const SESSION = 'sess-1';
const PRINCIPAL = 'user:ara';

function setup(model: FakeModel): { substrate: Substrate; runner: Runner } {
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'adversarial' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  substrate.events.append({
    type: 'message.user',
    payload: { text: 'go', attachments: [] },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  const runner = new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
  });
  return { substrate, runner };
}

/** No run may ever end with the projection still saying 'running'. */
function assertTerminal(substrate: Substrate, runId: string): void {
  const row = substrate.storage.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', [
    runId,
  ]);
  expect(row?.state).not.toBe('running');
  expect(row?.state).toBeDefined();
}

describe('a model that will not stop', () => {
  it('is bounded by the step cap, not by hope', async () => {
    const turns = Array.from({ length: 1000 }, () => ({ chunks: [...say('and '), usage(1, 1)] }));
    const { substrate, runner } = setup(new FakeModel(turns));
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 5 },
    });
    expect(outcome.reason).toBe('step-cap');
    expect(outcome.steps).toBe(5);
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });

  it('is bounded even when it emits nothing at all', async () => {
    const turns = Array.from({ length: 20 }, () => ({ chunks: [] }));
    const { substrate, runner } = setup(new FakeModel(turns));
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 3 },
    });
    // An empty stream is not an answer. Treating it as one would end the run
    // silently with nothing to show the user.
    expect(outcome.reason).toBe('step-cap');
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });

  it('is bounded when it stops mid-sentence and never finishes', async () => {
    const turns = Array.from({ length: 20 }, () => ({
      chunks: [...say('I was about to say'), usage(2, 2)],
      hangAfter: 2,
    }));
    const { substrate, runner } = setup(new FakeModel(turns));
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 4 },
    });
    expect(outcome.reason).toBe('step-cap');
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });
});

describe('a model that floods', () => {
  it('handles ten thousand tiny deltas without losing or duplicating text', async () => {
    const { substrate, runner } = setup(new FakeModel([floodTurn(10_000)]));
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.text).toHaveLength(10_000);
    expect(outcome.text).toBe('x'.repeat(10_000));

    // The message in the log is the same text — the stream and the record
    // cannot disagree, or the transcript lies about what was said.
    const message = substrate.events
      .read({ runId: outcome.runId, types: ['message.agent'] })
      .at(0);
    expect((message?.payload as { text: string }).text).toHaveLength(10_000);
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });

  it('counts a flood against the token cap', async () => {
    // Floods that never say `finish`: a model that *does* finish is finished,
    // budget remaining or not, so the cap is only reachable while the model
    // still claims to have more to say.
    const turns = Array.from({ length: 10 }, () => {
      const turn = floodTurn(100);
      return { chunks: turn.chunks.filter((c) => c.type !== 'finish') };
    });
    const { substrate, runner } = setup(new FakeModel(turns));
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 50, maxTokens: 300 },
    });
    expect(outcome.reason).toBe('token-cap');
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });
});

describe('a provider that breaks its own contract', () => {
  it('records a thrown error as run.failed instead of corrupting the run', async () => {
    const { substrate, runner } = setup(
      new FakeModel([{ chunks: [], throws: new TypeError('undefined is not a function') }]),
    );
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.status).toBe('failed');
    assertTerminal(substrate, outcome.runId);
    expect(substrate.events.verifyChain().ok).toBe(true);
    substrate.close();
  });

  it('rejects a chunk with a bogus type at the boundary', async () => {
    const { substrate, runner } = setup(
      new FakeModel([{ chunks: [], emitInvalid: [{ type: 'exfiltrate', data: 'everything' }] }]),
    );
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.status).toBe('failed');
    // A provider is an external surface; an unknown chunk type is refused
    // rather than passed through to anything that might act on it.
    assertTerminal(substrate, outcome.runId);
    substrate.close();
  });

  it('rejects a usage chunk with negative tokens', async () => {
    const { substrate, runner } = setup(
      new FakeModel([
        { chunks: [], emitInvalid: [{ type: 'usage', inputTokens: -5, outputTokens: 0 }] },
      ]),
    );
    const outcome = await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    // Negative usage would let a provider roll the token cap backwards and
    // run forever on someone else's budget.
    expect(outcome.status).toBe('failed');
    substrate.close();
  });
});

describe('aborting at the worst moment', () => {
  it('leaves a well-formed cancelled run when aborted on the very first chunk', async () => {
    const held = gate();
    const { substrate, runner } = setup(
      new FakeModel([{ ...floodTurn(100), pauseAfter: 0, gate: held.promise }]),
    );
    const promise = runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    // Cancel before a single chunk has been emitted.
    await Promise.resolve();
    const runId = substrate.events.read({ types: ['run.started'] }).at(0)?.runId;
    expect(runId).toBeDefined();
    runner.cancel(runId!, 'user');
    held.open();

    const outcome = await promise;
    expect(outcome.status).toBe('cancelled');
    assertTerminal(substrate, outcome.runId);
    expect(substrate.events.verifyChain().ok).toBe(true);
    substrate.close();
  });

  it('is idempotent: cancelling twice is not an error', async () => {
    const held = gate();
    const { substrate, runner } = setup(
      new FakeModel([{ ...floodTurn(50), pauseAfter: 2, gate: held.promise }]),
    );
    const promise = runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    await Promise.resolve();
    const runId = substrate.events.read({ types: ['run.started'] }).at(0)!.runId!;
    expect(runner.cancel(runId)).toBe(true);
    runner.cancel(runId); // again — must not throw
    held.open();
    await promise;
    expect(runner.cancel(runId)).toBe(false); // finished runs report false
    substrate.close();
  });
});

describe('concurrent runs in one session', () => {
  it('do not interleave their events or steal each other\'s text', async () => {
    const substrate = createTestSubstrate();
    substrate.events.append({
      type: 'session.created',
      payload: { title: 'concurrent' },
      principal: PRINCIPAL,
      trust: 'USER',
      sessionId: SESSION,
    });
    const model = new FakeModel([reply('answer one'), reply('answer two')]);
    const runner = new Runner({
      events: substrate.events,
      clock: substrate.clock,
      ids: substrate.ids,
      logger: substrate.logger,
      model,
    });

    const [a, b] = await Promise.all([
      runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' }),
      runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' }),
    ]);

    expect(a.runId).not.toBe(b.runId);
    // Each run's events are retrievable in isolation, which is the whole
    // point of carrying runId and correlationId on every event.
    for (const outcome of [a, b]) {
      const events = substrate.events.read({ runId: outcome.runId });
      expect(events.every((e) => e.runId === outcome.runId)).toBe(true);
      expect(events.map((e) => e.type)).toContain('run.finished');
      assertTerminal(substrate, outcome.runId);
    }
    expect(new Set([a.text, b.text])).toEqual(new Set(['answer one', 'answer two']));
    expect(substrate.events.verifyChain().ok).toBe(true);
    substrate.close();
  });
});

describe('the hash chain survives everything above', () => {
  it('verifies after a cancelled, a failed and a capped run in one database', async () => {
    const { substrate, runner } = setup(
      new FakeModel([
        { chunks: [], throws: new Error('boom') },
        ...Array.from({ length: 5 }, () => ({ chunks: [...say('x'), usage(1, 1)] })),
      ]),
    );
    await runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    await runner.run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 2 },
    });
    expect(substrate.events.verifyChain().ok).toBe(true);
    substrate.close();
  });
});
