/**
 * Tests 31–42 and 50–54: portability, backups, the vault routes, SSE
 * resume (§29, §13.5, §34).
 *
 * The thing being protected here is the user's right to leave. An agent
 * that holds a decade of someone's life and cannot hand it back is not a
 * personal agent, it is a hostage situation — so the export is tested
 * the only way that means anything: by importing it into a different
 * database and comparing what comes out.
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start, type StartedAgent } from '../../src/main.js';
import { createSubstrate } from '../../src/substrate/index.js';
import { importAll, EXPORT_FORMAT, type ExportDocument } from '../../src/portability/export.js';
import { verifyBackup } from '../../src/portability/backup.js';

let app: StartedAgent;
let dir: string;
let base: string;
let dbPath: string;

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${app.token}`,
  'content-type': 'application/json',
});

const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: auth(),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arish-port-'));
  dbPath = join(dir, 'live.db');
  app = await start({ port: 0, dbPath, token: 'port-token' });
  base = `http://127.0.0.1:${app.port}`;

  // Give the agent something worth exporting: a session with a real turn,
  // a persona, and a schedule.
  const session = (await call<{ id: string }>('/sessions', {
    method: 'POST',
    body: { title: 'Portable' },
  })).body;
  await call(`/sessions/${session.id}/messages`, {
    method: 'POST',
    body: { text: 'My name is Ara and I live in Lisbon' },
  });
  await new Promise((r) => setTimeout(r, 1500));
  await call('/persona', {
    method: 'PUT',
    body: {
      agentName: 'Ada',
      addressUser: 'Ara',
      formality: 'plain',
      length: 'brief',
      emoji: false,
      language: 'match',
      notes: '',
    },
  });
  await call('/schedules', {
    method: 'POST',
    body: { name: 'Briefing', spec: '0 9 * * 1-5', prompt: 'What is on today?' },
  });
}, 40_000);

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('export and import', () => {
  it('31 + 36. a round trip into an empty database reproduces the agent', async () => {
    const { status, body: doc } = await call<ExportDocument>('/export', { method: 'POST' });
    expect(status).toBe(200);
    expect(doc.format).toBe(EXPORT_FORMAT);
    expect(doc.eventCount).toBeGreaterThan(10);

    const intoDir = mkdtempSync(join(tmpdir(), 'arish-into-'));
    const into = createSubstrate({ dbPath: join(intoDir, 'into.db') });
    const outcome = importAll(into, doc);

    expect(outcome.ok).toBe(true);
    expect(outcome.imported).toBe(doc.eventCount);
    // The whole claim in one line: same events in, same projections out.
    expect(outcome.projectionDigest).toBe(doc.projectionDigest);

    // Per store, not by file size — a byte count proves nothing about
    // whether the person's memory survived.
    const facts = into.storage.get<{ n: number }>(`SELECT COUNT(*) AS n FROM facts`)!;
    const sessions = into.storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!;
    const schedules = into.storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM schedules')!;
    const persona = into.storage.get<{ agent_name: string }>('SELECT * FROM personas')!;
    const articles = into.storage.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM constitution_articles',
    )!;

    expect(facts.n).toBeGreaterThan(0);
    expect(sessions.n).toBeGreaterThan(0);
    expect(schedules.n).toBe(1);
    expect(persona.agent_name).toBe('Ada');
    expect(articles.n).toBeGreaterThanOrEqual(15);

    into.close();
    rmSync(intoDir, { recursive: true, force: true });
  });

  it('32. the export carries no secret plaintext', async () => {
    // Put a real secret in the vault first, then look for its value
    // anywhere in the serialized export. §13 has no portability exception.
    const SECRET = 'sk-live-do-not-leak-7f3a9c';
    const unlocked = await call<{ state: string }>('/vault/unlock', {
      method: 'POST',
      body: { passphrase: 'correct horse battery staple' },
    });
    expect([200, 201]).toContain(unlocked.status);
    const created = await call<{ ref: string }>('/vault/secrets', {
      method: 'POST',
      body: { name: 'test-key', value: SECRET },
    });
    expect(created.status).toBe(201);

    const { body: doc } = await call<ExportDocument>('/export', { method: 'POST' });
    const serialized = JSON.stringify(doc);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('correct horse battery staple');
    // The ciphertext *is* there — that is the point: the secret travels,
    // sealed, and is useless without the passphrase.
    expect(doc.vault.secrets.length).toBeGreaterThan(0);
    expect(doc.vault.keyring).not.toBeNull();
  });

  it('33. importing into a non-empty agent is refused, with the reason', async () => {
    const { body: doc } = await call<ExportDocument>('/export', { method: 'POST' });
    const { status, body } = await call<{ ok: boolean; reason: string }>('/import', {
      method: 'POST',
      body: doc,
    });
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    // Not a merge. Reconciling two hash chains is a different feature.
    expect(body.reason).toContain('import only into an empty one');
  });

  it('34 + 37. a tampered export fails the chain check and writes nothing', async () => {
    const { body: doc } = await call<ExportDocument>('/export', { method: 'POST' });

    // One byte of one payload, in the middle of the chain.
    const victim = doc.events[Math.floor(doc.events.length / 2)]!;
    const tampered: ExportDocument = {
      ...doc,
      events: doc.events.map((e) =>
        e.seq === victim.seq ? { ...e, payload: { ...(e.payload as object), tampered: true } } : e,
      ),
    };

    const intoDir = mkdtempSync(join(tmpdir(), 'arish-tamper-'));
    const into = createSubstrate({ dbPath: join(intoDir, 'bad.db') });
    const outcome = importAll(into, tampered);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('hash chain');
    // Atomic: a failed import leaves an empty database, not half a person.
    expect(into.events.count()).toBe(0);
    expect(into.storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n).toBe(0);

    into.close();
    rmSync(intoDir, { recursive: true, force: true });
  });

  it('35. an unknown format is refused rather than guessed at', () => {
    const intoDir = mkdtempSync(join(tmpdir(), 'arish-fmt-'));
    const into = createSubstrate({ dbPath: join(intoDir, 'f.db') });
    const outcome = importAll(into, {
      format: 'arish-export-99',
      events: [],
    } as unknown as ExportDocument);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('unknown export format');
    into.close();
    rmSync(intoDir, { recursive: true, force: true });
  });
});

describe('backup verification (§13.5)', () => {
  it('38–39 + 42. a healthy database verifies, while the agent is running', async () => {
    const { status, body } = await call<{
      ok: boolean;
      events: number;
      chain: { ok: boolean };
      projections: { digestMatches: boolean; rebuilt: boolean };
      contents: { facts: number; sessions: number; schedules: number; constitutionVersion: number };
      notes: string[];
    }>('/backup/verify', { method: 'POST' });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.chain.ok).toBe(true);
    // Rebuilt from the events alone and compared — not "the file opened".
    expect(body.projections.rebuilt).toBe(true);
    expect(body.projections.digestMatches).toBe(true);
    // And something real was read back out: a database can pass every
    // integrity check and still be empty.
    expect(body.contents.sessions).toBeGreaterThan(0);
    expect(body.contents.constitutionVersion).toBeGreaterThan(0);
    expect(body.notes.join(' ')).toContain('byte-identically');
  }, 30_000);

  it('41. verification never touches the live database', async () => {
    const before = readFileSync(dbPath);
    const digestBefore = await call<{ projections: { liveDigest: string } }>('/backup/verify', {
      method: 'POST',
    });
    const after = readFileSync(dbPath);
    expect(after.length).toBe(before.length);
    const digestAfter = await call<{ projections: { liveDigest: string } }>('/backup/verify', {
      method: 'POST',
    });
    expect(digestAfter.body.projections.liveDigest).toBe(digestBefore.body.projections.liveDigest);
  }, 30_000);

  it('40. a corrupted copy is reported as corrupt, not as healthy', () => {
    // Build a small agent, break one event's payload *in the file*, and
    // verify. The chain check must notice.
    const brokenDir = mkdtempSync(join(tmpdir(), 'arish-broken-'));
    const path = join(brokenDir, 'broken.db');
    const substrate = createSubstrate({ dbPath: path });
    substrate.events.append({
      type: 'session.created',
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'ses-x',
      payload: { title: 'before' },
    });
    substrate.events.append({
      type: 'session.titled',
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'ses-x',
      payload: { title: 'after' },
    });

    // The log refuses UPDATE outright (a trigger enforces append-only), so
    // corruption has to arrive the way it would in the wild: a row that
    // was never appended through the log, with a hash that does not follow
    // from the one before it. This is also what a truncated or
    // partially-restored backup looks like.
    substrate.storage.run(
      `INSERT INTO events (seq, id, ts, principal, session_id, run_id, step_id,
         correlation_id, causation_id, trust, type, schema_version, payload, hash, prev_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        99,
        '01SMUGGLED',
        Date.now(),
        'user:ara',
        'ses-x',
        null,
        null,
        '01SMUGGLED',
        null,
        'USER',
        'session.titled',
        1,
        JSON.stringify({ title: 'smuggled' }),
        'deadbeef'.repeat(8),
        'a'.repeat(64), // a well-formed hash that is simply not the previous one
      ],
    );

    const report = verifyBackup({ live: substrate, dbPath: path, now: Date.now() });
    expect(report.ok).toBe(false);
    expect(report.chain.ok).toBe(false);
    expect(report.chain.problems.length).toBeGreaterThan(0);
    expect(report.notes.join(' ')).toContain('should NOT be relied on');

    substrate.close();
    rmSync(brokenDir, { recursive: true, force: true });
  });
});

describe('the vault over HTTP', () => {
  it('50. list returns names and metadata, never values', async () => {
    const { status, body } = await call<{
      state: string;
      secrets: Array<Record<string, unknown>>;
    }>('/vault/secrets');
    expect(status).toBe(200);
    expect(body.state).toBe('unlocked');
    expect(body.secrets.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sk-live-do-not-leak');
    expect(Object.keys(body.secrets[0]!)).not.toContain('value');
    expect(Object.keys(body.secrets[0]!)).not.toContain('ciphertext');
  });

  it('51. a locked vault is 423 — "unlock and retry", not "something broke"', async () => {
    await call('/vault/lock', { method: 'POST' });
    const { status, body } = await call<{ error: string; detail: string }>('/vault/secrets', {
      method: 'POST',
      body: { name: 'another', value: 'x' },
    });
    expect(status).toBe(423);
    expect(body.error).toBe('locked');
    expect(body.detail).toContain('unlock');

    await call('/vault/unlock', {
      method: 'POST',
      body: { passphrase: 'correct horse battery staple' },
    });
    expect((await call<{ state: string }>('/vault/secrets')).body.state).toBe('unlocked');
  }, 20_000);

  it('52. panic needs the words typed out, and says what it destroys', async () => {
    const refused = await call<{ error: string; detail: string }>('/vault/panic', {
      method: 'POST',
      body: { confirm: 'yes' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('confirmation_required');
    // The warning names the irreversible part: backups too.
    expect(refused.body.detail).toContain('every backup that already exists');
  });
});

describe('the spec\'s own endpoint list', () => {
  it('54. every route §29 names either exists or is explained', async () => {
    // Walks §29's list. A 404 here means the route is not mounted; a 401
    // would mean it is mounted and refusing anonymous callers, which is
    // also fine. What must never happen is a route silently missing while
    // the progress note claims otherwise.
    const spec: Array<[string, string]> = [
      ['GET', '/sessions'],
      ['GET', '/memory'],
      ['GET', '/memory/identity-card'],
      ['GET', '/memory/digest'],
      ['GET', '/persona'],
      ['GET', '/constitution'],
      ['GET', '/vault/secrets'],
      ['GET', '/events'],
      ['GET', '/health'],
      ['GET', '/metrics'],
      ['GET', '/degradation'],
      ['GET', '/approvals'],
      ['GET', '/calibration'],
      ['GET', '/schedules'],
      ['GET', '/jobs'],
    ];

    const missing: string[] = [];
    for (const [method, path] of spec) {
      const response = await fetch(`${base}${path}`, { method, headers: auth() });
      if (response.status === 404) missing.push(`${method} ${path}`);
      await response.text();
    }
    expect(missing).toEqual([]);
  });

  it('53. SSE resumes from Last-Event-ID without losing or duplicating a frame', async () => {
    const session = (await call<{ id: string }>('/sessions', { method: 'POST', body: {} })).body;
    const started = (
      await call<{ runId: string }>(`/sessions/${session.id}/messages`, {
        method: 'POST',
        body: { text: 'hello there' },
      })
    ).body;

    await new Promise((r) => setTimeout(r, 1200));

    const read = async (lastEventId?: string): Promise<string[]> => {
      const response = await fetch(`${base}/runs/${started.runId}/stream`, {
        headers: {
          authorization: `Bearer ${app.token}`,
          ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
        },
      });
      const text = await response.text();
      return text.split('\n').filter((line) => line.startsWith('id: '));
    };

    const full = await read();
    expect(full.length).toBeGreaterThan(2);

    // Reconnect as a sleeping laptop would: "I last saw this id."
    const cut = full[Math.floor(full.length / 2)]!.slice(4);
    const resumed = await read(cut);

    // Nothing before the cut is replayed, nothing after it is lost.
    const ids = (lines: string[]) => lines.map((l) => Number(l.slice(4)));
    expect(ids(resumed).every((id) => id > Number(cut))).toBe(true);
    expect(ids(resumed)).toEqual(ids(full).filter((id) => id > Number(cut)));
  }, 30_000);
});
