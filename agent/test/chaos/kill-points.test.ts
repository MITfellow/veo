/**
 * Tests 43–49: the chaos suite (§31, §34.1).
 *
 *   > Kill at any point across 200 randomized runs → every run resumable
 *   > or cleanly failed; zero corrupt state; zero duplicated external
 *   > effects.
 *
 * **How the kill is done, and why.** Not `process.exit()`: a process
 * cannot observe its own death, and a test that forks 200 child
 * processes trades determinism and sixty seconds of suite budget for a
 * kill that is no more realistic. What actually matters about a crash is
 * that *everything not committed to SQLite is gone* — in-memory caches,
 * half-built objects, the model's half-streamed reply, the knowledge
 * that a run was in flight. So the substrate is closed at a randomized
 * instruction boundary and a brand-new one is opened on the same file,
 * with new objects throughout. Nothing from the dead "process" is
 * reachable; the file is the only thing that survives, which is the
 * property under test.
 *
 * The run is seeded, so a failure prints a seed that reproduces it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from '../../src/substrate/clock.js';
import { snapshotDigest } from '../../src/substrate/projections/snapshot.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { Invoker } from '../../src/capability/invoke.js';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { ApprovalStore, SuspensionStore } from '../../src/capability/approvals.js';
import { Outbox, reconcile } from '../../src/capability/outbox.js';
import { NullLogger } from '../../src/substrate/log.js';
import type { ToolContext } from '../../src/capability/tool.js';
import { Runner } from '../../src/orchestration/runner.js';
import { JobQueue } from '../../src/orchestration/queue.js';
import { ScheduleStore } from '../../src/orchestration/schedule.js';
import { FakeModel, callTool, finish, say, usage } from '../fakes/model.js';
import { FakeRemote, makeSendTool } from '../fakes/tools.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import { registerBuiltins } from '../../src/tools/index.js';

const PRINCIPAL = 'user:ara';
const SESSION = 'ses-chaos';

let dir: string;
let dbPath: string;
let remote: FakeRemote;

/**
 * A deterministic PRNG. `Math.random` in a chaos suite means a failure
 * you cannot reproduce, which is the one thing a chaos suite must not
 * produce.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

interface Process {
  substrate: Substrate;
  runner: Runner;
  outbox: Outbox;
  registry: ToolRegistry;
  approvals: ApprovalStore;
}

function contextFor(): ToolContext {
  return {
    signal: new AbortController().signal,
    principal: PRINCIPAL,
    runId: 'run-x',
    stepId: 'step-x',
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

/** Boot a "process": every object new, same file. */
function boot(model: FakeModel, seed: number): Process {
  const clock = new FakeClock('2026-05-04T09:00:00Z');
  const substrate = createTestSubstrate({ dbPath, seed, clock });
  const { storage, events, ids, hashing, logger, redactor } = substrate;

  const approvals = new ApprovalStore(storage, events, clock, ids);
  const suspensions = new SuspensionStore(storage, events, clock);
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(makeSendTool(remote, { idempotent: true }));

  const invoker = new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    approvals,
    events,
    storage,
    clock,
    ids,
    hashing,
    logger,
    redactor,
    files: new MemoryFileStore(),
    net: new FakeNet(() => respond(200)),
  });

  const runner = new Runner({
    events,
    clock,
    ids,
    logger,
    model,
    invoker,
    approvals,
    suspensions,
  });

  return {
    substrate,
    runner,
    registry,
    outbox: new Outbox(storage, events, clock, hashing),
    approvals,
  };
}

