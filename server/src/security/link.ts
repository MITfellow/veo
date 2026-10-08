import { open, seal, subkey } from './box.js';

/**
 * An authenticated channel between two paired devices.
 *
 * This file exists because of an invariant, and the invariant was right.
 * The mesh originally called `box.seal` directly from
 * `capability/mesh/wire.ts`, and `containment.test.ts` failed: nothing
 * outside `src/security` may touch the raw-bytes layer. The rule is not
 * bureaucratic — the moment two places in the codebase know how to
 * derive a key and seal a buffer, "how do we encrypt things" has two
 * answers, and one of them will be the wrong one.
 *
 * So the mesh gets a door of its own, next to the vault's. Above it,
 * `wire.ts` is pure framing: parse, validate, sequence. It cannot
 * encrypt anything, which means it cannot encrypt anything badly.
 */

export interface LinkKeys {
  /** Seals what this device sends. */
  out: Uint8Array;
  /** Opens what the other device sends. */
  in: Uint8Array;
}

/**
 * Two keys from one shared secret, assigned by device id order.
 *
 * One key for both directions would mean both devices drawing nonces
 * from the same space — and a nonce collision under AES-GCM loses the
 * key, not just the message. It also makes a frame reflected back at
 * its sender open successfully, which is a protocol attack for free.
 *
 * Ordering by id rather than by role means the two sides agree without
 * negotiating, and without either having to remember who invited whom.
 */
export async function deriveLinkKeys(secret: Uint8Array, selfId: string, peerId: string): Promise<LinkKeys> {
  const low = selfId < peerId;
  const [first, second] = low ? [selfId, peerId] : [peerId, selfId];
  const forward = await subkey(secret, `arish/mesh/v1/${first}->${second}`);
  const reverse = await subkey(secret, `arish/mesh/v1/${second}->${first}`);
  return low ? { out: forward, in: reverse } : { out: reverse, in: forward };
}

/** Seal a message, binding it to `aad` — the frame header. */
export async function sealForPeer(key: Uint8Array, plaintext: string, aad: string): Promise<string> {
  const sealed = await seal(key, new TextEncoder().encode(plaintext), aad);
  return Buffer.from(sealed).toString('base64');
}

export class LinkOpenError extends Error {
  constructor() {
    // One message for a wrong key, a flipped bit and an edited header.
    // Distinguishing them tells an attacker which guess was closer.
    super('That frame did not open: wrong key, or it was altered in flight.');
    this.name = 'LinkOpenError';
  }
}

export async function openFromPeer(key: Uint8Array, sealedBase64: string, aad: string): Promise<string> {
  try {
    const plaintext = await open(key, new Uint8Array(Buffer.from(sealedBase64, 'base64')), aad);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new LinkOpenError();
  }
}
