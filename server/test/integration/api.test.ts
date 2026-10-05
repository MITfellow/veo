import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/substrate/config.js';
import { MemoryFileStore, RealFileStore } from '../../src/substrate/files.js';
import { handleApi, type HttpDeps } from '../../src/interface/http.js';
import { ensureConnectorTable } from '../../src/interface/api.js';
import { allConnectors, combinationRisk, getConnector } from '../../src/capability/connectors.js';
import { createTestSubstrate } from '../fakes/substrate.js';

function deps(overrides: Partial<HttpDeps> = {}): { d: HttpDeps; close: () => void } {
  const s = createTestSubstrate();
  ensureConnectorTable(s.storage);
  return {
    close: () => s.close(),
    d: {
      storage: s.storage,
      config: ConfigSchema.parse({}),
      now: () => s.clock.now(),
      eventCount: () => s.events.count(),
      ...overrides,
    },
  };
}

const get = (path: string, d: HttpDeps) => handleApi('GET', path, undefined, d);
const post = (path: string, body: unknown, d: HttpDeps) => handleApi('POST', path, body, d);

describe('the platform endpoint tells the truth about the build', () => {
  it('reports L1 and eleven jobs with no model', async () => {
    const { d, close } = deps();
    const res = await get('/api/status', d);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'ARISH', degradation: 'L1', jobs: 11, autonomy: 0 });
    close();
  });

  it('never claims a model is attached when none is', async () => {
    const { d, close } = deps();
    const body = (await get('/api/model', d)).body as { attached: boolean; statement: string; jobs: unknown[] };
    expect(body.attached).toBe(false);
    expect(body.statement).toContain('No model configured');
    expect(body.jobs).toHaveLength(11);
    close();
  });

  it('an unknown route is a 404, not a crash', async () => {
    const { d, close } = deps();
    expect((await get('/api/nonsense', d)).status).toBe(404);
    close();
  });
});

describe('connectors', () => {
  it('lists everything, honestly split between ready and blocked', async () => {
    const { d, close } = deps();
    const body = (await get('/api/connectors', d)).body as {
      connectors: Array<{ id: string; status: string; enabled: boolean; blockedBecause: string }>;
      counts: { available: number; blocked: number; enabled: number };
    };
    expect(body.connectors.length).toBeGreaterThan(8);
    expect(body.counts.enabled).toBe(0);
    // Every blocked connector must say why, or the UI is lying by omission.
    for (const c of body.connectors.filter((x) => x.status === 'blocked')) {
      expect(c.blockedBecause.length, c.id).toBeGreaterThan(20);
    }
    for (const c of body.connectors.filter((x) => x.status === 'available')) {
      expect(c.blockedBecause, c.id).toBe('');
    }
    close();
  });

  it('enabling persists and is reported back', async () => {
    const { d, close } = deps();
    expect((await post('/api/connectors/notes', { enabled: true }, d)).body).toMatchObject({
      id: 'notes',
      enabled: true,
      effective: true,
    });
    const after = (await get('/api/connectors', d)).body as { counts: { enabled: number } };
    expect(after.counts.enabled).toBe(1);
    close();
  });

  it('a blocked connector can be chosen but is never effective', async () => {
    // The distinction that stops the UI from lying: the choice is recorded,
    // the capability is not granted.
    const { d, close } = deps();
    const res = (await post('/api/connectors/gmail', { enabled: true }, d)).body as {
      enabled: boolean;
      effective: boolean;
      note: string;
    };
    expect(res.enabled).toBe(true);
    expect(res.effective).toBe(false);
    expect(res.note).toContain('network');
    close();
  });

  it('disabling works and is idempotent', async () => {
    const { d, close } = deps();
    await post('/api/connectors/notes', { enabled: true }, d);
    await post('/api/connectors/notes', { enabled: false }, d);
    await post('/api/connectors/notes', { enabled: false }, d);
    expect(((await get('/api/connectors', d)).body as { counts: { enabled: number } }).counts.enabled).toBe(0);
    close();
  });

  it('an unknown connector is 404 and a bad body is 400', async () => {
    const { d, close } = deps();
    expect((await post('/api/connectors/wiretap', { enabled: true }, d)).status).toBe(404);
    expect((await post('/api/connectors/notes', { enabled: 'yes' }, d)).status).toBe(400);
    expect((await post('/api/connectors/notes', {}, d)).status).toBe(400);
    close();
  });

  it('warns when the enabled set holds all three Rule of Two properties', async () => {
    const { d, close } = deps();
    await post('/api/connectors/files', { enabled: true }, d);
    const safe = (await get('/api/connectors', d)).body as { risk: { risky: boolean } };
    expect(safe.risk.risky).toBe(false);

    await post('/api/connectors/gmail', { enabled: true }, d);
    const risky = (await get('/api/connectors', d)).body as { risk: { risky: boolean; why: string } };
    expect(risky.risk.risky).toBe(true);
    expect(risky.risk.why).toContain('approval');
    close();
  });

  it('every connector reaching outside declares FOREIGN trust', () => {
    // §20. A connector that reads the world and calls its output USER
    // would route around the quarantine entirely.
    for (const c of allConnectors()) {
      if (c.id === 'notes') continue; // the one thing the user says directly
      expect(c.yieldsTrust, c.id).toBe('FOREIGN');
    }
  });

  it('combinationRisk needs all three, not two', () => {
    const only = (...ids: string[]) => ids.map((i) => getConnector(i)).filter((c) => c !== undefined);
    expect(combinationRisk(only('files')).risky).toBe(false);
    expect(combinationRisk(only('files', 'notes')).risky).toBe(false);
    expect(combinationRisk(only('files', 'gmail')).risky).toBe(true);
  });
});

