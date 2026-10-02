/**
 * Tests 39–40 and 51–56: scheduling against the composed app.
 *
 * Everything here runs through `start()` — the real worker, the real
 * queue, the real runner. §28's claim is that proactive behaviour needs
 * "zero kernel changes", and the only way to check a claim like that is to
 * let a schedule fire into the actual run loop and look at what came out.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';

let app: StartedAgent;
let dir: string;

const call = async <T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.auth === false ? {} : { authorization: `Bearer ${app.token}` }),
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
};

interface ScheduleView {
  id: string;
  name: string;
  spec: string;
  timezone: string;
  prompt: string;
  catchUp: string;
  enabled: boolean;
  nextFireAt: number | null;
  fireCount: number;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-schedule-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the schedule routes', () => {
  it('51. create, list and delete a schedule', async () => {
    const created = await call<ScheduleView>('/schedules', {
      method: 'POST',
      body: {
        name: 'Morning briefing',
        spec: '0 9 * * 1-5',
        timezone: 'America/New_York',
        prompt: 'What is on today?',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.nextFireAt).toBeGreaterThan(Date.now());
    expect(created.body.catchUp).toBe('fire-once');

    const list = await call<{ schedules: ScheduleView[] }>('/schedules');
    expect(list.body.schedules.map((s) => s.name)).toContain('Morning briefing');

    const patched = await call<ScheduleView>(`/schedules/${created.body.id}`, {
      method: 'PATCH',
      body: { timezone: 'Europe/Lisbon', catchUp: 'skip' },
    });
    expect(patched.body.timezone).toBe('Europe/Lisbon');
    expect(patched.body.catchUp).toBe('skip');

    const deleted = await call(`/schedules/${created.body.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await call<{ schedules: ScheduleView[] }>('/schedules')).body.schedules).toHaveLength(0);
  });

  it('56. a bad cron spec is a 400 that explains itself, not a 500', async () => {
    const bad = await call<{ error: string; detail: string }>('/schedules', {
      method: 'POST',
      body: { name: 'nonsense', spec: '0 99 * * *', prompt: 'hi' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_spec');
    expect(bad.body.detail).toContain('outside 0-23');

    // And the interval floor, with the reason attached — the user is told
    // why their agent refuses to wake up every minute.
    const greedy = await call<{ detail: string }>('/schedules', {
      method: 'POST',
      body: { name: 'constant', spec: '* * * * *', prompt: 'hi' },
    });
    expect(greedy.status).toBe(400);
    expect(greedy.body.detail).toContain('denial of service');

    // Missing fields are caught by the schema, before any of that.
    expect((await call('/schedules', { method: 'POST', body: { spec: '0 9 * * *' } })).status).toBe(400);
  });

  it('55. none of this is available without the token', async () => {
    for (const [method, path] of [
      ['GET', '/schedules'],
      ['POST', '/schedules'],
      ['GET', '/jobs'],
      ['GET', '/jobs/dead-letter'],
      ['GET', '/degradation'],
    ] as const) {
      const response = await call(path, { method, auth: false, body: method === 'POST' ? {} : undefined });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('jobs and the ladder', () => {
  it('52. the queue is inspectable', async () => {
    const { status, body } = await call<{
      counts: Record<string, number>;
      jobs: Array<{ id: string; kind: string; status: string }>;
    }>('/jobs');
    expect(status).toBe(200);
    expect(Object.keys(body.counts).sort()).toEqual(['dead', 'done', 'failed', 'leased', 'pending']);

    const dead = await call<{ dead: unknown[] }>('/jobs/dead-letter');
    expect(dead.status).toBe(200);
    expect(Array.isArray(dead.body.dead)).toBe(true);
  });

  it('53. replaying a job that is not in the dead-letter table is a 404', async () => {
    const replay = await call('/jobs/does-not-exist/replay', { method: 'POST' });
    expect(replay.status).toBe(404);
  });

  it('54. the degradation endpoint says what is wrong and what that costs', async () => {
    const { status, body } = await call<{
      level: string;
      meaning: string;
      signals: Array<{ signal: string; detail: string }>;
    }>('/degradation');
    expect(status).toBe(200);
    // No API key in the test environment → the offline fallback → L2,
    // stated rather than hidden.
    expect(body.level).toBe('L2');
    expect(body.meaning).toContain('fallback');
    expect(body.signals[0]!.signal).toBe('model');
  });
});

describe('a schedule actually running', () => {
  it('39. a due schedule produces a real run, triggered by the schedule', async () => {
    const created = await call<ScheduleView>('/schedules', {
      method: 'POST',
      // A one-shot a second ago: due on the very next worker tick.
      body: {
        name: 'Check the time',
        spec: String(Date.now() - 1000),
        kind: 'once',
        prompt: 'what time is it',
      },
    });
    expect(created.status).toBe(201);

    // The worker polls every 250ms by default; give it room on a loaded
    // machine, but fail rather than hang.
    const deadline = Date.now() + 15_000;
    let runs: Array<{ trigger: string; sessionId: string | null }> = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      const events = await call<{ events: Array<{ type: string; payload: { trigger: string }; sessionId: string | null }> }>(
        '/events?types=run.started&limit=50',
      );
      runs = events.body.events
        .filter((e) => e.payload.trigger === 'schedule')
        .map((e) => ({ trigger: e.payload.trigger, sessionId: e.sessionId }));
      if (runs.length > 0) break;
    }

    expect(runs.length).toBeGreaterThan(0);
    // The kernel did not change: this is an ordinary run whose trigger
    // happens to be 'schedule' (§28).
    expect(runs[0]!.trigger).toBe('schedule');
    expect(runs[0]!.sessionId).toContain('ses-schedule-');

    // And the fire is on the record, with the schedule disabled afterwards
    // because a one-shot is done.
    const after = await call<{ schedules: ScheduleView[] }>('/schedules');
    const mine = after.body.schedules.find((s) => s.id === created.body.id)!;
    expect(mine.fireCount).toBe(1);
    expect(mine.enabled).toBe(false);
  });

  it('40. a scheduled run leaves the same audit trail an interactive one does', async () => {
    const events = await call<{
      events: Array<{ type: string; runId: string | null }>;
    }>('/events?limit=400');

    const scheduled = events.body.events.filter((e) => e.type === 'schedule.fired');
    expect(scheduled.length).toBeGreaterThan(0);

    // Same events, same budgets, same context assembly — a background run
    // is not a second, laxer code path.
    const types = new Set(events.body.events.map((e) => e.type));
    for (const required of ['run.started', 'context.assembled', 'constitution.enforced', 'run.finished']) {
      expect(types, required).toContain(required);
    }
  });
});
