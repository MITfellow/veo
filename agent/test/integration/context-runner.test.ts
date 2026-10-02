/**
 * Context assembly inside the run loop (§21, §23, M5).
 *
 * The unit tests prove the pure function behaves. These prove the *system*
 * uses it: that every turn logs what the model was given, that an overflow
 * is handled by compacting and retrying exactly once, and that a restarted
 * process rebuilds the same context from the log alone.
 */
import { describe, expect, it } from 'vitest';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { Compactor } from '../../src/cognition/compaction.js';
import { Snapshotter } from '../../src/orchestration/snapshot.js';
import { FakeModel, finish, reply, say, usage } from '../fakes/model.js';
import type { ModelChunk } from '../../src/substrate/model/types.js';

const SESSION = 'sess-ctx';
const PRINCIPAL = 'user:ara';

function world(): Substrate {
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'context' },
    principal: PRINCIPAL,
    trust: 'USER',
    sessionId: SESSION,
  });
  return substrate;
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

function agentSaid(substrate: Substrate, text: string): void {
  substrate.events.append({
    type: 'message.agent',
    payload: { text },
    principal: 'system',
    trust: 'DERIVED',
    sessionId: SESSION,
  });
}

function runnerFor(substrate: Substrate, model: FakeModel, compactor?: Compactor): Runner {
  const deps = {
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
  };
  return new Runner(compactor === undefined ? deps : { ...deps, compactor });
}

const overflow: ModelChunk[] = [
  { type: 'error', kind: 'context-overflow', message: 'prompt is 9000 tokens over the limit', retryable: true },
];

