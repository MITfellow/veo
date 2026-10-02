import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { Invoker } from '../../src/capability/invoke.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { createTestSecurity } from '../../src/security/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import {
  echoTool,
  firehoseTool,
  hangingTool,
  liarTool,
  spenderTool,
  throwerTool,
} from '../fakes/tools.js';

let substrate: Substrate;
let registry: ToolRegistry;
let invoker: Invoker;
let files: MemoryFileStore;

const RUN = 'run-1';
const STEP = 'step-1';

function makeInvoker(extra: Partial<ConstructorParameters<typeof Invoker>[0]> = {}): Invoker {
  return new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    events: substrate.events,
    storage: substrate.storage,
    clock: substrate.clock,
    ids: substrate.ids,
    hashing: substrate.hashing,
    logger: substrate.logger,
    redactor: substrate.redactor,
    files,
    net: new FakeNet(() => respond(200, 'ok')),
    ...extra,
  });
}

beforeEach(() => {
  substrate = createTestSubstrate();
  files = new MemoryFileStore();
  registry = new ToolRegistry();
  registerBuiltins(registry);
  registry
    .register(echoTool)
    .register(liarTool)
    .register(throwerTool)
    .register(hangingTool)
    .register(spenderTool)
    .register(firehoseTool);
  invoker = makeInvoker();
});

const call = (overrides: Partial<Parameters<Invoker['invoke']>[0]> = {}) =>
  invoker.invoke({
    callId: 'c1',
    tool: 'test.echo',
    input: { text: 'hello' },
    runId: RUN,
    stepId: STEP,
    principal: 'user:ara',
    effectiveTrust: 'USER',
    ...overrides,
  });

const types = (): string[] => substrate.events.read({ runId: RUN }).map((e) => e.type);

describe('the happy path', () => {
  it('validates, executes, records and renders', async () => {
    const observation = await call();
    expect(observation.ok).toBe(true);
    expect(observation.text).toBe('hello');
    expect(types()).toEqual(['tool.started', 'tool.succeeded']);
  });

  it('records the result trust on the event, not the step trust', async () => {
    await call({ tool: 'test.firehose', input: { size: 10 } });
    const succeeded = substrate.events.read({ runId: RUN, types: ['tool.succeeded'] }).at(0);
    // A FOREIGN result stays FOREIGN in the log, so the lattice sees it on
    // the next step. This is how "a web page cannot spend your money" holds
    // across a tool boundary, not just a model boundary.
    expect(succeeded?.trust).toBe('FOREIGN');
    expect((succeeded?.payload as { resultTrust: string }).resultTrust).toBe('FOREIGN');
  });
});

describe('every failure is an observation, never an exception', () => {
  it('an unknown tool comes back as text naming what IS available', async () => {
    const observation = await call({ tool: 'test.nonexistent' });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('no tool called');
    expect(observation.text).toContain('clock.now'); // tells the model what it CAN use
  });

  it('bad input tells the model exactly which field was wrong', async () => {
    const observation = await call({ input: { text: 42 } });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('text');
    expect(types()).toContain('tool.failed');
  });

  it('bad OUTPUT is caught and the result is discarded', async () => {
    const observation = await call({ tool: 'test.liar', input: {} });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('does not match its declared output');
    // A tool whose remote changed shape must fail at its own boundary rather
    // than feed malformed data into the model and the memory.
    expect(observation.text).toContain('discarded');
    const failed = substrate.events.read({ runId: RUN, types: ['tool.failed'] }).at(0);
    expect((failed?.payload as { kind: string }).kind).toBe('invalid_output');
  });

  it('a tool that throws does not escape', async () => {
    const observation = await call({ tool: 'test.thrower', input: {} });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('badly written tool');
    expect(types()).toContain('tool.failed');
  });

  it('a tool that hangs is killed by its timeout', async () => {
    const started = Date.now();
    const observation = await call({ tool: 'test.hangs', input: {} });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(observation.text).toContain('did not finish within 40ms');
    // It ignores its AbortSignal, and is still bounded: nothing waits for it.
    expect(types()).toContain('tool.timedout');
  });
});

describe('the gates', () => {
  it('refuses a capability the trust level does not permit, and explains', async () => {
    const observation = await call({
      tool: 'test.spend',
      input: { amount: 100 },
      effectiveTrust: 'FOREIGN',
    });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('FOREIGN');
    expect(observation.text).toMatch(/spend|credentials, money/);
    expect(types()).toContain('policy.denied');
  });

  it('refuses when minTrust is not met, naming the trust level', async () => {
    const observation = await call({ tool: 'notes.write', input: { name: 'n', content: 'x' }, effectiveTrust: 'FOREIGN' });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('requires DERIVED trust');
    expect(observation.text).toContain('FOREIGN');
  });

  it('allows the same call at sufficient trust', async () => {
    const observation = await call({
      tool: 'notes.write',
      input: { name: 'note', content: 'hello' },
      effectiveTrust: 'USER',
    });
    expect(observation.ok).toBe(true);
  });

  it('refuses a dangerous tool when no approval mechanism is wired, with a preview', async () => {
    registry.register({
      ...echoTool,
      name: 'test.dangerous',
      risk: 'dangerous',
      dryRun: async (input: { text: string }) => `would echo "${input.text}" irreversibly`,
    });
    const observation = await call({ tool: 'test.dangerous', input: { text: 'boom' } });
    expect(observation.ok).toBe(false);
    // This invoker has no ApprovalStore. The refusal must say so rather
    // than implying the user declined — M4 wires the store, and the
    // approvals suite covers the configured path.
    expect(observation.text).toContain('no approval mechanism is configured');
    expect(observation.text).toContain('NOT executed');
    expect(observation.awaitingApproval).toBeUndefined();
    // The preview is shown even though the tool did not run — that is the
    // whole reason dryRun is mandatory for dangerous tools.
    expect(observation.text).toContain('would echo "boom" irreversibly');
  });
});

