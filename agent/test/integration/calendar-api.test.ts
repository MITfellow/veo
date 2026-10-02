/**
 * S1 tests 34–39: the calendar over HTTP, and the registry contract.
 *
 * Through `start()` rather than against the store, because the point of
 * these three routes is that the *person* can see and change what the
 * agent put in their calendar. A tool-only calendar is a calendar you
 * have to ask the agent about, which is the opposite of the idea.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { ToolRegistry } from '../../src/capability/registry.js';
import { registerBuiltins } from '../../src/tools/index.js';
import { jsonSchemaOf } from '../../src/capability/schema-json.js';

let app: StartedAgent;
let dir: string;

const call = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${app.token}`,
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
};

interface EventView {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  timezone: string;
  location: string | null;
  cancelledAt: number | null;
  conflicts?: Array<{ id: string; title: string }>;
}

/** Fixed instants, so nothing here depends on the day the suite runs. */
const DAY = Date.UTC(2027, 2, 14); // a Sunday, well clear of other suites
const at = (hour: number, minute = 0): number => DAY + hour * 3_600_000 + minute * 60_000;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-calendar-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the calendar routes', () => {
  it('35. POST then GET round-trips an event through HTTP', async () => {
    const created = await call<EventView>('/calendar', {
      method: 'POST',
      body: {
        title: 'Dentist',
        startsAt: at(9, 30),
        timezone: 'Europe/Lisbon',
        location: 'Rua Garrett 12',
      },
    });

    expect(created.status).toBe(201);
    expect(created.body.title).toBe('Dentist');
    expect(created.body.location).toBe('Rua Garrett 12');
    // No end given, so it got an hour.
    expect(created.body.endsAt).toBe(at(10, 30));
    expect(created.body.conflicts).toEqual([]);

    const listed = await call<{ events: EventView[] }>(
      `/calendar?from=${at(0)}&to=${at(24)}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.events.map((event) => event.id)).toContain(created.body.id);
  });

  it('34. windows by from/to and searches by q', async () => {
    await call<EventView>('/calendar', {
      method: 'POST',
      body: { title: 'Lunch with Rui', startsAt: at(13), timezone: 'UTC' },
    });
    await call<EventView>('/calendar', {
      method: 'POST',
      body: { title: 'Far future thing', startsAt: at(24 * 40), timezone: 'UTC' },
    });

    const day = await call<{ events: EventView[] }>(`/calendar?from=${at(0)}&to=${at(24)}`);
    const titles = day.body.events.map((event) => event.title);
    expect(titles).toContain('Lunch with Rui');
    expect(titles).not.toContain('Far future thing');
    // Ordered, because an agenda out of order is not an agenda.
    const starts = day.body.events.map((event) => event.startsAt);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);

    const found = await call<{ events: EventView[] }>('/calendar?q=rui');
    expect(found.body.events.map((event) => event.title)).toEqual(['Lunch with Rui']);
  });

  it('36. DELETE cancels, and the event leaves the agenda', async () => {
    const created = await call<EventView>('/calendar', {
      method: 'POST',
      body: { title: 'Cancel me', startsAt: at(16), timezone: 'UTC' },
    });

    const removed = await call<{ cancelled: string }>(`/calendar/${created.body.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(removed.body.cancelled).toBe(created.body.id);

    const listed = await call<{ events: EventView[] }>(`/calendar?from=${at(0)}&to=${at(24)}`);
    expect(listed.body.events.map((event) => event.id)).not.toContain(created.body.id);

    // An id that was never there is a 404, not a silent success.
    expect((await call(`/calendar/C-nope`, { method: 'DELETE' })).status).toBe(404);
  });

  it('reports an overlap on create instead of refusing it', async () => {
    const first = await call<EventView>('/calendar', {
      method: 'POST',
      body: { title: 'Standup', startsAt: at(48 + 9), timezone: 'UTC' },
    });
    const second = await call<EventView>('/calendar', {
      method: 'POST',
      body: { title: 'Interview', startsAt: at(48 + 9) + 1_800_000, timezone: 'UTC' },
    });

    expect(second.status).toBe(201);
    expect(second.body.conflicts).toEqual([{ id: first.body.id, title: 'Standup' }]);
  });

  it('rejects a bad event at the boundary with 400, never a 500', async () => {
    const backwards = await call('/calendar', {
      method: 'POST',
      body: { title: 'Backwards', startsAt: at(17), endsAt: at(9) },
    });
    expect(backwards.status).toBe(400);

    const noTitle = await call('/calendar', { method: 'POST', body: { startsAt: at(9) } });
    expect(noTitle.status).toBe(400);

    const badZone = await call('/calendar', {
      method: 'POST',
      body: { title: 'Nowhere', startsAt: at(9), timezone: 'Mars/Olympus_Mons' },
    });
    expect(badZone.status).toBe(400);

    const badWindow = await fetch(`http://127.0.0.1:${app.port}/calendar?from=yesterday`, {
      headers: { authorization: `Bearer ${app.token}` },
    });
    expect(badWindow.status).toBe(400);
  });

  it('needs the bearer token, like every other route', async () => {
    const response = await fetch(`http://127.0.0.1:${app.port}/calendar`);
    expect(response.status).toBe(401);
  });
});

describe('the S1 tools in the registry', () => {
  it('37. all nine appear, with schemas a model can read', () => {
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
    });

    const names = registry.list().map((tool) => tool.name);
    for (const expected of [
      'calendar.add',
      'calendar.list',
      'calendar.find',
      'calendar.cancel',
      'math.eval',
      'time.convert',
      'time.until',
      'notes.list',
      'notes.search',
    ]) {
      expect(names, expected).toContain(expected);
    }

    // The description is what a model chooses on, and the schema is the
    // single definition of the arguments — there is no second copy.
    const spec = registry.specsFor(() => true).find((s) => s.name === 'calendar.add');
    expect(spec?.description).toMatch(/calendar/i);
    expect(spec?.parameters.properties?.['title']?.type).toBe('string');
    expect(spec?.parameters.required).toContain('title');

    const add = registry.get('calendar.add')!;
    expect(jsonSchemaOf(add.input).properties?.['when']?.description).toMatch(/2026-04-01/);
  });

  it('38. the FOREIGN tool list excludes everything that writes', () => {
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
    });

    // What a run sees when its effective trust has been dragged to the
    // floor by a fenced web page: arithmetic and clock reading, and
    // nothing that touches the user's data.
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
      // Added at S2. Converting a figure out of a web page cannot hurt
      // anyone, so it sits at the floor with the other pure ones.
      'unit.convert',
    ]);

    for (const name of ['calendar.add', 'calendar.cancel', 'notes.search', 'notes.list']) {
      expect(registry.get(name)!.minTrust, name).not.toBe('FOREIGN');
    }
    // And the one that destroys something a person created needs them.
    expect(registry.get('calendar.cancel')!.minTrust).toBe('USER');
  });

  it('39. the calendar tools stayed inside src/tools/', () => {
    // The plugin contract from §20: adding tools changes `src/tools/`
    // plus a registration line, and nothing in the kernel learns a tool
    // name. `plugin.test.ts` asserts the general property; this is the
    // specific claim for S1's nine.
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.get('math.eval')).toBeDefined();
    // The calendar tools need a live store, so they follow memory's
    // precedent: offered only when the dependency is supplied, rather
    // than registered against a global.
    expect(registry.get('calendar.add')).toBeUndefined();
  });
});
