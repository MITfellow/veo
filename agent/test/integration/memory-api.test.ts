/**
 * §22.8 over HTTP — what the user can see and rip out.
 *
 * §22.8 is the only subsection of §22 marked **mandatory**, and it is a list
 * of rights rather than features: list, search, filter, pin, correct,
 * forget, export, explain. These run against the real composed app, because
 * a right that exists in a unit test and not on the wire is not a right.
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
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> => {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
};

interface FactView {
  id: string;
  text: string;
  basis: string;
  confidence: number;
  status: string;
  pinned: boolean;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-mem-api-'));
  app = await start({ port: 0, dbPath: join(dir, 'api.db'), token: 'api-token' });

  // Learn a few things the way the product does: by talking to it.
  const session = await call<{ id: string }>('/sessions', { method: 'POST', body: { title: 'm' } });
  for (const text of [
    'My name is Ara',
    'I work at Anthropic',
    'I am allergic to peanuts',
  ]) {
    await call(`/sessions/${session.body.id}/messages`, { method: 'POST', body: { text } });
  }
  // The write path runs after the run, so give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 600));
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('§22.8 — list, search, filter', () => {
  it('lists what the agent believes, with its epistemics', async () => {
    const { status, body } = await call<{ facts: FactView[]; counts: Record<string, number> }>(
      '/memory',
    );
    expect(status).toBe(200);
    expect(body.facts.length).toBeGreaterThan(0);
    expect(body.facts.map((fact) => fact.text).join(' ')).toContain('Ara');

    // Never a bare list of strings: every row carries where it came from
    // and how sure the agent is (invariant 5).
    for (const fact of body.facts) {
      expect(fact.basis).toBeTruthy();
      expect(fact.confidence).toBeGreaterThan(0);
    }
    expect(body.counts.active).toBeGreaterThan(0);
  });

  it('searches and filters by basis, confidence and pin', async () => {
    const search = await call<{ facts: FactView[] }>('/memory?q=anthropic');
    expect(search.body.facts).toHaveLength(1);
    expect(search.body.facts[0]!.text).toContain('Anthropic');

    const asserted = await call<{ facts: FactView[] }>('/memory?basis=asserted_by_user');
    expect(asserted.body.facts.length).toBeGreaterThan(0);
    expect(asserted.body.facts.every((fact) => fact.basis === 'asserted_by_user')).toBe(true);

    const confident = await call<{ facts: FactView[] }>('/memory?minConfidence=0.99');
    expect(confident.body.facts).toHaveLength(0);

    const bad = await call('/memory?minConfidence=9');
    expect(bad.status).toBe(400);
  });
});

describe('§22.8 — explain', () => {
  it('shows the source words, the date, the confidence and the chain', async () => {
    const list = await call<{ facts: FactView[] }>('/memory?q=anthropic');
    const id = list.body.facts[0]!.id;

    const { status, body } = await call<{
      fact: FactView;
      sources: Array<{ quote?: string }>;
      explanation: string[];
      history: unknown[];
    }>(`/memory/${id}`);

    expect(status).toBe(200);
    expect(body.sources[0]?.quote).toContain('Anthropic');
    expect(body.history.length).toBeGreaterThanOrEqual(1);

    // Plain language, and written from the record rather than by the model
    // — an explanation produced by the thing that might be wrong is a story,
    // not an audit.
    const prose = body.explanation.join(' ');
    expect(prose).toMatch(/You told me this on \d{4}-\d{2}-\d{2}/);
    expect(prose).toContain('The words it came from');
    expect(prose).toMatch(/\d+% sure/);
  });

  it('404s for a fact that does not exist', async () => {
    const { status } = await call('/memory/nope');
    expect(status).toBe(404);
  });
});

describe('§22.8 — pin, correct, forget', () => {
  it('pins and unpins', async () => {
    const list = await call<{ facts: FactView[] }>('/memory?q=allergic');
    const id = list.body.facts[0]!.id;

    await call(`/memory/${id}/pin`, { method: 'POST', body: { pinned: true } });
    const pinned = await call<{ facts: FactView[] }>('/memory?pinned=true');
    expect(pinned.body.facts.map((fact) => fact.id)).toContain(id);

    await call(`/memory/${id}/pin`, { method: 'POST', body: { pinned: false } });
    const after = await call<{ facts: FactView[] }>('/memory?pinned=true');
    expect(after.body.facts.map((fact) => fact.id)).not.toContain(id);
  });

  it('corrects: the old belief stays on record as a mistake', async () => {
    const list = await call<{ facts: FactView[] }>('/memory?q=anthropic');
    const id = list.body.facts[0]!.id;

    const corrected = await call<{ corrected: string; replacement: string }>(
      `/memory/${id}/correct`,
      { method: 'POST', body: { correction: 'Globex' } },
    );
    expect(corrected.status).toBe(200);

    const now = await call<{ facts: FactView[] }>('/memory?q=globex');
    expect(now.body.facts[0]!.basis).toBe('asserted_by_user');
    expect(now.body.facts[0]!.confidence).toBeGreaterThanOrEqual(0.9);

    // The mistake is not erased — it is marked. "You used to think X" has to
    // stay answerable or the agent is rewriting its own history.
    const explained = await call<{ history: Array<{ text: string }> }>(`/memory/${id}`);
    expect(JSON.stringify(explained.body.history)).toContain('Anthropic');

    const missing = await call('/memory/nope/correct', {
      method: 'POST',
      body: { correction: 'x' },
    });
    expect(missing.status).toBe(404);

    const empty = await call(`/memory/${id}/correct`, { method: 'POST', body: {} });
    expect(empty.status).toBe(400);
  });

  it('forgets one memory, destructively', async () => {
    const list = await call<{ facts: FactView[] }>('/memory?q=allergic');
    const id = list.body.facts[0]!.id;

    const { status, body } = await call<{ shredded: boolean }>(`/memory/${id}`, {
      method: 'DELETE',
    });
    expect(status).toBe(200);
    expect(body.shredded).toBe(true);

    const after = await call<{ facts: FactView[] }>('/memory?q=peanuts');
    expect(after.body.facts).toHaveLength(0);
  });

  it('refuses to forget everything without a subject', async () => {
    // "Delete all my memories" must be a deliberate act with a named
    // target, not something a mistyped URL can do.
    const { status, body } = await call<{ detail: string }>('/memory', { method: 'DELETE' });
    expect(status).toBe(400);
    expect(body.detail).toContain('subject');
  });

  it('forgets everything about a named subject', async () => {
    const { status, body } = await call<{ forgotten: string[] }>('/memory?subject=self', {
      method: 'DELETE',
    });
    expect(status).toBe(200);
    expect(body.forgotten.length).toBeGreaterThan(0);

    const after = await call<{ facts: FactView[] }>('/memory');
    expect(after.body.facts).toHaveLength(0);
  });
});

describe('§22.8 — export, digest, and the refusals', () => {
  it('exports everything readable, including what was refused', async () => {
    const session = await call<{ id: string }>('/sessions', {
      method: 'POST',
      body: { title: 'export' },
    });
    await call(`/sessions/${session.body.id}/messages`, {
      method: 'POST',
      body: { text: "I live in Lisbon — actually don't remember that" },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { status, body } = await call<{
      facts: unknown[];
      rules: unknown[];
      refused: Array<{ reason: string }>;
    }>('/memory/export');

    expect(status).toBe(200);
    expect(Array.isArray(body.facts)).toBe(true);
    // The refusals are in the export. Over-rejection is otherwise invisible:
    // a memory never written leaves no trace in the store.
    expect(body.refused.some((entry) => entry.reason.startsWith('user-refused'))).toBe(true);
  });

  it('serves the "what I learned recently" digest', async () => {
    const { status, body } = await call<{ entries: unknown[]; identity: unknown }>(
      '/memory/digest',
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('requires a token like every other route', async () => {
    const response = await fetch(`http://127.0.0.1:${app.port}/memory`);
    expect(response.status).toBe(401);
  });
});

describe('a destroyed memory reads as destroyed', () => {
  it('shows a human line and drops the pin instead of leaking the shred marker', async () => {
    const session = await call<{ id: string }>('/sessions', {
      method: 'POST',
      body: { title: 'shred' },
    });
    await call(`/sessions/${session.body.id}/messages`, {
      method: 'POST',
      body: { text: 'I live in Lisbon' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const listed = await call<{ facts: FactView[] }>('/memory?q=lisbon');
    const id = listed.body.facts[0]!.id;
    await call(`/memory/${id}/pin`, { method: 'POST', body: { pinned: true } });
    await call(`/memory/${id}`, { method: 'DELETE' });

    const all = await call<{ facts: FactView[] }>('/memory?status=all');
    const tombstone = all.body.facts.find((fact) => fact.id === id)!;
    expect(tombstone.status).toBe('retired');
    // No key ids, no JSON, no leftover pin — the row says what happened.
    expect(tombstone.text).toContain('forgotten');
    expect(tombstone.text).not.toContain('$shredded');
    expect(tombstone.pinned).toBe(false);
  });
});
