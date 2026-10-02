import { beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { ApprovalStore, SuspensionStore } from '../../src/capability/approvals.js';
import { Invoker } from '../../src/capability/invoke.js';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from '../../src/substrate/clock.js';
import { FakeModel, callTool, finish, say, usage } from '../fakes/model.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import { Ledger, makeChargeTool } from '../fakes/dangerous.js';
import type { EventType } from '../../src/substrate/events/types.js';

/**
 * §19, verbatim:
 *
 *   > This must survive a full process restart — it is a required test.
 *
 * "A new process" here means: every object thrown away, a different id seed,
 * a clock that has moved on, and a real file on disk as the only thing
 * carried across. If the suspension lived in memory, nothing below works.
 */

const DB = '/tmp/arish-m4-restart.db';
const SESSION = 'sess-restart';
const PRINCIPAL = 'user:ara';

/** One ledger survives the restart: it stands in for the outside world. */
let ledger: Ledger;

function wipe(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB}${suffix}`);
    } catch {
      /* first run */
    }
  }
}

interface Process {
  substrate: Substrate;
  approvals: ApprovalStore;
  suspensions: SuspensionStore;
  runner: Runner;
}

/** Boot a process: all new objects, same database file. */
function boot(model: FakeModel, options: { seed?: number; atHour?: number } = {}): Process {
  const clock = new FakeClock(`2026-04-01T${String(options.atHour ?? 9).padStart(2, '0')}:00:00Z`);
  const substrate = createTestSubstrate({ dbPath: DB, seed: options.seed ?? 1, clock });

  const approvals = new ApprovalStore(
    substrate.storage, substrate.events, substrate.clock, substrate.ids,
  );
  const suspensions = new SuspensionStore(substrate.storage, substrate.events, substrate.clock);

  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(makeChargeTool(ledger));

  const invoker = new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    approvals,
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

  const runner = new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
    invoker,
    approvals,
    suspensions,
  });

  return { substrate, approvals, suspensions, runner };
}

const chargeTurn = {
  chunks: [callTool('t1', 'payments.charge', { amount: 4200, to: 'acme' }), usage(10, 5), finish('tool-calls')],
};
const reply = (text: string) => ({ chunks: [...say(text), usage(5, 3), finish('stop')] });

beforeEach(() => {
  wipe();
  ledger = new Ledger();
});

describe('a suspended run survives a full process restart (§19)', () => {
  it('is visible to a brand-new process that has never seen it', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('done')]));
    const outcome = await first.runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    expect(outcome.status).toBe('suspended');
    first.substrate.close(); // ← the process dies here

    // Different seed, different clock, no shared objects at all.
    const second = boot(new FakeModel([reply('Paid.')]), { seed: 404, atHour: 11 });
    const pending = second.approvals.pending();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.preview).toBe('would charge $42.00 to acme');
    expect(second.suspensions.all()).toHaveLength(1);
    second.substrate.close();
  });

  it('resumes in the new process and produces the right answer', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('never reached')]));
    const suspended = await first.runner.run({
      sessionId: SESSION, principal: PRINCIPAL, trigger: 'user',
    });
    first.substrate.close();

    const second = boot(new FakeModel([reply('Paid $42.00 to acme.')]), { seed: 404, atHour: 11 });
    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });

    const resumed = await second.runner.resume(id);

    expect(resumed.status).toBe('finished');
    expect(resumed.text).toBe('Paid $42.00 to acme.');
    expect(resumed.runId).toBe(suspended.runId); // the same run, continued
    expect(ledger.charges).toHaveLength(1);
    second.substrate.close();
  });

  it('charges exactly once even though two processes were involved', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('x')]));
    await first.runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    first.substrate.close();

    const second = boot(new FakeModel([reply('done')]), { seed: 404, atHour: 11 });
    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await second.runner.resume(id);

    expect(ledger.charges).toHaveLength(1);
    // The outbox saw one effect, settled.
    const effects = second.substrate.storage.all<{ state: string }>('SELECT state FROM effects');
    expect(effects).toHaveLength(1);
    expect(effects[0]?.state).toBe('committed');
    second.substrate.close();
  });

  it('does not re-run work the first process already did', async () => {
    const first = boot(
      new FakeModel([
        { chunks: [callTool('t0', 'notes.write', { name: 'memo', content: 'before' }), usage(5, 2), finish('tool-calls')] },
        chargeTurn,
        reply('x'),
      ]),
    );
    await first.runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    first.substrate.close();

    const second = boot(new FakeModel([reply('done')]), { seed: 404, atHour: 11 });
    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await second.runner.resume(id);

    const writes = second.substrate.events
      .read({ types: ['tool.succeeded'] })
      .filter((e) => (e.payload as { tool: string }).tool === 'notes.write');
    expect(writes).toHaveLength(1);
    second.substrate.close();
  });

  it('keeps the whole story in one causal order under one runId', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('x')]));
    const suspended = await first.runner.run({
      sessionId: SESSION, principal: PRINCIPAL, trigger: 'user',
    });
    first.substrate.close();

    const second = boot(new FakeModel([reply('done')]), { seed: 404, atHour: 11 });
    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await second.runner.resume(id);

    const types = second.substrate.events.read({ runId: suspended.runId }).map((e) => e.type);
    const order: EventType[] = [
      'run.started', 'approval.requested', 'run.suspended',
      'approval.granted', 'run.resumed', 'effect.committed', 'run.finished',
    ];
    let cursor = -1;
    for (const type of order) {
      const at = types.indexOf(type, cursor + 1);
      expect(at, `${type} missing or out of order in [${types.join(', ')}]`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // Exactly one run, told as one story, across two processes.
    expect(second.substrate.events.read({ types: ['run.started'] })).toHaveLength(1);
    second.substrate.close();
  });

  it('continues under the budget it had already spent, not a fresh one', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('x')]));
    const suspended = await first.runner.run({
      sessionId: SESSION, principal: PRINCIPAL, trigger: 'user',
    });
    first.substrate.close();

    const second = boot(new FakeModel([reply('done')]), { seed: 404, atHour: 11 });
    const row = second.suspensions.all()[0]!;
    expect(row.spend.steps).toBe(suspended.steps);
    expect(row.spend.tokens).toBeGreaterThan(0);

    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    const resumed = await second.runner.resume(id);

    // Suspending must not be a way to get a new allowance.
    expect(resumed.steps).toBeGreaterThan(suspended.steps);
    expect(resumed.inputTokens + resumed.outputTokens).toBeGreaterThan(0);
    second.substrate.close();
  });

  it('a denial in the new process also resumes, without the effect', async () => {
    const first = boot(new FakeModel([chargeTurn, reply('x')]));
    await first.runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });
    first.substrate.close();

    const second = boot(new FakeModel([reply('I did not charge anything.')]), { seed: 404, atHour: 11 });
    const id = second.approvals.pending()[0]!.id;
    second.approvals.decide(id, { granted: false, scope: 'once', by: PRINCIPAL, reason: 'not now' });
    const resumed = await second.runner.resume(id);

    expect(resumed.status).toBe('finished');
    expect(ledger.charges).toHaveLength(0);
    expect(second.substrate.storage.all('SELECT * FROM effects')).toHaveLength(0);
    second.substrate.close();
  });
});
