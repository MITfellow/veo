import { beforeEach, describe, expect, it } from 'vitest';
import { clearState, loadState, saveState, saveToLocal, STORAGE_KEY } from './persist';
import { idbGet, resetDbForTests } from './db';
import { buildDemoStore } from '../test/demo-world';

beforeEach(async () => {
  localStorage.clear();
  resetDbForTests();
  await clearState();
});

describe('persistence', () => {
  it('starts a fresh install empty, with the contact directory intact', async () => {
    const s = await loadState();
    // No invented history of any kind. The one chat present is the agent's
    // own, and it is empty too: the agent is the product, not seed content.
    expect(s.messages).toEqual([]);
    expect(s.chats.map((c) => c.id)).toEqual(['c-agent']);
    expect(s.contacts['agent'].agent).toBe(true);
    expect(s.activeChatId).toBeNull();
    expect(Object.keys(s.contacts).length).toBeGreaterThan(1);
  });

  it('round-trips a store', async () => {
    const seed = buildDemoStore();
    seed.chats[0].draft = 'hello there';
    expect((await saveState(seed)).ok).toBe(true);
    expect((await loadState()).chats[0].draft).toBe('hello there');
  });

  it('never restores a stuck typing indicator', async () => {
    const seed = buildDemoStore();
    seed.chats[0].typing = true;
    await saveState(seed);
    expect((await loadState()).chats[0].typing).toBe(false);
  });

  it('resolves messages left mid-send', async () => {
    const seed = buildDemoStore();
    seed.messages[0].status = 'sending';
    await saveState(seed);
    expect((await loadState()).messages[0].status).toBe('sent');
  });

  it('survives corrupt storage', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const s = await loadState();
    expect(s.messages).toEqual([]);
    expect(s.chats.map((c) => c.id)).toEqual(['c-agent']);
  });

  it('clears everything', async () => {
    await saveState(buildDemoStore());
    await clearState();
    const cleared = await loadState();
    expect(cleared.messages).toEqual([]);
    expect(cleared.chats.map((c) => c.id)).toEqual(['c-agent']);
  });
});

describe('IndexedDB is the home of record', () => {
  it('writes to the database, not localStorage', async () => {
    await saveState(buildDemoStore());
    expect(await idbGet(STATE_KEY_FOR_TEST)).toBeTruthy();
    // the legacy copy is cleared so it cannot shadow the database
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('migrates a localStorage account into the database on first load', async () => {
    const legacy = buildDemoStore();
    legacy.chats[0].draft = 'written before the migration';
    saveToLocal(legacy, Date.now());
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();

    const loaded = await loadState();
    expect(loaded.chats[0].draft).toBe('written before the migration');

    // and it is now in the database, so the next load does not need the copy
    await new Promise((r) => setTimeout(r, 10));
    const env = (await idbGet(STATE_KEY_FOR_TEST)) as { state: { chats: { draft: string }[] } };
    expect(env.state.chats[0].draft).toBe('written before the migration');
  });

  it('prefers whichever copy is newer', async () => {
    const older = buildDemoStore();
    older.chats[0].draft = 'older, in the database';
    await saveState(older);

    const newer = buildDemoStore();
    newer.chats[0].draft = 'newer, in localStorage';
    saveToLocal(newer, Date.now() + 5_000);

    expect((await loadState()).chats[0].draft).toBe('newer, in localStorage');
  });

  it('keeps the database copy when it is the newer one', async () => {
    const stale = buildDemoStore();
    stale.chats[0].draft = 'stale localStorage';
    saveToLocal(stale, Date.now() - 60_000);

    const fresh = buildDemoStore();
    fresh.chats[0].draft = 'fresh database';
    await saveState(fresh);

    expect((await loadState()).chats[0].draft).toBe('fresh database');
  });

  it('stores a payload far beyond the localStorage ceiling', async () => {
    const big = buildDemoStore();
    // ~12MB of attachment data: localStorage would throw well before this
    const blob = 'data:image/png;base64,' + 'A'.repeat(1_500_000);
    for (let i = 0; i < 8; i++) {
      big.messages.push({
        ...big.messages[0],
        id: `big-${i}`,
        attachments: [{ id: `a-${i}`, kind: 'image', src: blob }],
      });
    }
    const res = await saveState(big);
    expect(res.ok).toBe(true);

    const back = await loadState();
    const kept = back.messages.filter((m) => m.id.startsWith('big-'));
    expect(kept).toHaveLength(8);
    // every photo survived — nothing was "freed to save space"
    for (const m of kept) expect(m.attachments[0].src).toHaveLength(blob.length);
  });
});

describe('concurrent writes', () => {
  it('leaves the newest snapshot on disk when saves overlap', async () => {
    const first = buildDemoStore();
    first.chats[0].draft = 'first';
    const second = buildDemoStore();
    second.chats[0].draft = 'second';

    // both in flight at once: the older must never land on top of the newer
    const a = saveState(first);
    const b = saveState(second);
    await Promise.all([a, b]);

    expect((await loadState()).chats[0].draft).toBe('second');
  });

  it('does not let the migration write clobber a later save', async () => {
    const legacy = buildDemoStore();
    legacy.chats[0].draft = 'legacy';
    saveToLocal(legacy, Date.now());

    // loadState migrates in the background while the app saves new work
    const loading = loadState();
    const fresh = buildDemoStore();
    fresh.chats[0].draft = 'sent after boot';
    await loading;
    await saveState(fresh);
    await new Promise((r) => setTimeout(r, 20));

    expect((await loadState()).chats[0].draft).toBe('sent after boot');
  });
});

const STATE_KEY_FOR_TEST = 'state';

describe('the rename from Messages to Veo', () => {
  /** Writes an envelope into the pre-rename database, by hand. */
  const seedLegacyDb = (state: unknown, savedAt: number) =>
    new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('messages', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('app');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('app', 'readwrite');
        tx.objectStore('app').put({ version: 3, savedAt, state }, 'state');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

  it('carries an account over from the old database name', async () => {
    const old = buildDemoStore();
    old.chats[0].draft = 'written back when it was called Messages';
    await seedLegacyDb(old, Date.now());

    const loaded = await loadState();
    expect(loaded.chats[0].draft).toBe('written back when it was called Messages');

    // and it is rewritten under the new name, so the old one can go
    await new Promise((r) => setTimeout(r, 20));
    const env = (await idbGet('state')) as { state: { chats: { draft: string }[] } };
    expect(env.state.chats[0].draft).toBe('written back when it was called Messages');
  });

  it('still reads an account left under the old localStorage key', async () => {
    const old = buildDemoStore();
    old.chats[0].draft = 'older still';
    localStorage.setItem(
      'messages.app.state',
      JSON.stringify({ version: 3, savedAt: Date.now(), state: old }),
    );

    const loaded = await loadState();
    expect(loaded.chats[0].draft).toBe('older still');
  });

  it('does not invent an empty legacy database on a fresh install', async () => {
    const loaded = await loadState();
    expect(loaded.messages).toEqual([]);

    // fake-indexeddb exposes databases(); nothing should have been created
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain('messages');
  });
});