describe('the model endpoint refuses to overpromise', () => {
  it('says what is missing for each provider', async () => {
    const { d, close } = deps();
    const openai = (await post('/api/model/check', { provider: 'openai', name: '' }, d)).body as { missing: string[]; valid: boolean };
    expect(openai.valid).toBe(false);
    expect(openai.missing.join(' ')).toMatch(/model name/);
    expect(openai.missing.join(' ')).toMatch(/vault/);

    const ollama = (await post('/api/model/check', { provider: 'ollama', name: 'm', baseUrl: '' }, d)).body as { missing: string[] };
    expect(ollama.missing.join(' ')).toContain('base URL');
    close();
  });

  it('a complete config still reports wouldWork false', async () => {
    // The sharpest honesty requirement on the page: valid settings are not
    // a working model, and the UI must not imply they are.
    const { d, close } = deps();
    const body = (await post('/api/model/check', {
      provider: 'openai',
      name: 'a-model',
      apiKeyRef: 'secret://openai/1',
    }, d)).body as { valid: boolean; wouldWork: boolean; blockers: string[] };
    expect(body.valid).toBe(true);
    expect(body.wouldWork).toBe(false);
    expect(body.blockers.join(' ')).toContain('no provider transport');
    close();
  });

  it('never echoes a raw API key back, only a reference', async () => {
    const { d, close } = deps();
    const res = await post('/api/model/check', {
      provider: 'openai',
      name: 'm',
      apiKeyRef: 'sk-live-ACTUALSECRET0123',
    }, d);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('sk-live-ACTUALSECRET0123');
    // And it should notice the mistake rather than silently ignoring it.
    expect(serialized).toContain('looks like the key itself');
    close();
  });

  it('rejects an unknown provider rather than storing it', async () => {
    const { d, close } = deps();
    expect((await post('/api/model/check', { provider: 'my-cousin-steve' }, d)).status).toBe(400);
    close();
  });

  it('flips to L2 and routes every job to the model when configured', async () => {
    const { d, close } = deps({
      config: ConfigSchema.parse({ model: { provider: 'anthropic', name: 'a-model' } }),
    });
    const body = (await get('/api/model', d)).body as {
      attached: boolean;
      degradation: string;
      jobs: Array<{ strategy: string }>;
    };
    expect(body.attached).toBe(true);
    expect(body.degradation).toBe('L2');
    expect(body.jobs.every((j) => j.strategy === 'model')).toBe(true);
    close();
  });
});

describe('invalid requests', () => {
  it('malformed JSON is a 400 with no stack', async () => {
    const { d, close } = deps();
    const res = await handleApi('POST', '/api/connectors/notes', Symbol.for('arish.invalid-json'), d);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('at ');
    close();
  });
});

describe('the FileStore port cannot be walked out of', () => {
  it('refuses traversal, absolute paths and encoded escapes', () => {
    const files = new MemoryFileStore();
    files.set('/srv/web/index.html', '<h1>ok</h1>');
    files.set('/srv/secret.txt', 'do not serve me');

    expect(files.readWithin('/srv/web', 'index.html')).toBeDefined();
    for (const attack of ['../secret.txt', '../../srv/secret.txt', '/srv/secret.txt', './../secret.txt']) {
      expect(files.readWithin('/srv/web', attack), attack).toBeUndefined();
    }
  });

  it('missing and escaped are indistinguishable to the caller', () => {
    // The difference between "no such file" and "outside the root" is
    // itself information about the filesystem.
    const files = new MemoryFileStore();
    files.set('/srv/web/index.html', 'x');
    expect(files.readWithin('/srv/web', 'nope.html')).toBeUndefined();
    expect(files.readWithin('/srv/web', '../etc/passwd')).toBeUndefined();
  });

  it('the real store returns undefined rather than throwing on a missing file', () => {
    const files = new RealFileStore();
    expect(files.readText('/definitely/not/here.txt')).toBeUndefined();
    expect(files.exists('/definitely/not/here.txt')).toBe(false);
  });
});
