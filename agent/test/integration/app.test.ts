/**
 * The composed application.
 *
 * Every other test in this repo builds a world out of fakes. This one boots
 * the real `start()` — real SQLite on disk, real registry, real invoker,
 * real HTTP server — and talks to it the way the Veo client does. It is the
 * only test that would catch a wiring mistake: a port left unconstructed, a
 * tool never registered, a route never mounted. Those bugs are invisible to
 * unit tests by construction, because unit tests supply the wiring
 * themselves.
 *
 * It stays offline: no API key is set, so the agent runs on the offline
 * provider, which is itself part of what is being asserted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';

let app: StartedAgent;
let dir: string;
let base: string;

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${app.token}`,
  'content-type': 'application/json',
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-app-'));
  app = await start({ port: 0, dbPath: join(dir, 'test.db'), token: 'test-token' });
  base = `http://127.0.0.1:${app.port}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: auth(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBeLessThan(400);
  return (await response.json()) as T;
}

/** Read the run's stream to completion and return the frames, in order. */
async function drain(runId: string): Promise<Array<{ event: string; data: string }>> {
  const response = await fetch(`${base}/runs/${runId}/stream`, { headers: auth() });
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
      return { event, data };
    });
}

describe('the agent as it actually ships', () => {
  it('is up before anyone authenticates', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', degradation: 'L0' });
  });

  it('refuses a request without the token', async () => {
    const response = await fetch(`${base}/sessions`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('answers a turn end to end and writes it to the log', async () => {
    const session = await post<{ id: string }>('/sessions', { title: 'test' });
    const { runId } = await post<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'hello there',
    });
    expect(runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const frames = await drain(runId);
    expect(frames.map((f) => f.event)).toContain('done');

    const read = await fetch(`${base}/sessions/${session.id}`, { headers: auth() });
    const body = (await read.json()) as { messages: Array<{ role: string; text: string; trust: string }> };
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(body.messages[0]?.trust).toBe('USER');
    // Agent output is DERIVED, never USER: it is downstream of the model.
    expect(body.messages[1]?.trust).toBe('DERIVED');
  });

  it('says it has no model rather than inventing an answer', async () => {
    const session = await post<{ id: string }>('/sessions', { title: 'honesty' });
    const { runId } = await post<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'summarise the news for me',
    });
    await drain(runId);
    const read = await fetch(`${base}/sessions/${session.id}`, { headers: auth() });
    const body = (await read.json()) as { messages: Array<{ text: string }> };
    expect(body.messages[1]?.text).toContain('without a language model');
  });

  it('really calls a tool — the registry is wired, not just constructed', async () => {
    const session = await post<{ id: string }>('/sessions', { title: 'tools' });
    const { runId } = await post<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'what time is it?',
    });
    const frames = await drain(runId);
    expect(frames.some((f) => f.event === 'tool' && f.data.includes('clock.now'))).toBe(true);

    const read = await fetch(`${base}/sessions/${session.id}`, { headers: auth() });
    const body = (await read.json()) as { messages: Array<{ text: string }> };
    // The clock is the real clock, so the year is this one.
    expect(body.messages[1]?.text).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('replays a finished run for a client that arrives late', async () => {
    const session = await post<{ id: string }>('/sessions', { title: 'replay' });
    const { runId } = await post<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'hello',
    });
    const first = await drain(runId);
    const second = await drain(runId);
    // A client that reconnects must see the same story, not a shorter one.
    expect(second.map((f) => f.event)).toEqual(first.map((f) => f.event));
  });

  it('has nothing pending to approve when nothing dangerous was asked', async () => {
    const response = await fetch(`${base}/approvals`, { headers: auth() });
    expect(await response.json()).toEqual({ approvals: [] });
  });

  it('survives a restart with its memory intact — the log is the product', async () => {
    const session = await post<{ id: string }>('/sessions', { title: 'durable' });
    const { runId } = await post<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'remember this conversation',
    });
    await drain(runId);
    await app.close();

    app = await start({ port: 0, dbPath: join(dir, 'test.db'), token: 'test-token' });
    base = `http://127.0.0.1:${app.port}`;

    const read = await fetch(`${base}/sessions/${session.id}`, { headers: auth() });
    const body = (await read.json()) as { messages: Array<{ text: string }> };
    expect(body.messages[0]?.text).toBe('remember this conversation');
  });
});
