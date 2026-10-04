import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { CryptoPort } from './ports.js';

/**
 * Hashing is deterministic and therefore safe to call anywhere; it lives
 * behind a port anyway so that `randomBytes` — which is not — has somewhere
 * to live that a test can replace wholesale.
 */
export function nodeCrypto(): CryptoPort {
  return {
    sha256: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
  };
}
