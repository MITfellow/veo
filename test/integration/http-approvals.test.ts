import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Api } from '../../src/interface/http.js';
import { ApprovalStore, SuspensionStore } from '../../src/capability/approvals.js';
import { Invoker } from '../../src/capability/invoke.js';
import { DEFAULT_GRANTS } from '../../src/capability/policy.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeModel, callTool, finish, say, usage } from '../fakes/model.js';
import { MemoryFileStore } from '../fakes/filestore.js';
import { FakeNet, respond } from '../fakes/net.js';
import { Ledger, makeChargeTool } from '../fakes/dangerous.js';
import { toFrame } from '../../src/interface/stream.js';

const TOKEN = 'test-token';
const PRINCIPAL = 'user:ara';

let substrate: Substrate;
let api: Api;
let server: Server;
let base: string;
let ledger: Ledger;
let approvals: ApprovalStore;

async function start(model: FakeModel): Promise<void> {
  substrate = createTestSubstrate();
  ledger = new Ledger();
  approvals = new ApprovalStore(substrate.storage, substrate.events, substrate.clock, substrate.ids);
  const suspensions = new SuspensionStore(substrate.storage, substrate.events, substrate.clock);

  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(makeChargeTool(ledger));

  const invoker = new Invoker({
    registry, grants: DEFAULT_GRANTS, approvals,
    events: substrate.events, storage: substrate.storage, clock: substrate.clock,
    ids: substrate.ids, hashing: substrate.hashing, logger: substrate.logger,
    redactor: substrate.redactor, files: new MemoryFileStore(),
    net: new FakeNet(() => respond(200)),
  });

  const runner = new Runner({
    events: substrate.events, clock: substrate.clock, ids: substrate.ids,
    logger: substrate.logger, model, invoker, approvals, suspensions,
  });

  api = new Api({
    events: substrate.events, storage: substrate.storage, clock: substrate.clock,
    ids: substrate.ids, logger: substrate.logger, runner, approvals,
    auth: { token: TOKEN, principal: PRINCIPAL },
  });
  server = api.server();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

/** Drive a run to the point where it is waiting for a human. */
async function suspendARun(): Promise<string> {
  const session = (await (await call('/sessions', { method: 'POST', body: '{}' })).json()) as {
    id: string;
  };
  await call(`/sessions/${session.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: 'pay acme' }),
  });
  // The run is async; wait for the approval to appear.
  for (let i = 0; i < 50 && approvals.pending().length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return approvals.pending()[0]!.id;
}

const chargeTurn = {
  chunks: [callTool('t1', 'payments.charge', { amount: 4200, to: 'acme' }), usage(10, 5), finish('tool-calls')],
};

beforeEach(async () => {
  await start(new FakeModel([chargeTurn, { chunks: [...say('Paid.'), usage(5, 3), finish('stop')] }]));
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  substrate.close();
});

describe('GET /approvals', () => {
  it('lists what the agent is waiting on, with the preview', async () => {
    await suspendARun();
    const body = (await (await call('/approvals')).json()) as {
      approvals: Array<{ id: string; preview: string; risk: string }>;
    };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]?.preview).toBe('would charge $42.00 to acme');
    expect(body.approvals[0]?.risk).toBe('dangerous');
  });

  it('needs a token like everything else', async () => {
    const res = await fetch(`${base}/approvals`);
    expect(res.status).toBe(401);
  });
});

describe('POST /approvals/:id', () => {
  it('approving resumes the run and the effect happens', async () => {
    const id = await suspendARun();
    const res = await call(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', scope: 'once' }),
    });
    expect(res.status).toBe(202);

    for (let i = 0; i < 100 && ledger.charges.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ledger.charges).toHaveLength(1);
    expect(approvals.get(id)?.state).toBe('granted');
  });

  it('denying resumes the run without the effect', async () => {
    const id = await suspendARun();
    await call(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'deny', scope: 'once', reason: 'wrong vendor' }),
    });
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ledger.charges).toHaveLength(0);
    expect(approvals.get(id)?.state).toBe('denied');
    expect(approvals.get(id)?.reason).toBe('wrong vendor');
  });

  it('refuses a second answer with 409 rather than silently re-deciding', async () => {
    const id = await suspendARun();
    await call(`/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
    const second = await call(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { detail: string }).detail).toContain('new request');
  });

  it('validates the body at the boundary', async () => {
    const id = await suspendARun();
    const res = await call(`/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('decision');
  });

  it('404s an unknown id', async () => {
    const res = await call('/approvals/01JUNKJUNKJUNKJUNKJUNKJUNK', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('the stream tells the client a human is needed (§29)', () => {
  it('maps approval events to frames', () => {
    expect(toFrame('approval.requested', { tool: 'payments.charge' }, 7)?.event).toBe('approval');
    expect(toFrame('approval.granted', { scope: 'once' }, 8)?.event).toBe('approval-decided');
    expect(toFrame('run.suspended', { reason: 'approval' }, 9)?.event).toBe('suspended');
    expect(toFrame('run.resumed', { stepId: 's' }, 10)?.event).toBe('resumed');
  });

  it('carries the outcome so a client need not infer it', () => {
    const frame = toFrame('approval.denied', { scope: 'once' }, 11);
    expect((frame?.data as { outcome: string }).outcome).toBe('approval.denied');
  });
});
