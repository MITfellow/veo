/**
 * S3 tests 34–39: the reminder routes, end to end through `start()`.
 *
 * These run against the real composition root, so they also check the
 * wiring that the unit tests cannot see: that the cascade from closing
 * a task actually reaches the reminder store in the shipped app.
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

interface ReminderView {
  id: string;
  text: string;
  remindAt: number;
  ownerKind: string;
  ownerId: string;
  state: string;
}
interface TaskView {
  id: string;
  title: string;
}

const AT = Date.UTC(2027, 7, 20, 9, 0);

/** Unique per run: the e2e and api databases outlive a single spec. */
const unique = (label: string): string => `${label} ${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-reminders-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the reminder routes', () => {
  it('34. POST sets one, GET lists it, DELETE calls it off', async () => {
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Renew') } });

    const created = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: { text: 'Renew the insurance', remindAt: AT, ownerKind: 'task', ownerId: task.body.id },
    });
    expect(created.status).toBe(201);
    expect(created.body.state).toBe('pending');

    const listed = await call<{ reminders: ReminderView[] }>('/reminders');
    expect(listed.body.reminders.map((r) => r.id)).toContain(created.body.id);

    const cancelled = await call(`/reminders/${created.body.id}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);

    const after = await call<{ reminders: ReminderView[] }>('/reminders');
    expect(after.body.reminders.map((r) => r.id)).not.toContain(created.body.id);

    // Still there under includeDone: cancelled is a state, not a deletion.
    const all = await call<{ reminders: ReminderView[] }>('/reminders?includeDone=true');
    expect(all.body.reminders.find((r) => r.id === created.body.id)?.state).toBe('cancelled');
  });

  it('35. a reminder for a task that does not exist is refused', async () => {
    const result = await call<{ error: string }>('/reminders', {
      method: 'POST',
      body: { text: 'Nothing', remindAt: AT, ownerKind: 'task', ownerId: 'T-nope' },
    });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('no_such_owner');
  });

  it('36. completing the task takes its reminder with it', async () => {
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Shred') } });
    const reminder = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: { text: 'Shred the papers', remindAt: AT, ownerKind: 'task', ownerId: task.body.id },
    });

    await call(`/tasks/${task.body.id}`, { method: 'PATCH', body: { done: true } });

    const pending = await call<{ reminders: ReminderView[] }>('/reminders');
    expect(pending.body.reminders.map((r) => r.id)).not.toContain(reminder.body.id);
  });

  it('37. dropping the task takes its reminder with it too', async () => {
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Abandon') } });
    const reminder = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: { text: 'Abandoned plan', remindAt: AT, ownerKind: 'task', ownerId: task.body.id },
    });

    await call(`/tasks/${task.body.id}`, { method: 'DELETE' });

    const pending = await call<{ reminders: ReminderView[] }>('/reminders');
    expect(pending.body.reminders.map((r) => r.id)).not.toContain(reminder.body.id);
  });

  it('38. cancelling the calendar event takes its reminder with it', async () => {
    const event = await call<{ id: string }>('/calendar', {
      method: 'POST',
      body: { title: unique('Dentist'), startsAt: AT },
    });
    const reminder = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: { text: 'Leave for the dentist', remindAt: AT, ownerKind: 'event', ownerId: event.body.id },
    });
    expect(reminder.status).toBe(201);

    await call(`/calendar/${event.body.id}`, { method: 'DELETE' });

    const pending = await call<{ reminders: ReminderView[] }>('/reminders');
    expect(pending.body.reminders.map((r) => r.id)).not.toContain(reminder.body.id);
  });

  it('39. a bad reminder is 400 at the boundary, never a 500', async () => {
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Fine') } });
    const bad = [
      {},
      { text: '', remindAt: AT, ownerKind: 'task', ownerId: task.body.id },
      { text: 'x', remindAt: 'tuesday', ownerKind: 'task', ownerId: task.body.id },
      { text: 'x', remindAt: AT, ownerKind: 'invoice', ownerId: task.body.id },
      { text: 'x'.repeat(500), remindAt: AT, ownerKind: 'task', ownerId: task.body.id },
    ];
    for (const body of bad) {
      expect((await call('/reminders', { method: 'POST', body })).status).toBe(400);
    }
    expect((await call('/reminders/R-nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('40. the three reminder tools are registered, and no more', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, {
      reminders: {
        store: undefined as never,
      },
    });
    expect(registry.list().map((tool) => tool.name).filter((name) => name.startsWith('reminders.')))
      .toEqual(['reminders.cancel', 'reminders.list', 'reminders.set']);
  });
});

