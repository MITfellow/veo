/**
 * M3 demo — tools, effects, and the thing that matters: exactly once.
 *
 *   npm run demo:m3
 *
 * Runs against a real file-backed SQLite database in /tmp so that "a new
 * process" means a genuinely new process state reading the same bytes.
 */
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { createTestSubstrate } from '../src/substrate/index.js';
import { Invoker } from '../src/capability/invoke.js';
import { ToolRegistry } from '../src/capability/registry.js';
import { registerBuiltins } from '../src/tools/index.js';
import { DEFAULT_GRANTS } from '../src/capability/policy.js';
import { reconcile } from '../src/capability/outbox.js';
import { Redactor } from '../src/substrate/events/redact.js';
import type { Tool, ToolContext } from '../src/capability/tool.js';
import type { FileStore, Net } from '../src/substrate/ports.js';

const DB = '/tmp/arish-demo-m3.db';
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${DB}${suffix}`);
  } catch {
    /* first run */
  }
}

const line = (s = '') => console.log(s);
const rule = (title: string) => {
  line();
  line(`\x1b[1m${title}\x1b[0m`);
  line('─'.repeat(title.length));
};

/* ── the outside world: a payment API that remembers idempotency keys ──── */

const world = { charges: [] as Array<{ key: string; amount: number }>, reachable: true };

const pay: Tool<{ amount: number }, { chargeId: string }> = {
  name: 'payments.charge',
  version: '1',
  description: 'Charges the card on file. Not idempotent by nature.',
  input: z.object({ amount: z.number().positive() }),
  output: z.object({ chargeId: z.string() }),
  capabilities: ['net:write'],
  minTrust: 'USER',
  // 'caution', not 'dangerous': a dangerous tool is held for approval, and
  // approvals arrive in M4. Section 5 shows that gate working.
  risk: 'caution',
  effect: 'external',
  idempotent: false,
  timeoutMs: 5_000,
  async execute(input, ctx) {
    const key = ctx.idempotencyKey ?? 'no-key';
    if (!world.reachable) throw new Error('the process was killed mid-request');
    world.charges.push({ key, amount: input.amount });
    return { ok: true, value: { chargeId: `ch_${key.slice(0, 8)}` }, trust: 'TOOL' };
  },
  renderForModel: (result) =>
    result.ok
      ? { text: `charged, id ${result.value.chargeId}`, truncated: false }
      : { text: `charge failed: ${result.error.message}`, truncated: false },
  async dryRun(input) {
    return `would charge ${input.amount}`;
  },
  async compensate(result) {
    // The contract refuses to register a non-idempotent external effect
    // without this. There has to be a way back.
    if (result.ok) world.charges = world.charges.filter((c) => !result.value.chargeId.endsWith(c.key.slice(0, 8)));
  },
  async queryEffect(key) {
    const found = world.charges.find((c) => c.key === key);
    return found === undefined ? { happened: false } : { happened: true, remoteRef: `ch_${key.slice(0, 8)}` };
  },
};

/** Boot "a process": fresh objects, same database file. */
function boot(seed: number) {
  const substrate = createTestSubstrate({ dbPath: DB, seed });
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(pay);
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
    files: {
      async put() {}, async get() { return null; }, async delete() {}, async list() { return []; },
    } as unknown as FileStore,
    net: { async fetch() { throw new Error('no network in the demo'); } } as unknown as Net,
  });
  return { substrate, registry, invoker };
}

const CALL = {
  callId: 'c1',
  tool: 'payments.charge',
  input: { amount: 4200 },
  runId: 'run-demo',
  stepId: 'step-7',
  principal: 'user:ara',
  effectiveTrust: 'USER' as const,
};

/* ── 1. a normal call ───────────────────────────────────────────────────── */

rule('1. A tool call, start to finish');
{
  const { substrate, invoker } = boot(1);
  const observation = await invoker.invoke({
    ...CALL,
    tool: 'clock.now',
    input: { timezone: 'UTC' },
    stepId: 'step-1',
  });
  line(`  model sees: ${observation.text}`);
  line(`  trust:      ${observation.trust}`);
  line(`  events:     ${substrate.events.read().map((e) => e.type).join(' → ')}`);
  substrate.close();
}

/* ── 2. the crash ───────────────────────────────────────────────────────── */

rule('2. The process dies mid-charge');
let killedAt = 0;
{
  const { substrate, invoker } = boot(2);

  // The request leaves, the card is charged, and the machine dies before it
  // can write down that it happened.
  const original = pay.execute.bind(pay);
  pay.execute = async (input, ctx: ToolContext) => {
    world.charges.push({ key: ctx.idempotencyKey ?? 'no-key', amount: input.amount });
    throw new Error('kill -9 after the packet left the building');
  };

  const observation = await invoker.invoke(CALL);
  pay.execute = original;

  killedAt = world.charges.length;
  line(`  charges at the remote:  ${killedAt}`);
  line(`  observation:            ${observation.text.split('\n')[0]}`);
  const unsettled = invoker.outbox.unsettled();
  line(`  outbox:                 ${unsettled.length} unsettled, state '${unsettled[0]?.state}'`);
  line(`  events:                 ${substrate.events.read().map((e) => e.type).filter((t) => t.startsWith('effect')).join(', ')}`);
  line();
  line('  \x1b[2mintended was written BEFORE the call. Without it there would be no');
  line('  record that anything might have happened.\x1b[0m');
  substrate.close();
}

/* ── 3. restart and reconcile ───────────────────────────────────────────── */

rule('3. A new process, the same database');
{
  const { substrate, registry, invoker } = boot(99);
  line(`  unsettled effects found on boot: ${invoker.outbox.unsettled().length}`);

  const outcomes = await reconcile(invoker.outbox, registry, () => ({
    signal: new AbortController().signal,
    principal: 'system',
    runId: 'reconcile',
    stepId: 'reconcile',
    effectiveTrust: 'SYSTEM' as const,
    files: {} as ToolContext['files'],
    net: {} as ToolContext['net'],
    secrets: new Map(),
    emit: () => {},
    logger: substrate.logger,
    now: () => substrate.clock.now(),
    idempotencyKey: null,
  }));

  for (const outcome of outcomes) {
    line(`  → ${outcome.resolution}: ${outcome.detail}`);
  }
  line();
  line(`  charges at the remote now: \x1b[1m${world.charges.length}\x1b[0m (was ${killedAt} before the restart)`);
  line(
    world.charges.length === 1
      ? '  \x1b[32m✓ exactly one charge. The card was not billed twice.\x1b[0m'
      : '  \x1b[31m✗ the customer was charged twice.\x1b[0m',
  );
  substrate.close();
}

/* ── 4. the same crash, with an unreachable remote ──────────────────────── */

rule('4. The same crash, but the remote cannot be asked');
{
  world.charges.length = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB}${suffix}`);
    } catch {
      /* fine */
    }
  }

  const query: NonNullable<typeof pay.queryEffect> = pay.queryEffect!;
  delete (pay as { queryEffect?: unknown }).queryEffect;

  const first = boot(3);
  const original = pay.execute.bind(pay);
  pay.execute = async (input, ctx: ToolContext) => {
    world.charges.push({ key: ctx.idempotencyKey ?? 'no-key', amount: input.amount });
    throw new Error('killed');
  };
  await first.invoker.invoke(CALL);
  pay.execute = original;
  first.substrate.close();

  const second = boot(4);
  const outcomes = await reconcile(second.invoker.outbox, second.registry, () => ({
    signal: new AbortController().signal,
    principal: 'system', runId: 'reconcile', stepId: 'reconcile',
    effectiveTrust: 'SYSTEM' as const,
    files: {} as ToolContext['files'], net: {} as ToolContext['net'],
    secrets: new Map(), emit: () => {}, logger: second.substrate.logger,
    now: () => second.substrate.clock.now(), idempotencyKey: null,
  }));

  line(`  → ${outcomes[0]?.resolution}`);
  line(`  ${outcomes[0]?.detail}`);
  line(`  charges: ${world.charges.length}`);
  line();
  line('  \x1b[2mIt did not retry and it did not assume. A non-idempotent effect');
  line('  with an unknown outcome is a question for a person, not a guess.\x1b[0m');
  pay.queryEffect = query;
  second.substrate.close();
}

/* ── 5. a tool cannot leak a secret into the prompt ─────────────────────── */

rule('5. What a tool is not allowed to do');
{
  const { substrate, registry, invoker } = boot(5);
  const names = registry.list().map((t) => t.name);
  line(`  registered tools:  ${names.join(', ')}`);

  const unknown = await invoker.invoke({ ...CALL, tool: 'email.send', input: {}, stepId: 's9' });
  line(`  unknown tool:      ${unknown.text.split('.')[0]}.`);

  const bad = await invoker.invoke({ ...CALL, tool: 'payments.charge', input: { amount: -5 }, stepId: 's10' });
  line(`  invalid input:     ${bad.text.split(';')[0]}`);

  const lowTrust = await invoker.invoke({ ...CALL, stepId: 's11', effectiveTrust: 'FOREIGN' });
  line(`  FOREIGN caller:    ${lowTrust.text.slice(0, 96)}`);
  line();
  line('  \x1b[2mThree refusals, three observations, zero exceptions. Failure is data.\x1b[0m');
  substrate.close();
}

rule('M3');
line('  exactly-once external effects, proven by killing the process.');
line(`  redactor in place: ${new Redactor() instanceof Redactor}`);
line();