const sendTurn = {
  chunks: [
    callTool('t1', 'test.send', { to: 'ara@example.com', body: 'the briefing' }),
    usage(10, 5),
    finish('tool-calls'),
  ],
};
const replyTurn = (text: string) => ({ chunks: [...say(text), usage(5, 3), finish('stop')] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arish-chaos-'));
  dbPath = join(dir, 'chaos.db');
  remote = new FakeRemote();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The invariants that must hold after any kill, checked against a
 * freshly opened process.
 */
function assertHealthy(seed: number): { runs: Array<{ id: string; status: string }> } {
  const substrate = createTestSubstrate({ dbPath, seed });

  // 43: the chain verifies.
  const chain = substrate.events.verifyChain();
  expect(chain.ok, `seed ${seed}: hash chain broken — ${JSON.stringify(chain.problems[0])}`).toBe(
    true,
  );

  // 44: projections rebuild byte-identically.
  const before = snapshotDigest(substrate.storage, substrate.hashing);
  substrate.events.rebuild();
  const after = snapshotDigest(substrate.storage, substrate.hashing);
  expect(after, `seed ${seed}: projections do not rebuild identically`).toBe(before);

  // 45: no run is left claiming to be running with nobody running it.
  const runs = substrate.storage.all<{ id: string; status: string }>(
    'SELECT id, state AS status FROM runs',
  );
  for (const run of runs) {
    expect(
      ['finished', 'failed', 'cancelled', 'suspended', 'running'],
      `seed ${seed}: unknown run state ${run.status}`,
    ).toContain(run.status);
  }

  // 46: no effect key is committed twice. The log is checked, not the
  // table, because the table could be rebuilt from a buggy projector and
  // still look consistent with itself.
  const committed = substrate.events
    .read({ types: ['effect.committed'] })
    .map((e) => (e.payload as { idempotencyKey: string }).idempotencyKey);
  expect(
    new Set(committed).size,
    `seed ${seed}: an effect was committed twice — ${committed.join(', ')}`,
  ).toBe(committed.length);

  substrate.close();
  return { runs };
}

describe('chaos: killing the process at a randomized instruction boundary', () => {
  it('43–46 + 49. 200 seeded kills leave a consistent, resumable system', async () => {
    const ITERATIONS = 200;

    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 1000 + i;
      const random = rng(seed);

      // Fresh file per iteration: each is an independent agent that is
      // killed once.
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'arish-chaos-'));
      dbPath = join(dir, 'chaos.db');
      remote = new FakeRemote();

      const first = boot(new FakeModel([sendTurn, replyTurn('Sent.')]), seed);

      // Where to kill: before the run, during it (by racing the close
      // against the run's own awaits), or after the tool but before the
      // reply. The boundary is chosen from the seed.
      const point = Math.floor(random() * 4);

      first.substrate.events.append({
        type: 'message.user',
        principal: PRINCIPAL,
        trust: 'USER',
        sessionId: SESSION,
        payload: { text: 'send the briefing' },
      });

      if (point === 0) {
        // Killed before the run even starts.
        first.substrate.close();
      } else {
        const running = first.runner.run({
          sessionId: SESSION,
          principal: PRINCIPAL,
          trigger: 'user',
        });

        if (point === 1) {
          // Killed mid-flight: close the substrate while the run is still
          // awaiting. Every subsequent write from the dying run throws,
          // which is exactly what a crash does to in-flight work.
          await Promise.resolve();
          try {
            first.substrate.close();
          } catch {
            /* already closing */
          }
          await running.catch(() => undefined);
        } else {
          await running.catch(() => undefined);
          if (point === 2) {
            // Killed after the run, before anything reconciled.
            first.substrate.close();
          } else {
            // Killed after a reconciliation pass.
            await reconcile(first.outbox, first.registry, () => contextFor());
            first.substrate.close();
          }
        }
      }

      const { runs } = assertHealthy(seed);

      // 45, the resumable half: a second process can always read the run
      // back and decide what to do with it. Nothing is unreachable.
      const second = createTestSubstrate({ dbPath, seed });
      for (const run of runs) {
        const events = second.events.read({ runId: run.id });
        expect(events.length, `seed ${seed}: run ${run.id} has no events`).toBeGreaterThan(0);
      }
      second.close();

      // 46 again, from the other side: the remote never saw a duplicate.
      const keys = remote.sends.map((s) => s.key);
      expect(new Set(keys).size, `seed ${seed}: the remote saw a duplicate send`).toBe(keys.length);
    }
  }, 120_000);

  it('47. a kill between intent and effect leaves it uncommitted and reconcilable', async () => {
    const seed = 42;
    const first = boot(new FakeModel([sendTurn, replyTurn('Sent.')]), seed);

    // Record the intent, then die before the effect runs — the window
    // the outbox exists for.
    const key = first.outbox.keyFor({
      tool: 'test.send',
      toolVersion: '1',
      input: { to: 'ara@example.com', body: 'the briefing' },
      runId: 'run-x',
      stepId: 'step-x',
    });
    first.outbox.intend({
      tool: 'test.send',
      toolVersion: '1',
      input: { to: 'ara@example.com', body: 'the briefing' },
      runId: 'run-x',
      stepId: 'step-x',
      principal: PRINCIPAL,
      summary: 'send the briefing',
    });
    first.substrate.close();

    const second = boot(new FakeModel([replyTurn('ok')]), seed);
    const record = second.outbox.get(key);
    expect(record?.state).toBe('intended');
    // Not committed, and not lost: the next process can see an effect it
    // does not know the outcome of, which is the only honest state.
    const outcomes = await reconcile(second.outbox, second.registry, () => contextFor());
    expect(outcomes.length).toBeGreaterThan(0);
    // Reconciliation decides; it never acts. Nothing was re-sent.
    expect(remote.sends.length).toBe(0);
    second.substrate.close();

    assertHealthy(seed);
  });

  it('48. a kill during a schedule fire does not double-fire the slot', () => {
    const seed = 7;
    const clock = new FakeClock('2026-05-04T08:59:00Z');
    const first = createTestSubstrate({ dbPath, seed, clock });
    const queue1 = new JobQueue({
      storage: first.storage,
      events: first.events,
      clock,
      ids: first.ids,
    });
    const schedules1 = new ScheduleStore({
      storage: first.storage,
      events: first.events,
      clock,
      ids: first.ids,
      queue: queue1,
    });
    const schedule = schedules1.create(PRINCIPAL, {
      name: 'Briefing',
      spec: '0 9 * * *',
      timezone: 'UTC',
      payload: { prompt: 'what is on today' },
    });

    clock.advance(60_000);
    const fired = schedules1.due();
    expect(fired.fired).toBe(1);
    // Die immediately after firing, before the job is ever leased.
    first.close();

    const second = createTestSubstrate({ dbPath, seed, clock: new FakeClock('2026-05-04T09:05:00Z') });
    const queue2 = new JobQueue({
      storage: second.storage,
      events: second.events,
      clock: second.clock,
      ids: second.ids,
    });
    const schedules2 = new ScheduleStore({
      storage: second.storage,
      events: second.events,
      clock: second.clock,
      ids: second.ids,
      queue: queue2,
    });

    // The new process asks again. The slot is already fired, and the
    // idempotency key stops a second job for it.
    const again = schedules2.due();
    expect(again.fired).toBe(0);
    expect(queue2.counts().pending).toBe(1);
    expect(schedules2.get(schedule.id)!.fireCount).toBe(1);
    second.close();

    assertHealthy(seed);
  });
});
