import type { Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { Vault } from '../../security/vault.js';
import type { TrustLevel } from '../../substrate/events/types.js';

/**
 * Stored content the user can ask to have forgotten (§23, invariant 10).
 *
 * The split matters more than anything else here:
 *
 *   - the *event* carries metadata — that an item exists, its label, its
 *     size. It is in the log forever, because the log is append-only and
 *     deleting from it would break the hash chain.
 *   - the *content* never enters the log. It is sealed under the item's
 *     own key and parked in `item_blobs`, which no projector writes and
 *     no rebuild touches.
 *
 * Forgetting therefore destroys the key, not the row. The ciphertext stays
 * where it is as unreadable bytes and the history stays honest: the log
 * still says the item existed and still says it was shredded. A system
 * that could genuinely erase the record of a deletion could also erase the
 * record of anything else.
 */

export type ItemKind = 'note' | 'capture' | 'document' | 'transcript';

export interface Item {
  id: string;
  kind: ItemKind;
  label: string;
  keyId: string;
  bytes: number;
  trust: TrustLevel;
  createdAt: number;
  shreddedAt: number | null;
}

interface ItemRow {
  id: string; kind: string; label: string; key_id: string;
  bytes: number; trust: string; created_at: number; shredded_at: number | null;
}

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  kind: row.kind as ItemKind,
  label: row.label,
  keyId: row.key_id,
  bytes: row.bytes,
  trust: row.trust as TrustLevel,
  createdAt: row.created_at,
  shreddedAt: row.shredded_at,
});

export class ItemError extends Error {
  constructor(readonly kind: 'not_found' | 'shredded' | 'locked', message: string) {
    super(message);
    this.name = 'ItemError';
  }
}

export interface ItemDeps {
  storage: Storage;
  events: EventLog;
  vault: Vault;
  nextId: () => string;
}

export class ItemStore {
  constructor(private readonly deps: ItemDeps) {}

  /**
   * Seal content and record that it exists.
   *
   * The blob is written *before* the event. If the process dies between
   * the two, the result is an orphan blob nobody can name — wasted bytes.
   * The other order loses the content while claiming to have it, which is
   * a lie the user would only discover when they asked for it back.
   */
  async put(
    kind: ItemKind,
    label: string,
    content: string,
    trust: TrustLevel = 'DERIVED',
    actor = 'agent',
  ): Promise<string> {
    const itemId = this.deps.nextId();
    const keyId = `item:${itemId}`;
    const sealed = await this.deps.vault.sealItem(keyId, content);

    this.deps.storage.prepare('INSERT INTO item_blobs (id, sealed) VALUES (?,?)').run(itemId, sealed);
    this.deps.events.append({
      type: 'artifact.created',
      actor,
      trust,
      payload: { itemId, kind, label: label.slice(0, 120), keyId, bytes: sealed.byteLength },
    });
    return itemId;
  }

  async get(itemId: string): Promise<string> {
    const item = this.meta(itemId);
    if (item === undefined) throw new ItemError('not_found', `No item ${itemId}.`);
    if (item.shreddedAt !== null) {
      throw new ItemError('shredded', `Item ${itemId} was forgotten on ${new Date(item.shreddedAt).toISOString()}. Its key is gone.`);
    }
    const row = this.deps.storage.prepare('SELECT sealed FROM item_blobs WHERE id = ?')
      .get<{ sealed: Uint8Array }>(itemId);
    if (row === undefined) throw new ItemError('not_found', `Item ${itemId} has metadata but no content.`);
    return this.deps.vault.openItem(item.keyId, row.sealed);
  }

  /**
   * Forget. Destroys the key; the ciphertext is left deliberately.
   *
   * Idempotent: asking twice is not an error, because the second caller
   * wanted the same end state and got it.
   */
  shred(itemId: string, actor = 'user'): boolean {
    const item = this.meta(itemId);
    if (item === undefined) throw new ItemError('not_found', `No item ${itemId}.`);
    if (item.shreddedAt !== null) return false;
    this.deps.vault.shred(item.keyId);
    this.deps.events.append({
      type: 'artifact.deleted',
      actor,
      trust: 'USER',
      payload: { itemId, how: 'shredded' },
    });
    return true;
  }

  meta(itemId: string): Item | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM items WHERE id = ?').get<ItemRow>(itemId);
    return row === undefined ? undefined : toItem(row);
  }

  list(includeShredded = false): Item[] {
    const sql = includeShredded
      ? 'SELECT * FROM items ORDER BY created_at DESC, id DESC'
      : 'SELECT * FROM items WHERE shredded_at IS NULL ORDER BY created_at DESC, id DESC';
    return this.deps.storage.prepare(sql).all<ItemRow>().map(toItem);
  }

  /** Bytes still held, readable or not. Shredded blobs still occupy disk. */
  bytesHeld(): number {
    return this.deps.storage.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM items').get<{ n: number }>()?.n ?? 0;
  }
}
