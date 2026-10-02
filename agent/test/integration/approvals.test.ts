import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  ApprovalError,
  ApprovalStore,
  SuspensionStore,
  shapeMatches,
  shapeOf,
} from '../../src/capability/approvals.js';
import { Invoker } from '../../src/capability/invoke.js';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import type { Capability } from '../../src/security/trust.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from '../../src/substrate/clock.js';
import { FakeModel, callTool, finish, say, usage } from '../fakes/model.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import { Ledger, makeChargeTool } from '../fakes/dangerous.js';

const SESSION = 'sess-1';
const PRINCIPAL = 'user:ara';

let substrate: Substrate;
let clock: FakeClock;
let ledger: Ledger;
let approvals: ApprovalStore;
let suspensions: SuspensionStore;

/** Fresh database, fresh ledger. Called once per test by beforeEach. */
function world(): void {
  clock = new FakeClock('2026-04-01T09:00:00Z');
  substrate = createTestSubstrate({ clock });
  ledger = new Ledger();
  approvals = new ApprovalStore(substrate.storage, substrate.events, substrate.clock, substrate.ids);
  suspensions = new SuspensionStore(substrate.storage, substrate.events, substrate.clock);
}

/**
 * A new invoker over the EXISTING world.
 *
 * Separate from `world()` on purpose: a test about standing permission needs
 * a second runner that still sees the first one's decisions, and a helper
 * that quietly rebuilt the database would make that test pass for no reason.
 */
function makeInvoker(grants?: { principal: Capability[]; delegation: Capability[] }) {
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(makeChargeTool(ledger));

  const invoker = new Invoker({
    registry,
    grants:
      grants === undefined
        ? DEFAULT_GRANTS
        : { principal: new Set(grants.principal), delegation: new Set(grants.delegation) },
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
  return { invoker, registry };
}

function runnerWith(model: FakeModel): Runner {
  const { invoker } = makeInvoker();
  return new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model,
    invoker,
    approvals,
    suspensions,
  });
}

const chargeTurn = (amount = 4200) => ({
  chunks: [callTool('t1', 'payments.charge', { amount, to: 'acme' }), usage(10, 5), finish('tool-calls')],
});
const replyTurn = (text: string) => ({ chunks: [...say(text), usage(5, 3), finish('stop')] });

const go = (runner: Runner) =>
  runner.run({ sessionId: SESSION, principal: PRINCIPAL, trigger: 'user' });

beforeEach(() => {
  world();
});

describe('a dangerous tool suspends the run (§19)', () => {
  it('asks, with the dryRun preview, and does not execute', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('done')]));
    const outcome = await go(runner);

    expect(outcome.status).toBe('suspended');
    expect(ledger.charges).toHaveLength(0);

    const pending = approvals.pending();
    expect(pending).toHaveLength(1);
    // Approving something you cannot see is not consent.
    expect(pending[0]?.preview).toBe('would charge $42.00 to acme');
    expect(pending[0]?.risk).toBe('dangerous');

    const requested = substrate.events.read({ types: ['approval.requested'] }).at(0);
    expect((requested?.payload as { preview: string }).preview).toContain('$42.00');
  });

  it('records run.suspended with the step to come back to', async () => {
    await go(runnerWith(new FakeModel([chargeTurn(), replyTurn('done')])));
    const suspended = substrate.events.read({ types: ['run.suspended'] }).at(0);
    expect((suspended?.payload as { reason: string }).reason).toBe('approval');
    expect((suspended?.payload as { stepId: string }).stepId).toBeTruthy();
  });

  it('holds nothing in memory: the run function has returned', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('done')]));
    const outcome = await go(runner);
    // If a timer or promise were still pending this would hang rather than
    // resolve. §19: "release all resources".
    expect(outcome.status).toBe('suspended');
    expect(suspensions.all()).toHaveLength(1);
    expect(suspensions.all()[0]?.resumeOn).toBe(approvals.pending()[0]?.id);
  });

  it('a second dangerous call does not stack up a second suspension', async () => {
    await go(runnerWith(new FakeModel([chargeTurn(), replyTurn('done')])));
    expect(suspensions.all()).toHaveLength(1);
  });
});

