/**
 * S2 tests 32–37: the task routes, and the registry after S2.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';

let app: StartedAgent;
let dir: string;

const call = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
};

interface TaskView {
  id: string;
  title: string;
  dueAt: number | null;
  done: boolean;
  completedAt: number | null;
}

const DUE = Date.UTC(2027, 7, 20, 23, 59);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-tasks-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A registry with every S2 dependency supplied, for the roster tests. */
function fullRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltins(registry, {
    calendar: {
      store: {
        add: () => undefined,
        cancel: () => false,
        get: () => undefined,
        list: () => [],
        find: () => [],
        conflicts: () => [],
      } as never,
    },
    tasks: {
      store: {
        add: () => undefined,
        complete: () => false,
        drop: () => false,
        get: () => undefined,
        list: () => [],
        overdue: () => [],
      } as never,
    },
    conversations: { search: { search: () => [] } as never },
  });
  return registry;
}

describe('the task routes', () => {
  it('32. POST creates, GET lists, DELETE drops', async () => {
    const created = await call<TaskView>('/tasks', {
      method: 'POST',
      body: { title: 'Buy a router', dueAt: DUE },
    });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('Buy a router');
    expect(created.body.dueAt).toBe(DUE);
    expect(created.body.done).toBe(false);

    const listed = await call<{ tasks: TaskView[] }>('/tasks');
    expect(listed.status).toBe(200);
    expect(listed.body.tasks.map((task) => task.id)).toContain(created.body.id);

    const dropped = await call<{ dropped: string }>(`/tasks/${created.body.id}`, {
      method: 'DELETE',
    });
    expect(dropped.status).toBe(200);
    expect(dropped.body.dropped).toBe(created.body.id);

    const after = await call<{ tasks: TaskView[] }>('/tasks');
    expect(after.body.tasks.map((task) => task.id)).not.toContain(created.body.id);

    expect((await call('/tasks/T-nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('33. PATCH completes, and says honestly that it cannot un-complete', async () => {
    const created = await call<TaskView>('/tasks', {
      method: 'POST',
      body: { title: 'Reply to Rui' },
    });

    const done = await call<{ done: boolean }>(`/tasks/${created.body.id}`, {
      method: 'PATCH',
      body: { done: true },
    });
    expect(done.status).toBe(200);
    expect(done.body.done).toBe(true);

    // Gone from the open list, still there with includeClosed.
    const open = await call<{ tasks: TaskView[] }>('/tasks');
    expect(open.body.tasks.map((t) => t.id)).not.toContain(created.body.id);
    const all = await call<{ tasks: TaskView[] }>('/tasks?includeClosed=true');
    const found = all.body.tasks.find((task) => task.id === created.body.id);
    expect(found?.completedAt).not.toBeNull();

    // S2 has no `task.reopened` event, so un-ticking is refused with a
    // reason rather than silently ignored — a tick-box that pretends
    // to untick is worse than one that says it cannot.
    const reopened = await call<{ error: string }>(`/tasks/${created.body.id}`, {
      method: 'PATCH',
      body: { done: false },
    });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error).toBe('not_reopenable');

    expect(
      (await call('/tasks/T-nope', { method: 'PATCH', body: { done: true } })).status,
    ).toBe(404);
  });

  it('34. a bad task is 400 at the boundary, never a 500', async () => {
    expect((await call('/tasks', { method: 'POST', body: {} })).status).toBe(400);
    expect((await call('/tasks', { method: 'POST', body: { title: '' } })).status).toBe(400);
    expect(
      (await call('/tasks', { method: 'POST', body: { title: 'x'.repeat(500) } })).status,
    ).toBe(400);
    expect(
      (await call('/tasks', { method: 'POST', body: { title: 'ok', dueAt: 'tuesday' } })).status,
    ).toBe(400);
    const created = await call<TaskView>('/tasks', { method: 'POST', body: { title: 'patchme' } });
    expect(
      (await call(`/tasks/${created.body.id}`, { method: 'PATCH', body: { done: 'yes' } })).status,
    ).toBe(400);
    await call(`/tasks/${created.body.id}`, { method: 'DELETE' });
  });

  it('35. the routes need the bearer token', async () => {
    expect((await fetch(`http://127.0.0.1:${app.port}/tasks`)).status).toBe(401);
    expect(
      (await fetch(`http://127.0.0.1:${app.port}/tasks`, { method: 'POST' })).status,
    ).toBe(401);
  });
});

describe('the registry after S2', () => {
  it('36. all eight new tools are there, with schemas', () => {
    const registry = fullRegistry();
    const names = registry.list().map((tool) => tool.name);
    for (const expected of [
      'conversation.search',
      'tasks.add',
      'tasks.list',
      'tasks.complete',
      'tasks.drop',
      'unit.convert',
    ]) {
      expect(names, expected).toContain(expected);
    }

    const spec = registry.specsFor(() => true).find((s) => s.name === 'tasks.add');
    expect(spec?.parameters.properties?.['title']?.type).toBe('string');
    expect(spec?.parameters.required).toContain('title');

    // The description has to tell a model *when* to reach for it, not
    // just what it does — this is the line that stops it putting
    // "buy a router" in the calendar at an invented time.
    expect(spec?.description).toMatch(/no particular time/i);
  });

  it('37. the FOREIGN list gains unit.convert and nothing else', () => {
    const registry = fullRegistry();
    const foreign = registry
      .list()
      .filter((tool) => tool.minTrust === 'FOREIGN')
      .map((tool) => tool.name)
      .sort();
    expect(foreign).toEqual([
      'clock.now',
      'math.eval',
      'time.convert',
      'time.until',
      'unit.convert',
    ]);

    // Everything that touches the user's own data stays above the floor.
    for (const name of ['conversation.search', 'tasks.add', 'tasks.complete', 'tasks.drop']) {
      expect(registry.get(name)!.minTrust, name).not.toBe('FOREIGN');
    }
    expect(registry.get('tasks.drop')!.minTrust).toBe('USER');
    expect(registry.get('tasks.drop')!.dryRun).toBeTypeOf('function');
  });

  it('offers the dependent tools only when their dependency is supplied', () => {
    const bare = new ToolRegistry();
    registerBuiltins(bare);
    expect(bare.get('unit.convert')).toBeDefined();
    // Same precedent as memory and the calendar: a tool that needs a
    // live store is wired by the composition root, not against a global.
    expect(bare.get('tasks.add')).toBeUndefined();
    expect(bare.get('conversation.search')).toBeUndefined();
  });
});
