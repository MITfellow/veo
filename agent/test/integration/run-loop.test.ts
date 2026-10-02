import { beforeEach, describe, expect, it } from 'vitest';
import { Runner, DEFAULT_LIMITS } from '../../src/orchestration/runner.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import type { FakeClock } from '../../src/substrate/clock.js';
import {
  FakeModel,
  callTool,
  fail,
  finish,
  floodTurn,
  reply,
  say,
  usage,
} from '../fakes/model.js';

let substrate: Substrate;
let clock: FakeClock;

const SESSION = 'sess-1';
const PRINCIPAL = 'user:ara';

beforeEach(() => {
  substrate = createTestSubstrate();
  clock = substrate.clock as FakeClock;
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'test' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
});

function runner(model: FakeModel): Runner {
  return new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
  });
}

function userSays(text: string): void {
  substrate.events.append({
    type: 'message.user',
    payload: { text, attachments: [] },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
}

const typesOf = (runId: string): string[] =>
  substrate.events.read({ runId }).map((e) => e.type);

describe('the run loop', () => {
  it('runs one turn and leaves a complete, ordered trail', async () => {
    userSays('hello');
    const model = new FakeModel([reply('Hi there.')]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(outcome.status).toBe('finished');
    expect(outcome.reason).toBe('stop');
    expect(outcome.text).toBe('Hi there.');
    expect(typesOf(outcome.runId)).toEqual([
      'run.started',
      'step.started',
      // M5: every turn logs the context it was given (§21).
      'context.assembled',
      // M9: and how long assembling it took (§32's budget is measured,
      // not assumed).
      'perf.sampled',
      'model.requested',
      'model.responded',
      'step.finished',
      'message.agent',
      'run.finished',
    ]);
  });

  it('appends step.started BEFORE calling the model', async () => {
    userSays('hello');
    let seenAtModelCall: string[] = [];
    const model = new FakeModel([reply('ok')], {
      onRequest: () => {
        seenAtModelCall = substrate.events.read().map((e) => e.type);
      },
    });
    await runner(model).run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    // Invariant 3: the process may die at any instruction. If the model call
    // is what kills us, the log must already say a step had begun.
    expect(seenAtModelCall).toContain('step.started');
    expect(seenAtModelCall).not.toContain('step.finished');
  });

  it('carries the run id as correlation id on every event in the run', async () => {
    userSays('hello');
    const model = new FakeModel([reply('ok')]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    const events = substrate.events.read({ runId: outcome.runId });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.correlationId).toBe(outcome.runId);
  });

  it('carries the conversation forward: turn two sees turn one', async () => {
    const model = new FakeModel([reply('Nice to meet you, Ara.'), reply('Your name is Ara.')]);
    const r = runner(model);

    userSays('My name is Ara.');
    await r.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    userSays('What is my name?');
    const second = await r.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    expect(second.text).toBe('Your name is Ara.');

    // The second request's context was rebuilt from the event log, which is
    // why it survives a restart — see run-reconstruction.test.ts.
    const contents = model.requests[1]!.messages.map((m) => m.content).join('\n');
    expect(contents).toContain('My name is Ara.');
    expect(contents).toContain('Nice to meet you, Ara.');
    expect(contents).toContain('What is my name?');
  });

  it('marks agent output DERIVED, not USER', async () => {
    userSays('hi');
    const model = new FakeModel([reply('hello')]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    const agent = substrate.events
      .read({ runId: outcome.runId, types: ['message.agent'] })
      .at(0);
    // §12: the model's output is inferred, not stated by the principal.
    expect(agent?.trust).toBe('DERIVED');
  });
});

describe('every stop condition is named', () => {
  it('stops at the step cap rather than looping forever', async () => {
    userSays('go');
    // A model that always asks for a tool would loop forever without a cap.
    const turns = Array.from({ length: 10 }, (_, i) => ({
      chunks: [callTool(`c${i}`, 'search', { q: i }), usage(5, 5), finish('tool-calls')],
    }));
    const outcome = await runner(new FakeModel(turns)).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 3 },
    });
    // M2 has no tool execution, so it stops at the first tool call; the cap
    // is proven separately below with a model that only emits text.
    expect(['tools-unavailable', 'step-cap']).toContain(outcome.reason);
  });

  it('stops at the step cap with a model that never finishes', async () => {
    userSays('go');
    const turns = Array.from({ length: 10 }, () => ({
      chunks: [...say('thinking '), usage(5, 5)], // no finish chunk, ever
    }));
    const outcome = await runner(new FakeModel(turns)).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 3 },
    });
    expect(outcome.reason).toBe('step-cap');
    expect(outcome.steps).toBe(3);
  });

  it('stops at the token cap', async () => {
    userSays('go');
    const turns = Array.from({ length: 10 }, () => ({
      chunks: [...say('words '), usage(500, 500)],
    }));
    const outcome = await runner(new FakeModel(turns)).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 50, maxTokens: 2000 },
    });
    expect(outcome.reason).toBe('token-cap');
    expect(outcome.inputTokens + outcome.outputTokens).toBeGreaterThanOrEqual(2000);
  });

  it('stops at the time cap, measured on the injected clock', async () => {
    userSays('go');
    const turns = Array.from({ length: 10 }, () => ({
      chunks: [...say('slow '), usage(5, 5)],
    }));
    const model = new FakeModel(turns, { onRequest: () => clock.advance(30_000) });
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 50, maxWallMs: 60_000 },
    });
    expect(outcome.reason).toBe('time-cap');
    // Deterministic: no sleeping, no flake. The clock is a port (§8).
    expect(outcome.steps).toBe(2);
  });

  it('stops at the cost cap', async () => {
    userSays('go');
    const turns = Array.from({ length: 10 }, () => ({
      chunks: [...say('spendy '), usage(5, 5, 400_000)], // $0.40 a step
    }));
    const outcome = await runner(new FakeModel(turns)).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 50, maxCostMicros: 1_000_000 },
    });
    expect(outcome.reason).toBe('cost-cap');
    expect(outcome.costMicros).toBeGreaterThanOrEqual(1_000_000);
  });

  it('records the stop reason in the event, not only in the return value', async () => {
    userSays('go');
    const turns = Array.from({ length: 5 }, () => ({ chunks: [...say('x'), usage(5, 5)] }));
    const outcome = await runner(new FakeModel(turns)).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
      limits: { maxSteps: 2 },
    });
    const finished = substrate.events
      .read({ runId: outcome.runId, types: ['run.finished'] })
      .at(0);
    // Invariant 15: a run that stopped without saying why is an unexplained
    // output, and the log is the only place that answer survives.
    expect((finished?.payload as { reason: string }).reason).toBe('step-cap');
  });
});

