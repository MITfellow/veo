import { DecryptionError } from './crypto.js';
import type { ItemCipher } from './cipher.js';
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Storage } from '../substrate/ports.js';

/**
 * Crypto-shredding (§13.3, invariant 8).
 *
 * Deleting a row is not deletion. The row is in last night's backup, and in
 * the one before that. The only deletion that survives contact with reality is
 * destroying the ability to read the ciphertext.
 *
 * Per-item keys here are *derived* from the MDK rather than stored (D-011),
 * which means there is no key row to delete. So the shred is recorded as a
 * **tombstone**: an explicit, append-only statement that this item id must
 * never be decrypted again. `ItemCipher` operations go through
 * `assertNotShredded` first, and the ciphertext column is additionally
 * overwritten so the local copy is gone too.
 *
 * Honest about the trade (D-011): a tombstone is an access-control decision
 * enforced by this code, whereas deleting a stored key is enforced by
 * mathematics. The mitigation is that the *ciphertext* is also destroyed in
 * the live database, so recovering the content requires both an old backup
 * **and** the MDK — and if the user panics the keyring, not even that works.
 */

export interface Tombstone {
  itemId: string;
  shreddedAt: number;
  reason: string;
  eventId: string;
}

interface TombstoneRow {
  item_id: string;
  shredded_at: number;
  reason: string;
  event_id: string;
}

export class Shredder {
  constructor(
    private readonly storage: Storage,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  /**
   * Shred one item. Idempotent: shredding twice is not an error, because the
   * caller recovering from a crash must be able to retry safely.
   */
  shred(
    itemId: string,
    options: {
      principal: string;
      reason: string;
      /** `table.column` pairs whose ciphertext should also be overwritten. */
      ciphertextLocations?: Array<{ table: string; column: string; idColumn: string; id: string }>;
      factId?: string;
    },
  ): Tombstone {
    const existing = this.tombstone(itemId);
    if (existing) return existing;

    return this.storage.transaction(() => {
      const now = this.clock.now();

      for (const loc of options.ciphertextLocations ?? []) {
        this.storage.run(
          `UPDATE ${loc.table} SET ${loc.column} = ? WHERE ${loc.idColumn} = ?`,
          [new Uint8Array(0), loc.id],
        );
      }

      const event = this.events.append({
        type: 'memory.forgotten',
        payload: {
          factId: options.factId ?? itemId,
          keyId: itemId,
          reason: options.reason,
          shredded: true,
        },
        principal: options.principal,
        trust: 'USER',
      });

      this.storage.run(
        `INSERT INTO shred_tombstones (item_id, shredded_at, reason, event_id)
         VALUES (?,?,?,?) ON CONFLICT(item_id) DO NOTHING`,
        [itemId, now, options.reason, event.id],
      );

      return { itemId, shreddedAt: now, reason: options.reason, eventId: event.id };
    });
  }

  tombstone(itemId: string): Tombstone | undefined {
    const row = this.storage.get<TombstoneRow>(
      'SELECT * FROM shred_tombstones WHERE item_id = ?',
      [itemId],
    );
    return row
      ? { itemId: row.item_id, shreddedAt: row.shredded_at, reason: row.reason, eventId: row.event_id }
      : undefined;
  }

  isShredded(itemId: string): boolean {
    return this.tombstone(itemId) !== undefined;
  }

  list(): Tombstone[] {
    return this.storage
      .all<TombstoneRow>('SELECT * FROM shred_tombstones ORDER BY shredded_at')
      .map((r) => ({
        itemId: r.item_id,
        shreddedAt: r.shredded_at,
        reason: r.reason,
        eventId: r.event_id,
      }));
  }
}

/**
 * A cipher that refuses shredded items. Wrapping rather than modifying
 * `ItemCipher` keeps the shred policy in one place and makes it impossible to
 * use the raw cipher by accident in kernel code — the exported binding from
 * `security/index.ts` is this one.
 */
export class ShreddingCipher {
  constructor(
    private readonly cipher: ItemCipher,
    private readonly shredder: Shredder,
  ) {}

  async encrypt(itemId: string, plaintext: string | Uint8Array): Promise<Uint8Array> {
    this.assertNotShredded(itemId);
    return this.cipher.encrypt(itemId, plaintext);
  }

  async decrypt(itemId: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    this.assertNotShredded(itemId);
    return this.cipher.decrypt(itemId, ciphertext);
  }

  async decryptText(itemId: string, ciphertext: Uint8Array): Promise<string> {
    this.assertNotShredded(itemId);
    return this.cipher.decryptText(itemId, ciphertext);
  }

  private assertNotShredded(itemId: string): void {
    const tombstone = this.shredder.tombstone(itemId);
    if (tombstone) {
      // Same error type as a cryptographic failure: a caller must not be able
      // to distinguish "forgotten" from "unreadable" and treat them
      // differently. Forgetting is honored everywhere, uniformly (invariant 8).
      throw new DecryptionError();
    }
  }
}