/**
 * S4 tests 49–58: the notification routes.
 *
 * These drive the real composition root, so they check the thing the
 * store tests cannot: that the session a notification points at is
 * the session the worker actually wrote into.
 */
interface NotificationView {
  id: string;
  text: string;
  firedAt: number;
  sessionId: string;
}

describe('the notification routes', () => {
  it('49. a fresh agent has nothing to show', async () => {
    const result = await call<{ notifications: NotificationView[] }>('/notifications');
    expect(result.status).toBe(200);
    expect(result.body.notifications).toEqual([]);
  });

  it('50. a reminder that has fired appears, and marking it seen clears it', async () => {
    // Fire it for real: set it in the past and let the scheduler's own
    // catch-up sweep pick it up, rather than reaching into the store.
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Bins') } });
    const reminder = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: {
        text: 'Put the bins out',
        remindAt: Date.now() - 60_000,
        ownerKind: 'task',
        ownerId: task.body.id,
      },
    });
    expect(reminder.status).toBe(201);

    // The worker polls; give it a moment to run the one-shot schedule.
    const deadline = Date.now() + 15_000;
    let listed: NotificationView[] = [];
    while (Date.now() < deadline) {
      listed = (await call<{ notifications: NotificationView[] }>('/notifications')).body
        .notifications;
      if (listed.some((n) => n.id === reminder.body.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const found = listed.find((n) => n.id === reminder.body.id);
    expect(found).toBeDefined();
    expect(found?.text).toBe('Put the bins out');
    expect(found?.sessionId).toMatch(/^ses-schedule-/);

    // And the session it names really is where the agent spoke about it.
    const session = await call<{ messages: Array<{ text: string }> }>(
      `/sessions/${found!.sessionId}`,
    );
    expect(session.status).toBe(200);
    expect(session.body.messages.map((m) => m.text).join('\n')).toContain('Put the bins out');

    const seen = await call(`/notifications/${reminder.body.id}/seen`, { method: 'POST' });
    expect(seen.status).toBe(200);

    const after = await call<{ notifications: NotificationView[] }>('/notifications');
    expect(after.body.notifications.map((n) => n.id)).not.toContain(reminder.body.id);
  }, 30_000);

  it('51. marking an unknown notification seen is a 404, not a silent success', async () => {
    const result = await call<{ error: string }>('/notifications/R-nope/seen', { method: 'POST' });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('no_such_notification');
  });

  it('52. a reminder that has not fired is not a notification', async () => {
    const task = await call<TaskView>('/tasks', { method: 'POST', body: { title: unique('Later') } });
    const reminder = await call<ReminderView>('/reminders', {
      method: 'POST',
      body: {
        text: 'Much later',
        remindAt: Date.UTC(2030, 0, 1),
        ownerKind: 'task',
        ownerId: task.body.id,
      },
    });

    const listed = await call<{ notifications: NotificationView[] }>('/notifications');
    expect(listed.body.notifications.map((n) => n.id)).not.toContain(reminder.body.id);

    // And it cannot be dismissed, because it has not happened.
    expect((await call(`/notifications/${reminder.body.id}/seen`, { method: 'POST' })).status).toBe(
      404,
    );
  });
});