describe('failure is data', () => {
  it('turns a provider error chunk into model.failed and run.failed', async () => {
    userSays('go');
    const model = new FakeModel([
      { chunks: [...say('I was saying some'), fail('server', 'upstream 503', true)] },
    ]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(outcome.status).toBe('failed');
    const types = typesOf(outcome.runId);
    expect(types).toContain('model.failed');
    expect(types).toContain('run.failed');

    // The partial text is KEPT. The user watched it appear; making it vanish
    // is worse than an error message.
    expect(outcome.text).toContain('I was saying some');
    expect(types).toContain('message.agent');
  });

  it('survives a provider that throws instead of emitting an error chunk', async () => {
    userSays('go');
    const model = new FakeModel([{ chunks: [], throws: new Error('socket hang up') }]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.status).toBe('failed');
    const failed = substrate.events.read({ runId: outcome.runId, types: ['run.failed'] }).at(0);
    expect((failed?.payload as { message: string }).message).toContain('socket hang up');
    // The run is closed out properly: no dangling 'running' state.
    const row = substrate.storage.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', [
      outcome.runId,
    ]);
    expect(row?.state).toBe('failed');
  });

  it('rejects a malformed chunk at the port boundary, naming the provider', async () => {
    userSays('go');
    const model = new FakeModel([{ chunks: [], emitInvalid: [{ type: 'nonsense' }] }]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.status).toBe('failed');
    const failed = substrate.events.read({ runId: outcome.runId, types: ['run.failed'] }).at(0);
    expect((failed?.payload as { message: string }).message).toContain('fake-1');
  });
});

