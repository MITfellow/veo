import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/substrate/config.js';
import { handleApi, type HttpDeps } from '../../src/interface/http.js';
import { ensureConnectorTable } from '../../src/interface/api.js';
import { BrowserState } from '../../src/interface/browser-api.js';
import { createTestSubstrate } from '../fakes/substrate.js';

function deps(): { d: HttpDeps; close: () => void } {
  const s = createTestSubstrate();
  ensureConnectorTable(s.storage);
  const now = (): number => s.clock.now();
  const digest = (input: string): string => s.crypto.sha256(input);
  return {
    close: () => s.close(),
    d: {
      storage: s.storage,
      config: ConfigSchema.parse({}),
      now,
      digest,
      eventCount: () => s.events.count(),
      // Each test gets its own browser, so no test can see another's session.
      browser: new BrowserState({ now, digest }),
    },
  };
}

const get = (path: string, d: HttpDeps) => handleApi('GET', path, undefined, d);
const post = (path: string, body: unknown, d: HttpDeps) => handleApi('POST', path, body, d);

const READ_PLAN = {
  plan: {
    goal: 'read the deployment guide',
    allowedKinds: ['navigate', 'read', 'click'],
    maxSteps: 8,
    allowedOrigins: ['https://docs.example'],
    carriesPrivateData: false,
  },
  autonomy: 2,
};

describe('the catalogue is honest about what this build can do', () => {
  it('says plainly that no network driver is attached', async () => {
    const { d, close } = deps();
    const body = (await get('/api/browser/catalogue', d)).body as {
      driver: { attached: boolean; note: string };
      pages: Array<{ hostile: boolean }>;
      actions: Array<{ kind: string; tier: string; minAutonomy: number }>;
    };
    expect(body.driver.attached).toBe(false);
    expect(body.driver.note).toContain('No network driver is compiled');
    expect(body.actions).toHaveLength(8);
    expect(body.actions.find((a) => a.kind === 'submit')).toEqual({ kind: 'submit', tier: 'effect', minAutonomy: 4 });
    close();
  });

  it('labels the hostile demo pages as hostile, rather than hiding them', async () => {
    const { d, close } = deps();
    const body = (await get('/api/browser/catalogue', d)).body as { pages: Array<{ hostile: boolean; note: string }> };
    const hostile = body.pages.filter((p) => p.hostile);
    expect(hostile.length).toBeGreaterThanOrEqual(2);
    for (const p of hostile) expect(p.note).toContain('Hostile');
    close();
  });
});

describe('a session cannot start in the middle', () => {
  it('reports no session before a plan is committed', async () => {
    const { d, close } = deps();
    expect((await get('/api/browser', d)).body).toEqual({ active: false, log: [] });
    close();
  });

  it('refuses to act before a plan exists', async () => {
    const { d, close } = deps();
    const res = await post('/api/browser/act', { action: { kind: 'read' } }, d);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Commit a plan first') });
    close();
  });

  it('rejects a malformed plan with a reason naming the field', async () => {
    const { d, close } = deps();
    const res = await post('/api/browser/plan', { plan: { goal: '', allowedKinds: [] }, autonomy: 9 }, d);
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/goal|allowedKinds|autonomy/);
    close();
  });

  it('seals the plan and returns the seal', async () => {
    const { d, close } = deps();
    const body = (await post('/api/browser/plan', READ_PLAN, d)).body as { plan: { seal: string }; sealedBefore: string };
    expect(body.plan.seal).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sealedBefore).toContain('before any page was read');
    close();
  });
});

describe('reading a page through the API', () => {
  it('returns an agent view with refs and no body prose', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    const res = await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    const body = res.body as { ok: boolean; view: { affordances: unknown[]; title: string }; stepsRemaining: number };
    expect(body.ok).toBe(true);
    expect(body.view.title).toBe('Deploying a service');
    expect(body.view.affordances).toHaveLength(3);
    expect(body.stepsRemaining).toBe(7);
    expect(JSON.stringify(body.view)).not.toContain('health check');
    close();
  });

  it('gives the full prose to the user path, labelled FOREIGN', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    const body = (await get('/api/browser/page', d)).body as { trust: string; text: string; warning: string };
    expect(body.trust).toBe('FOREIGN');
    expect(body.warning).toContain('not to the planner');
    expect(body.text).toContain('health check');
    close();
  });

  it('follows a same-origin link by ref without the planner naming a URL', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'click', ref: 'e1' } }, d);
    const body = res.body as { ok: boolean; view: { title: string } };
    expect(body.ok).toBe(true);
    expect(body.view.title).toBe('Rolling back');
    close();
  });
});