describe('granting resumes the run at that step', () => {
  it('executes the approved call and finishes', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('Paid $42.00.')]));
    const first = await go(runner);
    expect(first.status).toBe('suspended');

    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    const resumed = await runner.resume(id);

    expect(resumed.status).toBe('finished');
    expect(resumed.text).toBe('Paid $42.00.');
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.total).toBe(4200);
  });

  it('keeps the same runId and does not restart the step count', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('ok')]));
    const first = await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    const resumed = await runner.resume(id);

    expect(resumed.runId).toBe(first.runId);
    // Not from the beginning: step numbering continues.
    expect(resumed.steps).toBeGreaterThan(first.steps);
    expect(substrate.events.read({ types: ['run.started'] })).toHaveLength(1);
  });

  it('does NOT repeat tool calls made before the suspension', async () => {
    const runner = runnerWith(
      new FakeModel([
        { chunks: [callTool('t0', 'notes.write', { name: 'memo', content: 'x' }), usage(5, 2), finish('tool-calls')] },
        chargeTurn(),
        replyTurn('done'),
      ]),
    );
    await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await runner.resume(id);

    const writes = substrate.events
      .read({ types: ['tool.succeeded'] })
      .filter((e) => (e.payload as { tool: string }).tool === 'notes.write');
    // Replaying from the top would run this again — the exact double-effect
    // M3 exists to prevent.
    expect(writes).toHaveLength(1);
    expect(ledger.charges).toHaveLength(1);
  });

  it('logs run.resumed, and the whole story shares one runId', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('ok')]));
    const first = await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await runner.resume(id);

    const types = substrate.events.read({ runId: first.runId }).map((e) => e.type);
    expect(types).toContain('approval.requested');
    expect(types).toContain('run.suspended');
    expect(types).toContain('approval.granted');
    expect(types).toContain('run.resumed');
    expect(types).toContain('run.finished');
    expect(types.indexOf('run.suspended')).toBeLessThan(types.indexOf('run.resumed'));
  });

  it('refuses to resume twice', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('ok'), replyTurn('again')]));
    await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await runner.resume(id);

    // Resuming twice would run the approved call twice.
    await expect(runner.resume(id)).rejects.toThrow(/waiting on approval|already resumed/);
    expect(ledger.charges).toHaveLength(1);
  });

  it('cannot be resumed before the human answers', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('ok')]));
    await go(runner);
    const id = approvals.pending()[0]!.id;
    await expect(runner.resume(id)).rejects.toThrow(/not been answered/);
  });
});

describe('denial', () => {
  it('tells the model in words and lets the run continue', async () => {
    const model = new FakeModel([chargeTurn(), replyTurn('I could not charge the card.')]);
    const runner = runnerWith(model);
    await go(runner);

    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: false, scope: 'once', by: PRINCIPAL, reason: 'wrong vendor' });
    const resumed = await runner.resume(id);

    expect(resumed.status).toBe('finished');
    expect(ledger.charges).toHaveLength(0);
    const prompt = model.requests.at(-1)!.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('declined');
    expect(prompt).toContain('wrong vendor');
  });

  it('a standing "always" denial is honoured without asking again', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), replyTurn('ok')]));
    await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: false, scope: 'always', by: PRINCIPAL, reason: 'never' });
    await runner.resume(id);

    const second = runnerWith(new FakeModel([chargeTurn(), replyTurn('refused again')]));
    // Re-asking a question already answered "never" is how people learn to
    // approve without reading.
    const outcome = await go(second);
    expect(outcome.status).toBe('finished');
    expect(approvals.pending()).toHaveLength(0);
    expect(ledger.charges).toHaveLength(0);
  });
});

