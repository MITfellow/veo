import type { Storage } from '../../substrate/ports.js';
import type { Vault } from '../../security/vault.js';
import { deriveLinkKeys, decodeSecret, type Invite, type LinkKeys } from './pairing.js';
import { GRANTS, MeshError, type Grant, type PeerRecord } from './types.js';

/**
 * Who this device has paired with, and on what terms.
 *
 * The pairing secret lives in the vault; this table holds a reference,
 * the grants, and the sequence counters. Locking the vault therefore
 * makes every peer link unusable without touching a row, and panic
 * destroys them — the same property connected accounts have (015).
 *
 * Sequence counters are persisted rather than held in memory. A restart
 * that reset them would make every frame the peer ever sent acceptable
 * again, which is a replay window the size of the log.
 */

interface Row {
  id: string; label: string; address: string; grants: string; key_ref: string;
  last_seq_in: number; next_seq_out: number; paired_at: number;
  last_seen_at: number | null; status: string;
}

export interface DirectoryDeps {
  storage: Storage;
  vault: Vault;
  now: () => number;
  selfId: string;
}

export class PeerDirectory {
  /** Derived keys, cached per peer for as long as the vault is open. */
  private readonly keys = new Map<string, LinkKeys>();

  constructor(private readonly deps: DirectoryDeps) {}

  /**
   * Accept an invite and remember the peer.
   *
   * Grants are passed in by the caller — which means by the user, through
   * the interface layer. There is no default grant set and no "pair and
   * decide later": a peer that was added without anyone choosing what it
   * may ask is a peer nobody decided to trust.
   */
  async pair(invite: Invite, grants: readonly Grant[]): Promise<PeerRecord> {
    if (invite.deviceId === this.deps.selfId) {
      throw new MeshError('self', 'That invite is this device\'s own.');
    }
    for (const grant of grants) {
      if (!GRANTS.includes(grant)) throw new MeshError('not_granted', `There is no '${grant}' grant.`);
    }
    // Validates the code before anything is written.
    const secret = decodeSecret(invite.code);
    const ref = await this.deps.vault.put(`mesh.${invite.deviceId}.secret`, Buffer.from(secret).toString('base64'));
    const now = this.deps.now();

    this.deps.storage.prepare(`
      INSERT INTO peers (id, label, address, grants, key_ref, last_seq_in, next_seq_out, paired_at, last_seen_at, status)
      VALUES (?,?,?,?,?,0,1,?,NULL,'active')
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, address = excluded.address, grants = excluded.grants,
        key_ref = excluded.key_ref, status = 'active'
    `).run(invite.deviceId, invite.label, invite.address, grants.join(' '), ref.uri, now);

    this.keys.delete(invite.deviceId);
    return this.require(invite.deviceId);
  }

  list(): PeerRecord[] {
    return this.deps.storage.prepare('SELECT * FROM peers ORDER BY label').all<Row>().map(toRecord);
  }

  get(id: string): PeerRecord | undefined {
    const row = this.deps.storage.prepare('SELECT * FROM peers WHERE id = ?').get<Row>(id);
    return row === undefined ? undefined : toRecord(row);
  }

  require(id: string): PeerRecord {
    const found = this.get(id);
    if (found === undefined) throw new MeshError('unknown_peer', `This device is not paired with ${id}.`);
    if (found.status !== 'active') throw new MeshError('not_paired', `The link to ${found.label} was revoked.`);
    return found;
  }

  /**
   * Revoke a peer.
   *
   * The row stays, so the audit of what it was once allowed to ask
   * survives, and so a re-pair is a visible change rather than a silent
   * reappearance. The secret is left in the vault for the same reason a
   * fact is retracted rather than deleted — except that `forget()` on the
   * vault item is the right follow-up when the user means *erase*.
   */
  revoke(id: string): void {
    this.deps.storage.prepare("UPDATE peers SET status = 'revoked' WHERE id = ?").run(id);
    this.keys.delete(id);
  }

  setGrants(id: string, grants: readonly Grant[]): void {
    this.require(id);
    this.deps.storage.prepare('UPDATE peers SET grants = ? WHERE id = ?').run(grants.join(' '), id);
  }

  /** The directional keys for a peer, derived once and cached. */
  async keysFor(id: string): Promise<LinkKeys> {
    const cached = this.keys.get(id);
    if (cached !== undefined) return cached;

    const peer = this.require(id);
    const secret = await this.deps.vault.resolve(
      peer.keyRef,
      { principal: `peer:${id}`, tool: 'mesh' },
      (value) => new Uint8Array(Buffer.from(value, 'base64')),
    );
    const derived = await deriveLinkKeys(secret, this.deps.selfId, id);
    this.keys.set(id, derived);
    return derived;
  }

  /** Reserve the next outbound sequence number. Never reused. */
  takeSeq(id: string): number {
    const peer = this.require(id);
    this.deps.storage.prepare('UPDATE peers SET next_seq_out = ? WHERE id = ?').run(peer.nextSeqOut + 1, id);
    return peer.nextSeqOut;
  }

  /** Commit an accepted inbound sequence number, monotonically. */
  acceptSeq(id: string, seq: number): void {
    this.deps.storage.prepare(
      'UPDATE peers SET last_seq_in = ?, last_seen_at = ? WHERE id = ? AND last_seq_in < ?',
    ).run(seq, this.deps.now(), id, seq);
  }

  /** Forget the derived keys. Called when the vault locks. */
  forgetKeys(): void {
    this.keys.clear();
  }
}

function toRecord(row: Row): PeerRecord {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    grants: row.grants === '' ? [] : (row.grants.split(' ') as Grant[]),
    keyRef: row.key_ref,
    lastSeqIn: row.last_seq_in,
    nextSeqOut: row.next_seq_out,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    status: row.status === 'active' ? 'active' : 'revoked',
  };
}