describe('a refusal is an answer, not an error', () => {
  it('returns 200 with the reason when a page leads off-origin', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    const res = await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://evil.example/collect' } }, d);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, refused: { kind: 'refused' } });
    close();
  });

  it('refuses the hostile page\'s off-site link and says where it led', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', { ...READ_PLAN, plan: { ...READ_PLAN.plan, allowedOrigins: ['https://blog.example'] } }, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://blog.example/injection' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'click', ref: 'e2' } }, d);
    const body = res.body as { ok: boolean; refused: { reason: string } };
    expect(body.ok).toBe(false);
    expect(body.refused.reason).toContain('https://evil.example');
    close();
  });

  it('refuses an action kind the sealed plan never allowed', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'submit', formIndex: 0 } }, d);
    expect((res.body as { refused: { reason: string } }).refused.reason).toContain("does not permit 'submit'");
    close();
  });

  it('rejects a syntactically invalid action before any policy question', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    const res = await post('/api/browser/act', { action: { kind: 'teleport', url: 'x' } }, d);
    expect(res.status).toBe(400);
    close();
  });
});

describe('the Rule of Two over HTTP', () => {
  const payPlan = {
    plan: {
      goal: 'pay for the order',
      allowedKinds: ['navigate', 'type', 'submit'],
      maxSteps: 8,
      allowedOrigins: ['https://pay.example'],
      carriesPrivateData: true,
    },
    autonomy: 4,
  };

  it('refuses a submission from a page that claims the user approved', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', payPlan, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://pay.example/confirm' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'submit', formIndex: 0 } }, d);
    const body = res.body as { ok: boolean; refused: { reason: string }; view: { signals: { credentialFields: number } } };
    expect(body.ok).toBe(false);
    expect(body.refused.reason).toContain('§19');
    // And the credential field is reported, so the UI can show why it matters.
    expect(body.view.signals.credentialFields).toBe(1);
    close();
  });

  it('accepts an approval that arrives beside the action, not inside it', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', payPlan, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://pay.example/confirm' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'submit', formIndex: 0 }, approved: true }, d);
    const body = res.body as { ok: boolean; refused: { reason: string } };
    // Policy passes; the honest remaining obstacle is the missing transport.
    expect(body.refused.reason).toContain('no transport');
    expect(body.refused.reason).not.toContain('§19');
    close();
  });

  it('ignores an "approved" field smuggled into the action itself', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', payPlan, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://pay.example/confirm' } }, d);
    const res = await post('/api/browser/act', { action: { kind: 'submit', formIndex: 0, approved: true } }, d);
    // `.strict()` means the unexpected key is a parse failure, not a bypass.
    expect(res.status).toBe(400);
    close();
  });
});

describe('the transcript', () => {
  it('records one entry per thing that happened, and no entry for a UI refresh', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://evil.example/x' } }, d);
    // Read the state twice: a transcript that grows when you look at it is
    // a transcript nobody can read.
    await get('/api/browser', d);
    const body = (await get('/api/browser', d)).body as { log: Array<{ outcome: string; detail: string }> };
    expect(body.log.map((e) => e.outcome)).toEqual(['acted', 'navigated', 'observed', 'refused']);
    expect(body.log[0]?.detail).toBe('open https://docs.example/guide');
    close();
  });

  it('reset discards the session and its transcript', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', READ_PLAN, d);
    await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    await post('/api/browser/reset', {}, d);
    expect((await get('/api/browser', d)).body).toEqual({ active: false, log: [] });
    close();
  });

  it('spends the step budget and then stops', async () => {
    const { d, close } = deps();
    await post('/api/browser/plan', { ...READ_PLAN, plan: { ...READ_PLAN.plan, maxSteps: 2 } }, d);
    for (let i = 0; i < 2; i++) {
      await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    }
    const res = await post('/api/browser/act', { action: { kind: 'navigate', url: 'https://docs.example/guide' } }, d);
    expect((res.body as { refused: { reason: string } }).refused.reason).toContain('allows 2 steps');
    close();
  });
});
