/**
 * S2 tests 11–20: the task store, its projection and its trust rules.
 *
 * Test 16 is the one that matters: a list whose rows are the truth is a
 * list that a rebuild empties.
 */
import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { TaskStore } from '../../src/cognition/tasks/store.js';
import {
  makeTasksAdd,
  makeTasksComplete,
  makeTasksDrop,
  makeTasksList,
} from '../../src/tools/tasks.js';
import type { ToolContext } from '../../src/capability/tool.js';

const USER = 'user';
const DAY = Date.UTC(2027, 4, 3);
const at = (days: number): number => DAY + days * 86_400_000;

function fixture() {
  const substrate = createTestSubstrate();
  const store = new TaskStore({
    storage: substrate.storage,
    events: substrate.events,
    clock: substrate.clock,
    ids: substrate.ids,
  });
  return { ...substrate, store };
}

const ctx = (): ToolContext =>
  ({ principal: USER, now: () => DAY, effectiveTrust: 'USER' }) as unknown as ToolContext;

describe('the task list is events, not rows', () => {
  it('11. add writes task.added and projects one row', () => {
    const s = fixture();
    const before = s.events.count();

    const task = s.store.add(USER, { title: 'Buy a router', dueAt: at(3) });

    expect(s.events.count()).toBe(before + 1);
    const [appended] = s.events.read({ types: ['task.added'], limit: 10 });
    expect(appended?.payload).toMatchObject({
      taskId: task.id,
      title: 'Buy a router',
      dueAt: at(3),
    });
    expect(s.storage.get<{ n: number }>('SELECT COUNT(*) n FROM tasks')?.n).toBe(1);
    s.close();
  });

  it('12. lists soonest due first, with undated last', () => {
    const s = fixture();
    // Inserted in a deliberately unhelpful order.
    s.store.add(USER, { title: 'someday' });
    s.store.add(USER, { title: 'next week', dueAt: at(7) });
    s.store.add(USER, { title: 'tomorrow', dueAt: at(1) });
    s.store.add(USER, { title: 'also someday' });

    // SQLite sorts NULL first by default, so without the explicit key
    // every undated task would sit above tomorrow's deadline.
    expect(s.store.list(USER).map((task) => task.title)).toEqual([
      'tomorrow',
      'next week',
      'someday',
      'also someday',
    ]);
    s.close();
  });

  it('13. complete stamps completed_at and the task leaves the open list', () => {
    const s = fixture();
    const task = s.store.add(USER, { title: 'Reply to Rui' });
    expect(s.store.list(USER)).toHaveLength(1);

    expect(s.store.complete(USER, task.id)).toBe(true);
    expect(s.store.list(USER)).toEqual([]);
    expect(s.store.get(USER, task.id)?.completedAt).not.toBeNull();

    // Idempotent, and it must not append a second event.
    expect(s.store.complete(USER, task.id)).toBe(true);
    expect(s.events.read({ types: ['task.completed'], limit: 10 })).toHaveLength(1);
    s.close();
  });

  it('14. a completed task is still in the log and still listable', () => {
    const s = fixture();
    const task = s.store.add(USER, { title: 'Renew the lease' });
    s.store.complete(USER, task.id);

    const all = s.store.list(USER, { includeClosed: true });
    expect(all.map((t) => t.title)).toEqual(['Renew the lease']);
    expect(all[0]!.completedAt).not.toBeNull();
    s.close();
  });

  it('15. drop is a different event from complete, and means something else', () => {
    const s = fixture();
    const done = s.store.add(USER, { title: 'did this' });
    const abandoned = s.store.add(USER, { title: 'gave up on this' });

    s.store.complete(USER, done.id);
    s.store.drop(USER, abandoned.id);

    expect(s.events.read({ types: ['task.completed'], limit: 10 })).toHaveLength(1);
    expect(s.events.read({ types: ['task.dropped'], limit: 10 })).toHaveLength(1);

    // The distinction survives into the projection, which is the point:
    // "how much of what I wrote down actually got done" stays answerable.
    expect(s.store.get(USER, done.id)?.completedAt).not.toBeNull();
    expect(s.store.get(USER, done.id)?.droppedAt).toBeNull();
    expect(s.store.get(USER, abandoned.id)?.completedAt).toBeNull();
    expect(s.store.get(USER, abandoned.id)?.droppedAt).not.toBeNull();
    s.close();
  });

  it('16. a rebuild from events alone reproduces the list exactly', () => {
    const s = fixture();
    const kept = s.store.add(USER, { title: 'Kept', dueAt: at(2), note: 'with a note' });
    const done = s.store.add(USER, { title: 'Done' });
    const gone = s.store.add(USER, { title: 'Dropped' });
    s.store.complete(USER, done.id);
    s.store.drop(USER, gone.id);

    const snapshot = s.storage.all('SELECT * FROM tasks ORDER BY id');
    expect(snapshot).toHaveLength(3);

    s.storage.exec('DELETE FROM tasks');
    s.events.rebuild();

    expect(s.storage.all('SELECT * FROM tasks ORDER BY id')).toEqual(snapshot);
    expect(s.store.get(USER, kept.id)).toEqual(kept);
    s.close();
  });

  it('17. one principal cannot see or drop another principal\u2019s tasks', () => {
    const s = fixture();
    const hers = s.store.add('alice', { title: 'Alice only' });

    expect(s.store.list('bob')).toEqual([]);
    expect(s.store.get('bob', hers.id)).toBeUndefined();
    // Even knowing the id.
    expect(s.store.drop('bob', hers.id)).toBe(false);
    expect(s.store.complete('bob', hers.id)).toBe(false);
    expect(s.store.get('alice', hers.id)?.droppedAt).toBeNull();
    s.close();
  });

  it('refuses an empty title rather than storing a blank row', () => {
    const s = fixture();
    expect(() => s.store.add(USER, { title: '   ' })).toThrow(/needs a title/);
    expect(s.events.read({ types: ['task.added'], limit: 10 })).toHaveLength(0);
    s.close();
  });
});

