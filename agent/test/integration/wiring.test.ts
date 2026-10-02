/**
 * The wiring audit.
 *
 * Every other test can pass while the product is broken in one specific
 * way: a module that exists, works, is unit-tested, and is *never
 * constructed by the composition root*. That is not hypothetical — M1
 * built a vault, a keyring and a model-request firewall, and until M9
 * nothing in `main.ts` built them, so the agent people actually ran had
 * no vault at all.
 *
 * This test asserts the thing no unit test can: that the pieces are
 * plugged in, in the running process, reachable through the API the UI
 * uses.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';

let app: StartedAgent;
let dir: string;
let base: string;

const auth = () => ({ authorization: `Bearer ${app.token}`, 'content-type': 'application/json' });
const get = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${base}${path}`, { headers: auth() })).json()) as T;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-wiring-'));
  app = await start({ port: 0, dbPath: join(dir, 'w.db'), token: 'wire-token' });
  base = `http://127.0.0.1:${app.port}`;
}, 30_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('every layer is actually wired into the product', () => {
  it('L0 substrate: migrations are applied and the chain verifies', async () => {
    const health = await get<{ status: string; events: number }>('/health');
    expect(health.status).toBe('ok');
    // Ratifying the founding constitution on first boot is itself proof
    // that the log, the projections and the migrations are all live.
    expect(health.events).toBeGreaterThan(0);
  });

  it('L2 security: the vault exists in the running process, not just in src/', async () => {
    // The regression this exists for: `createSecurity()` was real,
    // tested, and never called by `main.ts` for eight milestones.
    const vault = await get<{ state: string; secrets: unknown[] }>('/vault/secrets');
    expect(['uninitialized', 'locked', 'unlocked']).toContain(vault.state);
    expect(Array.isArray(vault.secrets)).toBe(true);
  });

  it('L3 capability: the tool registry is populated and trust-filtered', async () => {
    const session = (await (
      await fetch(`${base}/sessions`, { method: 'POST', headers: auth(), body: '{}' })
    ).json()) as { id: string };
    const run = (await (
      await fetch(`${base}/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ text: 'what time is it?' }),
      })
    ).json()) as { runId: string };

    for (let i = 0; i < 100; i += 1) {
      const trace = await get<{ trace: { status: string; toolCalls: Array<{ tool: string }> } }>(
        `/runs/${run.runId}/trace`,
      );
      if (trace.trace.status !== 'running') {
        expect(trace.trace.toolCalls.map((c) => c.tool)).toContain('clock.now');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the run never finished');
  }, 30_000);

  it('L4 cognition: memory, constitution, calibration and persona all answer', async () => {
    const memory = await get<{ facts: unknown[] }>('/memory');
    expect(Array.isArray(memory.facts)).toBe(true);

    const constitution = await get<{ version: number; articles: unknown[] }>('/constitution');
    expect(constitution.version).toBeGreaterThan(0);
    expect(constitution.articles.length).toBeGreaterThanOrEqual(15);

    const calibration = await get<{ probes: unknown; bias: unknown }>('/calibration');
    expect(calibration.probes).toBeDefined();
    expect(calibration.bias).toBeDefined();

    const persona = await get<{ rendered: string[] }>('/persona');
    expect(persona.rendered.length).toBeGreaterThan(0);

    const card = await get<{ maxTokens: number }>('/memory/identity-card');
    expect(card.maxTokens).toBe(400);
  });

  it('L5 orchestration: the scheduler, the queue and the ladder are running', async () => {
    const schedules = await get<{ schedules: unknown[] }>('/schedules');
    expect(Array.isArray(schedules.schedules)).toBe(true);

    const jobs = await get<{ counts: Record<string, number> }>('/jobs');
    expect(jobs.counts.pending).toBeDefined();

    // The worker is started by `main.ts`; the ladder knows this install
    // has no API key and says so rather than claiming full capability.
    const ladder = await get<{ level: string; signals: Array<{ signal: string }> }>('/degradation');
    expect(ladder.level).toBe('L2');
    expect(ladder.signals.map((s) => s.signal)).toContain('model');
  });

  it('L6 observability: the trace, the metrics and the backup check are mounted', async () => {
    const metrics = await get<{ runs: { total: number } }>('/metrics');
    expect(metrics.runs.total).toBeGreaterThan(0);

    const events = await get<{ total: number }>('/events?limit=5');
    expect(events.total).toBeGreaterThan(0);

    const backup = await (
      await fetch(`${base}/backup/verify`, { method: 'POST', headers: auth() })
    ).json();
    expect((backup as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  it('the context the model sees contains every block the layers contribute', async () => {
    const runs = await get<{ events: Array<{ runId: string | null }> }>(
      '/events?types=run.started&limit=1',
    );
    const runId = runs.events[0]!.runId!;
    const text = await (
      await fetch(`${base}/runs/${runId}/trace?format=text`, { headers: auth() })
    ).text();

    // If a layer is wired but contributes nothing, this is where it shows.
    for (const block of ['kernel', 'constitution', 'identity', 'situation', 'conversation']) {
      expect(text, `${block} is missing from the assembled context`).toContain(block);
    }
    // And the governance gate ran: a model call without the constitution
    // is impossible by construction (decision 032).
    expect(text).toContain('constitution');
  });

  it('the Veo client and the agent agree about every route the client calls', () => {
    // A cheap, surprisingly effective check: every `/path` string the
    // client library sends must exist in the server's route table. It
    // catches the rename that unit tests on both sides happily survive.
    const client = readFileSync(new URL('../../../src/lib/agent.ts', import.meta.url), 'utf8');
    const server = readFileSync(new URL('../../src/interface/http.ts', import.meta.url), 'utf8');

    const paths = [...client.matchAll(/call(?:Text)?\(\s*([`'"])([^`'"]+)\1/g)]
      .map((match) => match[2]!)
      // `${id}` → a single path segment; drop any query string.
      .map((path) => path.replace(/\$\{[^}]*\}/g, ':x').split('?')[0]!)
      .filter((path) => path.startsWith('/') && path.length > 1);
    expect(paths.length).toBeGreaterThan(15);

    const missing = paths.filter((path) => {
      const segments = path.replace(/\/+$/, '').split('/').filter(Boolean);
      const pattern = new RegExp(
        `'(/${segments.map((segment) => (segment === ':x' ? "[^/\\s']+" : segment)).join('/')})'`,
      );
      return !pattern.test(server);
    });
    expect(missing, 'the client calls routes the agent does not serve').toEqual([]);
  });

  /**
   * The same audit, pointed the other way — and the one that actually
   * finds things.
   *
   * The forward check above catches a rename. It cannot catch the much
   * more common failure: the server grows a capability, the capability
   * is correct and tested, and no client ever asks for it. That is
   * invisible to every test on both sides and visible to the user as a
   * feature that was never built. It had happened to twelve routes by
   * the end of M9 — the whole vault among them, which is why every
   * install anyone ran sat at L2 with no way to supply a model key.
   *
   * An exemption has to be argued for in writing, here, next to the
   * name. Silence is not an exemption.
   */
  it('every route the agent serves is reachable from the Veo client', () => {
    const UNSURFACED: Record<string, string> = {
      'GET /health':
        'called by the dev proxy and the e2e harness, not by the UI: a health probe the ' +
        'user has to read is a health probe that failed.',
      'GET /sessions':
        'Veo owns conversation identity. The agent session is an implementation detail ' +
        'reached through `chat.agentSessionId`; a second list would be a competing source ' +
        'of truth about what conversations exist.',
      'PUT /constitution':
        'replaces the whole document in one write, which defeats the article-level ' +
        'amendment history the constitution panel exists to show. The UI amends; it does ' +
        'not overwrite.',
      'GET /runs/:id/stream':
        'not a `call()` — `follow()` opens it with a raw fetch because it is an SSE body, ' +
        'not JSON.',
    };

    const server = readFileSync(new URL('../../src/interface/http.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../../src/lib/agent.ts', import.meta.url), 'utf8');

    const routes = [...server.matchAll(/this\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
      ([, method, path]) => ({ method: method!, path: path! }),
    );
    // If this ever reads zero routes the regex has rotted and the test is
    // passing by vacuum.
    expect(routes.length).toBeGreaterThan(40);

    // Every path the client sends, with its verb, normalised the same way
    // the forward check normalises them.
    const calls = [...client.matchAll(/call(?:Text)?<?[^>]*>?\(\s*([`'"])([^`'"]+)\1([^)]*)/g)].map(
      ([, , path, rest]) => ({
        path: path!
          .replace(/\$\{[^}]*\}/g, ':x')
          // An interpolation glued onto a literal segment is a query
          // string being appended conditionally — `/memory${q}` — not a
          // path parameter. Dropping it is what makes `/memory` match.
          .replace(/([^/]):x/g, '$1')
          // A nested template — `/memory${q === '' ? '' : `?${q}`}` —
          // defeats the quote-delimited capture above; everything from
          // the first unclosed interpolation on is a query string.
          .replace(/\$\{.*$/, '')
          .split('?')[0]!,
        method: /method:\s*'([A-Z]+)'/.exec(rest ?? '')?.[1] ?? 'GET',
      }),
    );

    // A second pass for the calls the first one cannot see: a template
    // containing a *nested* template — `/memory${q === '' ? '' : `?${q}`}`
    // — has quotes inside it, so the quote-delimited capture above never
    // completes. The literal prefix before the first interpolation is
    // enough to identify the route.
    calls.push(
      ...[...client.matchAll(/call(?:Text)?<?[^>(]*>?\(\s*`([^`$]*)\$\{([^`]*)/g)].map(
        ([, prefix, rest]) => ({
          path: prefix!.split('?')[0]!.replace(/\/$/, ''),
          method: /method:\s*'([A-Z]+)'/.exec(rest ?? '')?.[1] ?? 'GET',
        }),
      ),
    );
    // `follow()` is the one raw fetch, and it is exempted by name below.

    const matches = (route: { method: string; path: string }): boolean =>
      calls.some((callSite) => {
        if (callSite.method !== route.method) return false;
        const expected = route.path.split('/').filter(Boolean);
        const actual = callSite.path.split('/').filter(Boolean);
        if (expected.length !== actual.length) return false;
        return expected.every(
          (segment, i) => segment.startsWith(':') || segment === actual[i],
        );
      });

    const unreachable = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((name, index) => !matches(routes[index]!) && UNSURFACED[name] === undefined);

    expect(
      unreachable,
      'the agent serves these and no UI can reach them — wire them, or add them to ' +
        'UNSURFACED with the reason',
    ).toEqual([]);

    // And the exemption list cannot rot into a list of names that no
    // longer exist, which is how an allowlist stops being read.
    const served = new Set(routes.map((route) => `${route.method} ${route.path}`));
    expect(
      Object.keys(UNSURFACED).filter((name) => !served.has(name)),
      'UNSURFACED names a route the agent no longer serves',
    ).toEqual([]);
  });
});