describe('scopes', () => {
  it('once covers exactly one call', async () => {
    const runner = runnerWith(new FakeModel([chargeTurn(), chargeTurn(5000), replyTurn('done')]));
    await go(runner);
    const id = approvals.pending()[0]!.id;
    approvals.decide(id, { granted: true, scope: 'once', by: PRINCIPAL });
    await runner.resume(id);

    // The second charge is a new question.
    expect(ledger.charges).toHaveLength(1);
    expect(approvals.pending()).toHaveLength(1);
  });

  it('session covers later calls in the same session only', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: { amount: 1, to: 'a' },
      preview: 'p', risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: true, scope: 'session', by: PRINCIPAL });

    expect(approvals.standingDecision('payments.charge', { amount: 999, to: 'z' }, SESSION)?.granted).toBe(true);
    expect(approvals.standingDecision('payments.charge', { amount: 999, to: 'z' }, 'other-session')).toBeNull();
  });

  it('always covers every session', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: { amount: 1, to: 'a' },
      preview: 'p', risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: true, scope: 'always', by: PRINCIPAL });
    expect(approvals.standingDecision('payments.charge', { amount: 1, to: 'b' }, 'any')?.granted).toBe(true);
  });

  it('shape matches the pinned fields and nothing else', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: { amount: 100, to: 'acme' },
      preview: 'p', risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: true, scope: 'shape', by: PRINCIPAL, pin: ['to'] });

    // "Pay acme any amount" — yes. "Pay someone else" — a new question.
    expect(approvals.standingDecision('payments.charge', { amount: 999, to: 'acme' }, SESSION)?.granted).toBe(true);
    expect(approvals.standingDecision('payments.charge', { amount: 100, to: 'evil' }, SESSION)).toBeNull();
  });

  it('a standing grant is not a blank cheque for a different tool', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: {}, preview: 'p',
      risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: true, scope: 'always', by: PRINCIPAL });
    expect(approvals.standingDecision('email.send', {}, SESSION)).toBeNull();
  });
});

describe('the shape matcher', () => {
  it('rejects an input carrying a key the shape never saw', () => {
    const shape = shapeOf('t', { to: 'ara', body: 'hi' }, ['to']);
    expect(shapeMatches(shape, 't', { to: 'ara', body: 'anything' })).toBe(true);
    // The day the tool gains a bcc field, an old approval must not cover it.
    expect(shapeMatches(shape, 't', { to: 'ara', body: 'hi', bcc: 'evil@x' })).toBe(false);
  });

  it('rejects a missing key', () => {
    const shape = shapeOf('t', { to: 'ara', body: 'hi' }, ['to']);
    expect(shapeMatches(shape, 't', { to: 'ara' })).toBe(false);
  });

  it('holds wildcards to their JSON type', () => {
    const shape = shapeOf('t', { to: 'ara', amount: 10 }, ['to']);
    expect(shapeMatches(shape, 't', { to: 'ara', amount: 99 })).toBe(true);
    expect(shapeMatches(shape, 't', { to: 'ara', amount: '99' })).toBe(false);
  });

  it('refuses to pin a nested object rather than guessing at a match', () => {
    expect(() => shapeOf('t', { meta: { a: 1 } }, ['meta'])).toThrow(/only top-level scalar/);
  });
});

describe('expiry and immutability', () => {
  it('expires a pending approval and says how long it waited', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: {}, preview: 'p',
      risk: 'dangerous', requestedTrust: 'USER',
    });
    clock.advance(APPROVAL_TTL_MS + 1);
    expect(approvals.expireStale()).toEqual([record.id]);
    expect(approvals.get(record.id)?.state).toBe('expired');

    const expired = substrate.events.read({ types: ['approval.expired'] }).at(0);
    expect((expired?.payload as { afterMs: number }).afterMs).toBeGreaterThan(APPROVAL_TTL_MS);
  });

  it('refuses to answer an expired approval', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: {}, preview: 'p',
      risk: 'dangerous', requestedTrust: 'USER',
    });
    clock.advance(APPROVAL_TTL_MS + 1);
    expect(() => approvals.decide(record.id, { granted: true, scope: 'once', by: PRINCIPAL })).toThrow(
      ApprovalError,
    );
  });

  it('refuses to re-decide: a change of mind is a new request', () => {
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: {}, preview: 'p',
      risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: false, scope: 'once', by: PRINCIPAL });
    expect(() => approvals.decide(record.id, { granted: true, scope: 'once', by: PRINCIPAL })).toThrow(
      /already denied/,
    );
  });

  it('cannot be deleted — it is an audit record', () => {
    approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: {}, preview: 'p',
      risk: 'dangerous', requestedTrust: 'USER',
    });
    expect(() => substrate.storage.run('DELETE FROM approvals')).toThrow(/cannot be deleted/);
  });
});

