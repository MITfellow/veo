import { describe, expect, it } from 'vitest';
import { createItemHarness } from '../fakes/memory.js';
import { ItemError } from '../../src/capability/memory/items.js';
import { must } from '../fakes/must.js';

/**
 * M2 §6 — forgetting has to be real (§23, invariant 10).
 *
 * The claim under test is uncomfortable and precise: after `forget`, the
 * bytes are still on disk and the content is nonetheless unrecoverable,
 * because the key is gone. A test that only checked "the row disappeared"
 * would pass against a system that merely hid it.
 */

const SECRET = 'The spare key is under the third plant pot on the left.';

describe('ItemStore', () => {
  it('seals content and returns it', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'where the key is', SECRET, 'USER');
    expect(await h.items.get(id)).toBe(SECRET);
    h.close();
  });

  it('never puts the plaintext in the event log', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'where the key is', SECRET, 'USER');

    const log = JSON.stringify(h.s.events.read());
    expect(log).not.toContain('plant pot');
    expect(log).not.toContain(SECRET);
    // The metadata is there, which is the point: the log says an item
    // exists without saying what it says.
    expect(log).toContain('where the key is');
    expect(must(h.items.meta(id), 'metadata').bytes).toBeGreaterThan(SECRET.length);
    h.close();
  });

  it('never puts the plaintext in the structured log', async () => {
    const h = await createItemHarness();
    await h.items.put('note', 'where the key is', SECRET, 'USER');
    expect(JSON.stringify(h.s.fakeLog.lines)).not.toContain('plant pot');
    h.close();
  });

  it('destroys the key and leaves the ciphertext', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'where the key is', SECRET, 'USER');
    const keyId = must(h.items.meta(id), 'metadata').keyId;

    expect(h.items.shred(id)).toBe(true);

    // The key is gone.
    expect(
      h.s.storage.prepare('SELECT COUNT(*) AS n FROM item_keys WHERE key_id = ?').get<{ n: number }>(keyId)?.n,
    ).toBe(0);
    // The ciphertext is not, deliberately — and it is unreadable.
    const blob = h.s.storage.prepare('SELECT sealed FROM item_blobs WHERE id = ?').get<{ sealed: Uint8Array }>(id);
    expect(must(blob, 'blob').sealed.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(must(blob, 'blob').sealed).toString('utf8')).not.toContain('plant pot');
    h.close();
  });

  it('keeps the tombstone auditable after forgetting', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'where the key is', SECRET, 'USER');
    h.items.shred(id);

    const meta = must(h.items.meta(id), 'metadata');
    expect(meta.shreddedAt).not.toBeNull();
    expect(h.s.events.read().map((e) => e.type)).toContain('artifact.deleted');
    h.close();
  });

  it('refuses to read a forgotten item, and says why', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'n', SECRET, 'USER');
    h.items.shred(id);
    try {
      await h.items.get(id);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ItemError);
      expect((error as ItemError).kind).toBe('shredded');
      expect((error as Error).message).toMatch(/was forgotten on/);
    }
    h.close();
  });

  it('is idempotent — asking twice is a user action, not an error', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'n', SECRET, 'USER');
    expect(h.items.shred(id)).toBe(true);
    expect(h.items.shred(id)).toBe(false);
    expect(h.s.events.read({ types: ['artifact.deleted'] })).toHaveLength(1);
    h.close();
  });

  it('hides a forgotten item from the default listing and keeps it in the full one', async () => {
    const h = await createItemHarness();
    const keep = await h.items.put('note', 'keep', 'a', 'USER');
    const drop = await h.items.put('note', 'drop', 'b', 'USER');
    h.items.shred(drop);
    expect(h.items.list().map((i) => i.id)).toEqual([keep]);
    expect(h.items.list(true)).toHaveLength(2);
    h.close();
  });

  it('refuses to read item content while the vault is locked', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'n', SECRET, 'USER');
    h.vault.lock();
    await expect(h.items.get(id)).rejects.toThrow(/locked/i);
    // Metadata is not secret, so listing still works. Saying "no items"
    // while locked would be a lie about what exists.
    expect(h.items.list()).toHaveLength(1);
    h.close();
  });

  it('survives a rebuild without losing the ciphertext', async () => {
    const h = await createItemHarness();
    const id = await h.items.put('note', 'n', SECRET, 'USER');
    h.s.events.rebuild();
    // item_blobs is not a projection; rebuild must not touch it.
    expect(await h.items.get(id)).toBe(SECRET);
    expect(must(h.items.meta(id), 'metadata').label).toBe('n');
    h.close();
  });

  it('refuses an unknown item', async () => {
    const h = await createItemHarness();
    await expect(h.items.get('nope')).rejects.toThrow(/No item/);
    expect(() => h.items.shred('nope')).toThrow(/No item/);
    h.close();
  });
});