describe('cancellation', () => {
  it('ends the run cleanly mid-stream and keeps what was already streamed', async () => {
    userSays('write me an essay');
    const model = new FakeModel([floodTurn(500)]);
    const r = runner(model);

    let cancelled = false;
    r.onChunk = (runId) => {
      if (!cancelled) {
        cancelled = true;
        r.cancel(runId, 'user');
      }
    };

    const outcome = await r.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

    expect(outcome.status).toBe('cancelled');
    expect(typesOf(outcome.runId)).toContain('run.cancelled');
    expect(outcome.text.length).toBeGreaterThan(0);
    expect(outcome.text.length).toBeLessThan(500);

    const row = substrate.storage.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', [
      outcome.runId,
    ]);
    expect(row?.state).toBe('cancelled');
  });

  it('reports false when cancelling a run that is not running', () => {
    expect(runner(new FakeModel()).cancel('no-such-run')).toBe(false);
  });

  it('wires the abort signal through to the provider', async () => {
    userSays('go');
    const model = new FakeModel([reply('ok')]);
    await runner(model).run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    expect(model.signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('tool calls (M2 records them; M3 executes them)', () => {
  it('records tool.requested and stops with an honest reason', async () => {
    userSays('search for cafes');
    const model = new FakeModel([
      { chunks: [callTool('c1', 'search', { q: 'cafes' }), usage(5, 5), finish('tool-calls')] },
    ]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(outcome.reason).toBe('tools-unavailable');
    const requested = substrate.events
      .read({ runId: outcome.runId, types: ['tool.requested'] })
      .at(0);
    expect(requested?.payload).toMatchObject({ tool: 'search' });
    // The shape of the tool path is exercised end to end at M2; only the
    // execution is missing, so M3 is additive.
  });

  it('aborts on a model stuck repeating one call, naming the loop', async () => {
    userSays('go');
    const stuck = {
      chunks: [callTool('c', 'search', { q: 'same' }), usage(5, 5), finish('tool-calls')],
    };
    // Four identical calls in one step: three earns a correction, the fourth aborts.
    const model = new FakeModel([
      {
        chunks: [
          callTool('a', 'search', { q: 'same' }),
          callTool('b', 'search', { q: 'same' }),
          callTool('c', 'search', { q: 'same' }),
          callTool('d', 'search', { q: 'same' }),
          usage(5, 5),
          finish('tool-calls'),
        ],
      },
      stuck,
    ]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.reason).toBe('loop-detected');
  });

  it('treats key-order-different inputs as the same call for loop detection', async () => {
    userSays('go');
    const model = new FakeModel([
      {
        chunks: [
          callTool('a', 'f', { a: 1, b: 2 }),
          callTool('b', 'f', { b: 2, a: 1 }),
          callTool('c', 'f', { a: 1, b: 2 }),
          callTool('d', 'f', { b: 2, a: 1 }),
          usage(5, 5),
          finish('tool-calls'),
        ],
      },
    ]);
    const outcome = await runner(model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    // canonicalJson is why this works, and it is the loop models actually
    // get stuck in — same call, keys shuffled.
    expect(outcome.reason).toBe('loop-detected');
  });
});

describe('limits', () => {
  it('has defaults that are finite', () => {
    for (const value of Object.values(DEFAULT_LIMITS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