describe('the sandbox', () => {
  it('gives a tool nothing ambient', async () => {
    let captured: Record<string, unknown> = {};
    registry.register({
      ...echoTool,
      name: 'test.introspect',
      async execute(input: { text: string }, ctx) {
        captured = ctx as unknown as Record<string, unknown>;
        return { ok: true, value: { echoed: input.text }, trust: 'SYSTEM' };
      },
    });
    await call({ tool: 'test.introspect', input: { text: 'x' } });

    // Read this list as the definition of the sandbox, because it is.
    expect(Object.keys(captured).sort()).toEqual([
      'effectiveTrust',
      'emit',
      'files',
      'idempotencyKey',
      'logger',
      'net',
      'now',
      'principal',
      'runId',
      'secrets',
      'signal',
      'stepId',
    ]);
  });

  it('scopes file writes to the tool, invisibly to the tool', async () => {
    await call({ tool: 'notes.write', input: { name: 'shopping', content: 'milk' } });
    // The tool asked for 'shopping'; it landed somewhere it cannot name.
    expect([...files.files.keys()]).toEqual(['tools/notes.write/shopping']);
  });

  it('refuses a path that escapes the sandbox', async () => {
    registry.register({
      ...echoTool,
      name: 'test.escape',
      async execute(_input: unknown, ctx) {
        await ctx.files.write('../../etc/passwd', new Uint8Array([1]));
        return { ok: true, value: { echoed: 'escaped' }, trust: 'SYSTEM' };
      },
    });
    const observation = await call({ tool: 'test.escape', input: { text: 'x' } });
    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('escapes this tool');
    expect(files.files.size).toBe(0);
  });

  it('gives a tool the injected clock, not the real one', async () => {
    const observation = await call({ tool: 'clock.now', input: {}, effectiveTrust: 'USER' });
    // FakeClock starts in 2026-01-01 in tests; the real date is later.
    expect(observation.text).toContain('2026-01-01');
  });
});

describe('artifacts absorb oversized results (§17)', () => {
  it('stores a large value and hands the model a reference', async () => {
    const observation = await call({ tool: 'test.firehose', input: { size: 200_000 } });
    expect(observation.ok).toBe(true);
    expect(observation.artifacts).toHaveLength(1);
    // The model sees a summary, not 200KB.
    expect(observation.text.length).toBeLessThan(5000);
    expect(observation.truncated).toBe(true);

    const row = substrate.storage.get<{ bytes: number }>(
      'SELECT bytes FROM artifacts WHERE id = ?',
      [observation.artifacts[0]!],
    );
    expect(row?.bytes).toBeGreaterThan(190_000);
    expect(types()).toContain('artifact.created');
  });

  it('leaves a small result inline', async () => {
    const observation = await call({ tool: 'test.firehose', input: { size: 50 } });
    expect(observation.artifacts).toHaveLength(0);
  });
});

describe('secrets through a tool (§13, §16)', () => {
  it('resolves a declared secret and keeps it out of every event', async () => {
    const security = createTestSecurity(substrate);
    await security.keyring.initialize('a passphrase long enough');
    await security.keyring.unlock('a passphrase long enough');
    const SECRET = 'sk-live-tool-secret-aaaaaaaaaaaa';
    const ref = (await security.vault.create('api', SECRET, { principal: 'user:ara' })).ref;

    let seen = '';
    registry.register({
      ...echoTool,
      name: 'test.usessecret',
      secretsRequired: [ref],
      async execute(_input: unknown, ctx) {
        seen = new TextDecoder().decode(ctx.secrets.get(ref)!);
        return { ok: true, value: { echoed: 'used it' }, trust: 'SYSTEM' };
      },
    });

    const withVault = makeInvoker({ vault: security.vault });
    const observation = await withVault.invoke({
      callId: 'c1',
      tool: 'test.usessecret',
      input: { text: 'x' },
      runId: RUN,
      stepId: STEP,
      principal: 'user:ara',
      effectiveTrust: 'USER',
    });

    expect(observation.ok).toBe(true);
    expect(seen).toBe(SECRET); // the tool really did get the value
    // …and it exists nowhere else.
    const everything = JSON.stringify(substrate.events.read().map((e) => e.payload));
    expect(everything).not.toContain(SECRET);
  });
});