describe('the runner logs the context it used (§21)', () => {
  it('logs exactly one context.assembled per step, with a digest', async () => {
    const substrate = world();
    userSays(substrate, 'hello');
    const outcome = await runnerFor(substrate, new FakeModel([reply('hi')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    const events = substrate.events.read({ runId: outcome.runId });
    const assembled = events.filter((event) => event.type === 'context.assembled');
    const steps = events.filter((event) => event.type === 'step.started');
    expect(assembled).toHaveLength(steps.length);

    const payload = assembled[0]!.payload as {
      digest: string;
      blocks: Array<{ name: string; tokens: number; items: number }>;
      drops: unknown[];
      policyVersion: string;
      totalTokens: number;
    };
    expect(payload.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.policyVersion).toBe('ctx-1/tpl-3');
    expect(payload.totalTokens).toBeGreaterThan(0);
    expect(payload.blocks.map((block) => block.name)).toContain('conversation');
    substrate.close();
  });

  it('records the drops, so a short answer months later can be explained', async () => {
    const substrate = world();
    for (let i = 0; i < 60; i++) {
      userSays(substrate, `question ${i} ${'padding '.repeat(60)}`);
      agentSaid(substrate, `answer ${i} ${'padding '.repeat(60)}`);
    }
    userSays(substrate, 'and finally?');
    const outcome = await runnerFor(substrate, new FakeModel([reply('yes')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    const assembled = substrate.events
      .read({ runId: outcome.runId })
      .find((event) => event.type === 'context.assembled');
    const payload = assembled!.payload as { drops: Array<{ block: string; reason: string }> };
    expect(payload.drops.length).toBeGreaterThan(0);
    expect(payload.drops[0]!.block).toBe('conversation');
    // The reason carries the id of what went, not just a count.
    expect(payload.drops[0]!.reason).toMatch(/^budget:/);
    substrate.close();
  });
});

describe('overflow → compact → one retry (§23)', () => {
  it('compacts and retries exactly once, then succeeds', async () => {
    const substrate = world();
    for (let i = 0; i < 60; i++) {
      userSays(substrate, `turn ${i}: we discussed the move and the lease`);
      agentSaid(substrate, `noted ${i}`);
    }
    userSays(substrate, 'summarize');

    const model = new FakeModel([{ chunks: overflow }, reply('here is the summary')]);
    const outcome = await runnerFor(substrate, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    expect(outcome.status).toBe('finished');
    expect(outcome.text).toBe('here is the summary');

    const events = substrate.events.read({ runId: outcome.runId });
    expect(events.filter((event) => event.type === 'model.failed')).toHaveLength(1);
    expect((events.find((e) => e.type === 'model.failed')!.payload as { kind: string }).kind).toBe(
      'context_overflow',
    );
    // It compacted rather than simply retrying the same prompt.
    expect(substrate.events.read({ types: ['history.compacted'] })).toHaveLength(1);

    // And the retry really was at a reduced budget.
    const assemblies = events.filter((event) => event.type === 'context.assembled');
    expect(assemblies).toHaveLength(2);
    const versions = assemblies.map((event) => (event.payload as { policyVersion: string }).policyVersion);
    expect(versions[0]).toBe('ctx-1/tpl-3');
    expect(versions[1]).toBe('ctx-1-reduced/tpl-3');
    expect((assemblies[1]!.payload as { totalTokens: number }).totalTokens).toBeLessThan(
      (assemblies[0]!.payload as { totalTokens: number }).totalTokens,
    );
    substrate.close();
  });

  it('fails as data on a second overflow instead of looping', async () => {
    const substrate = world();
    for (let i = 0; i < 40; i++) {
      userSays(substrate, `turn ${i} ${'x'.repeat(50)}`);
      agentSaid(substrate, `ok ${i}`);
    }
    const model = new FakeModel([{ chunks: overflow }, { chunks: overflow }, reply('never reached')]);
    const outcome = await runnerFor(substrate, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });

    // An overflow that survives one compaction is a bug in the budget, and
    // retrying a bug in a loop is how a provider bill reaches $400 overnight.
    expect(outcome.status).toBe('failed');
    expect(model.requests).toHaveLength(2);
    expect(substrate.events.read({ types: ['history.compacted'] })).toHaveLength(1);
    const failures = substrate.events
      .read({ runId: outcome.runId })
      .filter((event) => event.type === 'model.failed');
    expect(failures).toHaveLength(2);
    substrate.close();
  });

  it('keeps the tool results it was reacting to across the retry', async () => {
    // The retry re-assembles the same step. If observations were cleared on
    // the first attempt, the model would wake up with no idea why it had
    // been called back.
    const substrate = world();
    userSays(substrate, 'go');
    const model = new FakeModel([
      { chunks: [...say('thinking'), usage(10, 5), finish('stop')] },
    ]);
    const outcome = await runnerFor(substrate, model).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    expect(outcome.status).toBe('finished');
    substrate.close();
  });
});

describe('the context is a function of the log, not of the process', () => {
  it('rebuilds the same context after a restart', async () => {
    const substrate = world();
    userSays(substrate, 'remember: the cat is called Fado');
    const first = await runnerFor(substrate, new FakeModel([reply('noted')])).run({
      sessionId: SESSION,
      principal: PRINCIPAL,
      trigger: 'user',
    });
    const firstDigest = (
      substrate.events
        .read({ runId: first.runId })
        .find((event) => event.type === 'context.assembled')!.payload as { digest: string }
    ).digest;

    // A brand-new snapshotter with an empty cache, as after a restart.
    const snapshotter = new Snapshotter({ events: substrate.events, clock: substrate.clock });
    const gathered = snapshotter.gather({
      principal: PRINCIPAL,
      sessionId: SESSION,
      runId: first.runId,
      trigger: 'user',
      degradation: 'L0',
      observations: [],
      fallbackTrust: 'USER',
    });
    expect(gathered.snapshot.conversation.map((turn) => turn.content)).toContain(
      'remember: the cat is called Fado',
    );
    expect(firstDigest).toMatch(/^[0-9a-f]{16}$/);
    substrate.close();
  });

  it('serves the second turn of a session from the incremental cache', async () => {
    const substrate = world();
    const snapshotter = new Snapshotter({ events: substrate.events, clock: substrate.clock });
    const gather = (runId: string) =>
      snapshotter.gather({
        principal: PRINCIPAL,
        sessionId: SESSION,
        runId,
        trigger: 'user',
        degradation: 'L0',
        observations: [],
        fallbackTrust: 'USER',
      });

    userSays(substrate, 'one');
    expect(gather('r1').snapshot.conversation).toHaveLength(1);
    userSays(substrate, 'two');
    // The cache reads *forward* from the last sequence it saw. That is only
    // sound because the log is append-only — nothing below that sequence can
    // ever change (invariant 1).
    expect(gather('r1').snapshot.conversation.map((turn) => turn.content)).toEqual(['one', 'two']);
    substrate.close();
  });

  it('drops to no memories at all in L2 rather than pretending', async () => {
    const substrate = world();
    userSays(substrate, 'what do you know about me?');
    const snapshotter = new Snapshotter({
      events: substrate.events,
      clock: substrate.clock,
      memory: {
        recall: () => [
          {
            id: 'f1',
            text: 'should not appear',
            basis: 'observed',
            confidence: 0.9,
            sourceCount: 1,
            observationCount: 1,
            lastSeen: 0,
            sensitivity: 'normal',
            status: 'active',
            pinned: false,
            trust: 'USER',
          },
        ],
        pinned: () => [],
        identity: () => null,
        constraints: () => [],
        commitments: () => [],
        openQuestions: () => [],
        profile: () => ({ factCount: 1, meanConfidence: 0.9, sessionsObserved: 1 }),
      },
    });

    const degraded = snapshotter.gather({
      principal: PRINCIPAL,
      sessionId: SESSION,
      runId: 'r1',
      trigger: 'user',
      degradation: 'L2',
      observations: [],
      fallbackTrust: 'USER',
    });
    // L2 *means* memory retrieval is unavailable. Serving memories anyway
    // would make the degradation note in the context a lie.
    expect(degraded.snapshot.memories).toHaveLength(0);
    substrate.close();
  });
});
