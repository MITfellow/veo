import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Api } from '../../src/interface/http.js';
import { Runner } from '../../src/orchestration/runner.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import { FakeModel, floodTurn, gate, reply } from '../fakes/model.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaa';
const PRINCIPAL = 'user:ara';

let substrate: Substrate;
let server: Server;
let base: string;
let model: FakeModel;

function start(turns: FakeModel): Promise<void> {
  substrate = createTestSubstrate();
  const runner = new Runner({
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    model: turns,
  });
  const api = new Api({
    events: substrate.events,
    storage: substrate.storage,
    clock: substrate.clock,
    ids: substrate.ids,
    logger: substrate.logger,
    runner,
    auth: { token: TOKEN, principal: PRINCIPAL },
  });
  server = api.server();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function api(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...auth, ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/** Read an SSE stream to completion, returning parsed frames. */
async function readStream(
  path: string,
  headers: Record<string, string> = {},
): Promise<Array<{ id: string; event: string; data: any }>> {
  const res = await fetch(`${base}${path}`, { headers: { ...auth, ...headers } });
  const text = await res.text();
  const frames: Array<{ id: string; event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    if (block.trim().length === 0 || block.startsWith(':')) continue;
    const frame: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      frame[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    if (frame.data !== undefined) {
      frames.push({ id: frame.id ?? '', event: frame.event ?? 'message', data: JSON.parse(frame.data) });
    }
  }
  return frames;
}

beforeEach(async () => {
  model = new FakeModel([reply('Nice to meet you, Ara.'), reply('Your name is Ara.')]);
  await start(model);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  substrate.close();
});

describe('sessions and messages', () => {
  it('creates a session and reads it back', async () => {
    const created = await api('/sessions', { method: 'POST', body: { title: 'First' } });
    expect(created.status).toBe(201);

    const fetched = await api(`/sessions/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.session.title).toBe('First');
    expect(fetched.body.messages).toEqual([]);
  });

  it('returns a runId immediately, before the run has finished', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const posted = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'My name is Ara.' },
    });
    // 202 Accepted: the work is started, not done. A client that had to wait
    // for the whole run before learning the runId could never stream it.
    expect(posted.status).toBe(202);
    expect(typeof posted.body.runId).toBe('string');
  });

  it('404s an unknown session rather than inventing one', async () => {
    const posted = await api('/sessions/nope/messages', { method: 'POST', body: { text: 'hi' } });
    expect(posted.status).toBe(404);
  });

  it('rejects an empty message with a reason', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const posted = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: '   ' },
    });
    expect(posted.status).toBe(400);
    expect(posted.body.detail).toContain('text');
  });
});

describe('the two-turn conversation streams — the M2 bar', () => {
  it('streams a full turn and ends with done', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const { body: run } = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'My name is Ara.' },
    });

    const frames = await readStream(`/runs/${run.runId}/stream`);
    const events = frames.map((f) => f.event);
    expect(events).toContain('done');

    const message = frames.find((f) => f.event === 'message');
    expect(message?.data.text).toBe('Nice to meet you, Ara.');
  });

  it('carries the conversation across two turns over HTTP', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });

    const first = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'My name is Ara.' },
    });
    await readStream(`/runs/${first.body.runId}/stream`);

    const second = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'What is my name?' },
    });
    const frames = await readStream(`/runs/${second.body.runId}/stream`);

    expect(frames.find((f) => f.event === 'message')?.data.text).toBe('Your name is Ara.');

    const detail = await api(`/sessions/${session.id}`);
    expect(detail.body.messages.map((m: any) => m.text)).toEqual([
      'My name is Ara.',
      'Nice to meet you, Ara.',
      'What is my name?',
      'Your name is Ara.',
    ]);
  });

  it('replays from Last-Event-ID without gap or repeat', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const { body: run } = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'hi' },
    });

    const full = await readStream(`/runs/${run.runId}/stream`);
    expect(full.length).toBeGreaterThan(1);

    // A laptop that slept after the first frame reconnects with its last id.
    const resumed = await readStream(`/runs/${run.runId}/stream`, {
      'last-event-id': full[0]!.id,
    });
    expect(resumed.map((f) => f.id)).toEqual(full.slice(1).map((f) => f.id));
    // Nothing lost, nothing duplicated — because the ids are event log
    // sequence numbers and the replay is a log read.
  });

  it('streams a finished run entirely from the log', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const { body: run } = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'hi' },
    });
    await readStream(`/runs/${run.runId}/stream`); // run completes

    // Connecting long after the fact still produces the whole conversation.
    const late = await readStream(`/runs/${run.runId}/stream`);
    expect(late.find((f) => f.event === 'message')?.data.text).toBe('Nice to meet you, Ara.');
    expect(late.map((f) => f.event)).toContain('done');
  });
});

describe('cancellation over HTTP', () => {
  it('cancels an in-flight run and the stream closes cleanly', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    substrate.close();

    // The provider is held open mid-stream, the way a real one would be, so
    // the cancel lands while the run is genuinely in flight.
    const held = gate();
    const slow = floodTurn(4000);
    await start(new FakeModel([{ ...slow, pauseAfter: 5, gate: held.promise }]));

    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const { body: run } = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'write forever' },
    });

    const cancelled = await api(`/runs/${run.runId}/cancel`, { method: 'POST' });
    held.open();
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.cancelled).toBe(true);

    const frames = await readStream(`/runs/${run.runId}/stream`);
    expect(frames.map((f) => f.event)).toContain('cancelled');
  });

  it('409s a cancel for a run that is not executing', async () => {
    const result = await api('/runs/not-a-run/cancel', { method: 'POST' });
    expect(result.status).toBe(409);
    expect(result.body.detail).toContain('not currently executing');
  });
});

describe('auth (§15)', () => {
  it('refuses a request with no token', async () => {
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token and records the decision', async () => {
    const res = await fetch(`${base}/sessions`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    const denials = substrate.events.read({ types: ['error.raised'] });
    // Every auth decision is auditable.
    expect(denials.length).toBeGreaterThan(0);
    expect(JSON.stringify(denials[0]?.payload)).toContain('bearer token');
  });

  it('never echoes the expected token in an error', async () => {
    const res = await fetch(`${base}/sessions`, { headers: { authorization: 'Bearer wrong' } });
    expect(await res.text()).not.toContain(TOKEN);
  });

  it('serves /health without auth, because a dead agent must still answer', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; degradation: string };
    expect(body.status).toBe('ok');
    expect(body.degradation).toBe('L0');
  });
});

describe('the trace (§30)', () => {
  it('renders a finished run from the log, including steps', async () => {
    const { body: session } = await api('/sessions', { method: 'POST', body: {} });
    const { body: run } = await api(`/sessions/${session.id}/messages`, {
      method: 'POST',
      body: { text: 'hi' },
    });
    await readStream(`/runs/${run.runId}/stream`);

    const trace = await api(`/runs/${run.runId}/trace`);
    expect(trace.status).toBe(200);
    expect(trace.body.events.map((e: any) => e.type)).toContain('model.requested');
    expect(trace.body.steps).toHaveLength(1);
    expect(trace.body.steps[0].outcome).toBe('text');
  });

  it('404s a run that does not exist', async () => {
    expect((await api('/runs/nope/trace')).status).toBe(404);
  });
});
