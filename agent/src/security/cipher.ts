import { zeroize } from './crypto.js';
import type { WebCrypto } from './crypto.js';
import type { Keyring } from './keyring.js';

/**
 * Per-item encryption (§13.3).
 *
 * Sensitive columns — memory content, message bodies, artifacts, tool
 * arguments — are encrypted under a key derived from the MDK and the item's
 * own id. Two consequences follow, and both are the point:
 *
 *  - **Shredding one item is possible.** Destroy the ability to derive that
 *    one key (via the tombstone in `shred.ts`) and that one item is gone,
 *    while everything else stays readable.
 *  - **A ciphertext cannot be moved between items.** The item id is
 *    authenticated as AAD, so swapping row A's ciphertext into row B fails to
 *    decrypt rather than silently returning A's content under B's name.
 */
export class ItemCipher {
  constructor(
    private readonly keyring: Keyring,
    private readonly crypto: WebCrypto,
  ) {}

  async encrypt(itemId: string, plaintext: string | Uint8Array): Promise<Uint8Array> {
    const bytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
    const key = await this.keyring.itemKey(itemId);
    try {
      return await this.crypto.encrypt(key, bytes, aad(itemId));
    } finally {
      zeroize(key);
    }
  }

  async decrypt(itemId: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    const key = await this.keyring.itemKey(itemId);
    try {
      return await this.crypto.decrypt(key, ciphertext, aad(itemId));
    } finally {
      zeroize(key);
    }
  }

  async decryptText(itemId: string, ciphertext: Uint8Array): Promise<string> {
    const bytes = await this.decrypt(itemId, ciphertext);
    try {
      return new TextDecoder().decode(bytes);
    } finally {
      zeroize(bytes);
    }
  }
}

function aad(itemId: string): Uint8Array {
  return new TextEncoder().encode(`arish/v1/item/${itemId}`);
}
