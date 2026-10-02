import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { rmSync } from 'node:fs';
import { Invoker } from '../../src/capability/invoke.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { idempotencyKey, reconcile } from '../../src/capability/outbox.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { FakeClock } from '../../src/substrate/clock.js';
import { NullLogger } from '../../src/substrate/log.js';
import type { Substrate } from '../../src/substrate/index.js';
import type { ToolContext } from '../../src/capability/tool.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import { FakeRemote, makeSendTool } from '../fakes/tools.js';

/**
 * The M3 bar (§33):
 *
 *   > killing the process mid-external-effect and restarting produces
 *   > **exactly one** effect, provably.
 *
 * The temptation in this area is to retry: it is one line, it usually works,
 * and when it does not work somebody gets charged twice. These tests exist
 * to make that line impossible to add without going red.
 */

const RUN = 'run-1';
const STEP = 'step-1';
const DB = '/tmp/arish-m3-outbox.db';

function wipe(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB}${suffix}`);
    } catch {
      /* first run */
    }
  }
}

interface World {
  substrate: Substrate;
  invoker: Invoker;
  registry: ToolRegistry;
}

/** A "process": its own substrate, registry and invoker over one database. */
function boot(remote: FakeRemote, options: { dbPath?: string; seed?: number; queryable?: boolean; idempotent?: boolean } = {}): World {
  const clock = new FakeClock('2026-04-01T09:00:00Z');
  const substrate = createTestSubstrate({
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    seed: options.seed ?? 1,
    clock,
  });
  const registry = new ToolRegistry().register(
    makeSendTool(remote, {
      ...(options.queryable !== undefined ? { queryable: options.queryable } : {}),
      ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
    }),
  );
  const invoker = new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    events: substrate.events,
    storage: substrate.storage,
    clock: substrate.clock,
    ids: substrate.ids,
    hashing: substrate.hashing,
    logger: substrate.logger,
    redactor: substrate.redactor,
    files: new MemoryFileStore(),
    net: new FakeNet(() => respond(200)),
  });
  return { substrate, invoker, registry };
}

const send = (world: World, body = 'hello', stepId = STEP) =>
  world.invoker.invoke({
    callId: 'c1',
    tool: 'test.send',
    input: { to: 'ara@example.com', body },
    runId: RUN,
    stepId,
    principal: 'user:ara',
    effectiveTrust: 'USER',
  });

function contextFor(): ToolContext {
  return {
    signal: new AbortController().signal,
    principal: 'system',
    runId: RUN,
    stepId: STEP,
    effectiveTrust: 'SYSTEM',
    files: {} as ToolContext['files'],
    net: {} as ToolContext['net'],
    secrets: new Map(),
    emit: () => {},
    logger: new NullLogger(),
    now: () => 0,
    idempotencyKey: null,
  };
}

beforeEach(wipe);

describe('the idempotency key (§18)', () => {
  it('is hash(tool, version, canonicalInput, stepId)', () => {
    const substrate = createTestSubstrate();
    const h = substrate.hashing;
    const key = idempotencyKey(h, 'test.send', '1', { to: 'a', body: 'b' }, 'step-1');
    expect(key).toHaveLength(64);
    expect(key).toBe(idempotencyKey(h, 'test.send', '1', { to: 'a', body: 'b' }, 'step-1'));
    substrate.close();
  });

  it('ignores key ORDER in the input — the same call is the same effect', () => {
    const substrate = createTestSubstrate();
    const h = substrate.hashing;
    // This is why canonicalJson has existed since M0: {a,b} and {b,a} must
    // not produce two payments.
    expect(idempotencyKey(h, 't', '1', { to: 'a', body: 'b' }, 's')).toBe(
      idempotencyKey(h, 't', '1', { body: 'b', to: 'a' }, 's'),
    );
    substrate.close();
  });

  it('differs by step, so a deliberate second send is still possible', () => {
    const substrate = createTestSubstrate();
    const h = substrate.hashing;
    // "Send the same email twice, on purpose, in two steps" must remain
    // expressible. Keying on input alone would silently make the second a
    // no-op, which is a different wrong answer.
    expect(idempotencyKey(h, 't', '1', { x: 1 }, 'step-1')).not.toBe(
      idempotencyKey(h, 't', '1', { x: 1 }, 'step-2'),
    );
    substrate.close();
  });

  it('differs by tool version, because a new version may behave differently', () => {
    const substrate = createTestSubstrate();
    const h = substrate.hashing;
    expect(idempotencyKey(h, 't', '1', { x: 1 }, 's')).not.toBe(
      idempotencyKey(h, 't', '2', { x: 1 }, 's'),
    );
    substrate.close();
  });
});

describe('the two phases', () => {
  it('writes effect.intended BEFORE the effect runs', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    let logAtSendTime: string[] = [];
    remote.crashOnSend = () => {
      logAtSendTime = world.substrate.events.read().map((e) => e.type);
    };
    await send(world);

    // If the process dies during the send, the log must already say we
    // intended it. Otherwise there is no record that anything might have
    // happened, and the effect becomes invisible.
    expect(logAtSendTime).toContain('effect.intended');
    expect(logAtSendTime).not.toContain('effect.committed');
    world.substrate.close();
  });

  it('commits with the remote reference on success', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);

    const types = world.substrate.events.read().map((e) => e.type);
    expect(types).toContain('effect.committed');
    const record = world.invoker.outbox.unsettled();
    expect(record).toHaveLength(0);
    expect(remote.count).toBe(1);
    world.substrate.close();
  });

  it('records the intent and the step in ONE transaction', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);
    const row = world.substrate.storage.get<{ state: string }>(
      'SELECT state FROM effects LIMIT 1',
    );
    expect(row?.state).toBe('committed');
    // The outbox row and the event agree because they were written together.
    const intended = world.substrate.events.read({ types: ['effect.intended'] }).at(0);
    expect(intended).toBeDefined();
    world.substrate.close();
  });
});

describe('a crash between intend and commit — the M3 bar', () => {
  it('leaves the effect unsettled, not silently lost', async () => {
    const remote = new FakeRemote();
    const world = boot(remote, { dbPath: DB });
    remote.crashOnSend = () => {
      throw new Error('process died mid-send');
    };
    await send(world);

    const unsettled = world.invoker.outbox.unsettled();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]?.state).toBe('intended');
    world.substrate.close();
  });

  it('CONFIRMS with a queryable remote and does not send again', async () => {
    const remote = new FakeRemote();

    // ── process 1: the send reaches the remote, then we die before commit ──
    const first = boot(remote, { dbPath: DB });
    remote.crashOnSend = (key) => {
      remote.sends.push({ key, to: 'ara@example.com', body: 'hello' }); // it DID arrive
      throw new Error('killed after the packet left, before we recorded it');
    };
    await send(first);
    expect(remote.count).toBe(1);
    first.substrate.close();

    // ── process 2: a new everything, same database ────────────────────────
    const second = boot(remote, { dbPath: DB, seed: 77 });
    remote.crashOnSend = null;
    const outcomes = await reconcile(
      second.invoker.outbox,
      second.registry,
      () => contextFor(),
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.resolution).toBe('confirmed');
    expect(outcomes[0]?.detail).toContain('not run again');

    // THE BAR: exactly one effect.
    expect(remote.count).toBe(1);
    expect(second.invoker.outbox.unsettled()).toHaveLength(0);
    expect(second.invoker.outbox.get(outcomes[0]!.key)?.state).toBe('committed');
    second.substrate.close();
  });

  it('runs it when the remote confirms it did NOT happen — still exactly one', async () => {
    const remote = new FakeRemote();

    const first = boot(remote, { dbPath: DB });
    remote.crashOnSend = () => {
      throw new Error('killed before the packet left');
    };
    await send(first);
    expect(remote.count).toBe(0); // it genuinely never happened
    first.substrate.close();

    const second = boot(remote, { dbPath: DB, seed: 77 });
    remote.crashOnSend = null;
    const outcomes = await reconcile(second.invoker.outbox, second.registry, () => contextFor());
    expect(outcomes[0]?.resolution).toBe('did-not-happen');

    // Reconciliation decides; it does not act. The normal path then runs it.
    await send(second);
    expect(remote.count).toBe(1);
    second.substrate.close();
  });

  it('ASKS THE PERSON when the remote cannot be queried, and retries NOTHING', async () => {
    const remote = new FakeRemote();

    const first = boot(remote, { dbPath: DB, queryable: false });
    remote.crashOnSend = (key) => {
      remote.sends.push({ key, to: 'ara@example.com', body: 'hello' });
      throw new Error('killed after the packet left');
    };
    await send(first);
    first.substrate.close();

    const second = boot(remote, { dbPath: DB, seed: 77, queryable: false });
    remote.crashOnSend = null;
    const outcomes = await reconcile(second.invoker.outbox, second.registry, () => contextFor());

    expect(outcomes[0]?.resolution).toBe('needs-attention');
    expect(outcomes[0]?.detail).toContain('Nothing was retried');

    // Still exactly one. The machine did not guess.
    expect(remote.count).toBe(1);
    const attention = second.invoker.outbox.needingAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]?.note).toContain('cannot be queried');

    // And the person is actually told, in the log, in words.
    const raised = second.substrate.events.read({ types: ['error.raised'] }).at(-1);
    expect((raised?.payload as { message: string }).message).toContain('has NOT been retried');
    second.substrate.close();
  });

  it('treats an idempotent tool as safe to re-run', async () => {
    const remote = new FakeRemote();
    const first = boot(remote, { dbPath: DB, queryable: false, idempotent: true });
    remote.crashOnSend = () => {
      throw new Error('killed');
    };
    await send(first);
    first.substrate.close();

    const second = boot(remote, { dbPath: DB, seed: 77, queryable: false, idempotent: true });
    remote.crashOnSend = null;
    const outcomes = await reconcile(second.invoker.outbox, second.registry, () => contextFor());
    expect(outcomes[0]?.resolution).toBe('re-runnable');
    expect(second.invoker.outbox.needingAttention()).toHaveLength(0);
    second.substrate.close();
  });

  it('escalates when the tool is no longer registered', async () => {
    const remote = new FakeRemote();
    const first = boot(remote, { dbPath: DB });
    remote.crashOnSend = () => {
      throw new Error('killed');
    };
    await send(first);
    first.substrate.close();

    const second = boot(remote, { dbPath: DB, seed: 77 });
    const empty = new ToolRegistry(); // the tool was removed in an upgrade
    const outcomes = await reconcile(second.invoker.outbox, empty, () => contextFor());
    expect(outcomes[0]?.resolution).toBe('needs-attention');
    expect(outcomes[0]?.detail).toContain('not registered');
    second.substrate.close();
  });
});

describe('replaying a step never doubles an effect', () => {
  it('the same input in the same step sends once', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world, 'hello');
    const second = await send(world, 'hello'); // identical call, same step
    expect(remote.count).toBe(1);
    expect(second.text).toContain('not run a second time');
    world.substrate.close();
  });

  it('the same input in a DIFFERENT step sends twice, deliberately', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world, 'hello', 'step-1');
    await send(world, 'hello', 'step-2');
    // Saying the same thing twice on purpose must remain possible.
    expect(remote.count).toBe(2);
    world.substrate.close();
  });
});

describe('the outbox record cannot be erased', () => {
  it('refuses a delete, because that erases evidence an effect may have happened', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);
    expect(() => world.substrate.storage.run('DELETE FROM effects')).toThrow(/append-only/);
    world.substrate.close();
  });

  it('refuses to un-settle a committed effect', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);
    expect(() =>
      world.substrate.storage.run(`UPDATE effects SET state = 'intended'`),
    ).toThrow(/cannot return to intended/);
    world.substrate.close();
  });

  it('refuses to rewrite an idempotency key', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);
    expect(() =>
      world.substrate.storage.run(`UPDATE effects SET idempotency_key = 'forged'`),
    ).toThrow(/identity of the effect/);
    world.substrate.close();
  });
});

describe('compensation', () => {
  it('records that a committed effect was deliberately undone', async () => {
    const remote = new FakeRemote();
    const world = boot(remote);
    await send(world);
    const key = world.substrate.storage.get<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM effects LIMIT 1',
    )!.idempotency_key;

    world.invoker.outbox.compensated(key, 'the user changed their mind', 'user:ara');
    expect(world.invoker.outbox.get(key)?.state).toBe('compensated');
    const event = world.substrate.events.read({ types: ['effect.compensated'] }).at(0);
    expect((event?.payload as { reason: string }).reason).toBe('the user changed their mind');
    world.substrate.close();
  });
});