describe('the task tools', () => {
  it('18. completing an unknown id is not_found, not a silent success', async () => {
    const s = fixture();
    const complete = makeTasksComplete({ store: s.store });
    const result = await complete.execute({ id: 'T-nope' }, ctx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
    expect(result.error.hint).toMatch(/tasks.list/);
    s.close();
  });

  it('19. drop is USER with a preview; complete is DERIVED', async () => {
    const s = fixture();
    const complete = makeTasksComplete({ store: s.store });
    const drop = makeTasksDrop({ store: s.store });

    // Ticking something off is reversible and visible, so the agent may
    // do it. Deleting what a person wrote down is not its call — the
    // same reasoning as decision 035 and `calendar.cancel`.
    expect(complete.minTrust).toBe('DERIVED');
    expect(complete.risk).toBe('caution');
    expect(drop.minTrust).toBe('USER');
    expect(drop.risk).toBe('dangerous');

    const task = s.store.add(USER, { title: 'Cancel the gym' });
    const preview = await drop.dryRun!({ id: task.id }, ctx());
    expect(preview).toContain('Cancel the gym');
    expect(preview).toMatch(/without marking it done/);
    // The preview changes nothing.
    expect(s.store.get(USER, task.id)?.droppedAt).toBeNull();
    s.close();
  });

  it('20. renders a list a model can read, not a JSON dump', async () => {
    const s = fixture();
    const add = makeTasksAdd({ store: s.store });
    const list = makeTasksList({ store: s.store });

    await add.execute({ title: 'Buy a router', timezone: 'UTC', due: '2027-05-06' }, ctx());
    await add.execute({ title: 'Reply to Rui', timezone: 'UTC' }, ctx());

    const result = await list.execute({ includeDone: false, limit: 50 }, ctx());
    const text = list.renderForModel(result, 200).text;

    expect(text).toContain('[ ] Buy a router');
    expect(text).toContain('[ ] Reply to Rui');
    expect(text).not.toContain('{');
    // The dated one sorts above the undated one.
    expect(text.indexOf('Buy a router')).toBeLessThan(text.indexOf('Reply to Rui'));

    const empty = await list.execute({ includeDone: false, limit: 50 }, {
      ...ctx(),
      principal: 'nobody',
    } as ToolContext);
    expect(list.renderForModel(empty, 100).text).toBe('The to-do list is empty.');
    s.close();
  });

  it('reads a bare due date as the end of that day', async () => {
    const s = fixture();
    const add = makeTasksAdd({ store: s.store });
    const result = await add.execute(
      { title: 'File the thing', due: '2027-05-06', timezone: 'UTC' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 23:59, not midnight: "due Thursday" means by the end of Thursday,
    // and midnight would make it overdue for the whole day.
    expect(result.value.dueAt).toBe(Date.UTC(2027, 4, 6, 23, 59));
    s.close();
  });

  it('refuses a due date it cannot read instead of inventing one', async () => {
    const s = fixture();
    const add = makeTasksAdd({ store: s.store });
    const result = await add.execute(
      { title: 'Whenever', due: 'sometime next week', timezone: 'UTC' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(s.events.read({ types: ['task.added'], limit: 10 })).toHaveLength(0);
    s.close();
  });
});