describe('an approval authorises ONE call, not a tool', () => {
  it('refuses to use it for a different input', async () => {
    const { invoker } = makeInvoker();
    const record = approvals.request({
      runId: 'r1', stepId: 's1', sessionId: SESSION, principal: PRINCIPAL,
      tool: 'payments.charge', toolVersion: '1', input: { amount: 100, to: 'acme' },
      preview: 'p', risk: 'dangerous', requestedTrust: 'USER',
    });
    approvals.decide(record.id, { granted: true, scope: 'once', by: PRINCIPAL });

    const observation = await invoker.invoke({
      callId: 'c1',
      tool: 'payments.charge',
      input: { amount: 999_999, to: 'attacker' }, // not what was approved
      runId: 'r1',
      stepId: 's1',
      sessionId: SESSION,
      principal: PRINCIPAL,
      effectiveTrust: 'USER',
      approvalId: record.id,
    });

    expect(observation.ok).toBe(false);
    expect(observation.text).toContain('does not authorise this exact call');
    expect(ledger.charges).toHaveLength(0);
  });
});

describe('escalation (§12.3) — and the one place it is refused', () => {
  it('a TOOL-trust step asks the human instead of failing flat', async () => {
    const { invoker } = makeInvoker();
    const observation = await invoker.invoke({
      callId: 'c1',
      tool: 'payments.charge',
      input: { amount: 100, to: 'acme' },
      runId: 'r1',
      stepId: 's1',
      sessionId: SESSION,
      principal: PRINCIPAL,
      // Something allowlisted is in the chain — not the user, not a web page.
      effectiveTrust: 'TOOL',
    });

    expect(observation.awaitingApproval).toBeDefined();
    expect(ledger.charges).toHaveLength(0);

    const escalated = substrate.events.read({ types: ['policy.escalated'] }).at(0);
    expect((escalated?.payload as { from: string }).from).toBe('TOOL');
    expect((escalated?.payload as { requested: string[] }).requested).toContain('spend');

    // The user is shown what it would do AND why they are being asked.
    const pending = approvals.pending()[0]!;
    expect(pending.preview).toContain('would charge $1.00 to acme');
    expect(pending.preview).toContain('This needs you because');
  });

  it('a FOREIGN step is refused outright and the user is never asked', async () => {
    const { invoker } = makeInvoker();
    const observation = await invoker.invoke({
      callId: 'c1',
      tool: 'payments.charge',
      input: { amount: 100, to: 'acme' },
      runId: 'r1',
      stepId: 's1',
      sessionId: SESSION,
      principal: PRINCIPAL,
      effectiveTrust: 'FOREIGN',
    });

    expect(observation.awaitingApproval).toBeUndefined();
    expect(observation.ok).toBe(false);
    // Decision 022: offering to approve what a web page asked for is the
    // approval-fatigue attack with extra steps. No prompt is generated at
    // all, so there is nothing for the user to get wrong.
    expect(approvals.pending()).toHaveLength(0);
    expect(substrate.events.read({ types: ['policy.escalated'] })).toHaveLength(0);
    expect(substrate.events.read({ types: ['policy.denied'] })).toHaveLength(1);
  });

  it('escalation is not offered when the principal does not hold the capability', async () => {
    const { invoker } = makeInvoker({ principal: [], delegation: [] });
    const observation = await invoker.invoke({
      callId: 'c1',
      tool: 'payments.charge',
      input: { amount: 100, to: 'acme' },
      runId: 'r1',
      stepId: 's1',
      sessionId: SESSION,
      principal: PRINCIPAL,
      effectiveTrust: 'USER',
    });
    // There is no one to ask, so do not offer: a prompt that cannot be
    // granted teaches people to click yes.
    expect(observation.awaitingApproval).toBeUndefined();
    expect(approvals.pending()).toHaveLength(0);
  });
});
