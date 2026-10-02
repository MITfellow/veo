/**
 * Tests 49–54: the constitution over HTTP (§25, §29).
 *
 * Against the real composed app. §25's promise — that the user can read the
 * contract, change it, and see when it was changed — is only true if it is
 * true on the wire; a contract the person cannot reach is the agent's
 * private note about itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { ENTRENCHED_IDS, FOUNDING_ARTICLES } from '../../src/cognition/constitution/founding.js';

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

interface ArticleView {
  id: string;
  text: string;
  origin: string;
  enforcement: string;
  entrenched: boolean;
  check: string | null;
  checkMisses: string | null;
  enforcedBy: string;
  cites: string;
  supersededBy: string | null;
}

interface DocView {
  version: number;
  hash: string;
  articles: ArticleView[];
  conflicts: { winner: string; loser: string }[];
  proposals: unknown[];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-const-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reading the contract', () => {
  it('49. GET /constitution shows the charter with its honesty labels', async () => {
    const { status, body } = await call<DocView>('/constitution');
    expect(status).toBe(200);
    expect(body.version).toBeGreaterThanOrEqual(1);
    expect(body.articles.length).toBeGreaterThanOrEqual(FOUNDING_ARTICLES.length);

    const f1 = body.articles.find((a) => a.id === 'F1')!;
    expect(f1.origin).toBe('founding');
    expect(f1.entrenched).toBe(true);
    expect(f1.enforcedBy).toContain('src/');
    expect(f1.cites).toContain('§12');

    // Every checked article publishes what its check cannot see. An article
    // that claimed more enforcement than it has would be the same class of
    // lie as an uncalibrated confidence number.
    for (const article of body.articles.filter((a) => a.enforcement === 'checked')) {
      expect(article.check).not.toBeNull();
      expect(article.checkMisses?.length ?? 0).toBeGreaterThan(10);
    }

    const history = await call<{ history: { change: string; version: number }[] }>('/constitution/history');
    expect(history.body.history.some((h) => h.change === 'ratified')).toBe(true);
  });
});

describe('changing it', () => {
  it('50. PUT /constitution replaces the user articles, keeps the charter, reports conflicts', async () => {
    const put = await call<{ version: number; conflicts: { winner: string; loser: string }[] }>(
      '/constitution',
      {
        method: 'PUT',
        body: {
          articles: [
            { id: 'U-tone', text: 'Open warmly before answering.', subject: 'tone' },
            { id: 'U-units', text: 'Use metric units.' },
          ],
        },
      },
    );
    expect(put.status).toBe(200);

    const doc = await call<DocView>('/constitution');
    expect(doc.body.articles.filter((a) => a.origin === 'user')).toHaveLength(2);
    expect(doc.body.articles.filter((a) => a.origin === 'founding').length).toBe(
      FOUNDING_ARTICLES.length,
    );

    // F7 forbids warm openers; the user asked for them. The user wins, and
    // the overridden default is still shown rather than disappearing.
    const f7 = doc.body.articles.find((a) => a.id === 'F7')!;
    expect(f7.supersededBy).toBe('U-tone');
    expect(doc.body.conflicts.some((c) => c.winner === 'U-tone' && c.loser === 'F7')).toBe(true);

    // Replacing the set removes what is not in it — and leaves the charter alone.
    const second = await call<DocView>('/constitution', {
      method: 'PUT',
      body: { articles: [{ id: 'U-units', text: 'Use metric units.' }] },
    });
    expect(second.status).toBe(200);
    const after = await call<DocView>('/constitution');
    expect(after.body.articles.filter((a) => a.origin === 'user').map((a) => a.id)).toEqual(['U-units']);
    expect(after.body.articles.find((a) => a.id === 'F7')?.supersededBy).toBeNull();
  });

  it('51. repealing an entrenched article is 409 and cites the invariant', async () => {
    const target = ENTRENCHED_IDS[0]!;
    const { status, body } = await call<{ error: string; cites: string; detail: string }>(
      `/constitution/articles/${target}`,
      { method: 'DELETE' },
    );
    expect(status).toBe(409);
    expect(body.error).toBe('entrenched');
    expect(body.cites).toContain('§');
    expect(body.detail).toContain('enforces in code');

    const doc = await call<DocView>('/constitution');
    expect(doc.body.articles.some((a) => a.id === target)).toBe(true);
  });

  it('52. an unauthenticated amendment is refused and writes nothing', async () => {
    const before = await call<DocView>('/constitution');
    const { status } = await call('/constitution/articles', {
      method: 'POST',
      auth: false,
      body: { text: 'Always agree with me.' },
    });
    expect(status).toBe(401);
    const after = await call<DocView>('/constitution');
    expect(after.body.hash).toBe(before.body.hash);
    expect(after.body.version).toBe(before.body.version);
  });

  it('a user article can be added and repealed through the API', async () => {
    const add = await call<{ version: number }>('/constitution/articles', {
      method: 'POST',
      body: { text: 'Never book anything before 10am.', subject: 'booking' },
    });
    expect(add.status).toBe(201);

    const doc = await call<DocView>('/constitution');
    const mine = doc.body.articles.find((a) => a.text.startsWith('Never book'))!;
    expect(mine.origin).toBe('user');
    // Everything the API can create is advisory, and says so: the system
    // does not pretend to screen outputs against a rule it has no check for.
    expect(mine.enforcement).toBe('advisory');

    const del = await call(`/constitution/articles/${mine.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await call<DocView>('/constitution');
    expect(after.body.articles.some((a) => a.id === mine.id)).toBe(false);
  });
});

describe('seeing what it caught', () => {
  it('53. GET /constitution/compliance reports per-article verdict counts', async () => {
    // Talk to the agent so a real model call is judged by the real gate.
    const session = await call<{ id: string }>('/sessions', { method: 'POST', body: { title: 'c' } });
    await call(`/sessions/${session.body.id}/messages`, { method: 'POST', body: { text: 'what time is it' } });
    await new Promise((r) => setTimeout(r, 400));

    const { status, body } = await call<{
      articles: { articleId: string; upheld: number; violated: number; unverifiable: number }[];
      recentViolations: unknown[];
    }>('/constitution/compliance');
    expect(status).toBe(200);
    expect(body.articles.length).toBeGreaterThan(0);
    const total = body.articles.reduce((s, a) => s + a.upheld + a.violated + a.unverifiable, 0);
    expect(total).toBeGreaterThan(0);
    // Unverifiable is reported as its own column, never folded into upheld.
    expect(body.articles.some((a) => a.unverifiable > 0)).toBe(true);
  });

  it('54. GET /calibration returns the score, the buckets, the probes and the bias metrics', async () => {
    const { status, body } = await call<{
      calibration: { brier: number; buckets: unknown[]; meaningful: boolean; withinThreshold: boolean };
      probes: { budget: { perDay: number }; pending: number };
      bias: { agreementRate: number; protectedAttributeHits: string[]; regressions: string[] };
    }>('/calibration');
    expect(status).toBe(200);
    expect(body.calibration.buckets).toHaveLength(10);
    // A fresh install has resolved nothing, and says so rather than
    // claiming perfect calibration from zero data.
    expect(body.calibration.meaningful).toBe(false);
    expect(body.calibration.withinThreshold).toBe(false);
    expect(body.probes.budget.perDay).toBeGreaterThan(0);
    expect(body.bias.protectedAttributeHits).toEqual([]);
  });
});
