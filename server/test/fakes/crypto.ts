import { createHash } from 'node:crypto';
import type { CryptoPort } from '../../src/substrate/ports.js';

/**
 * Real SHA-256, counter-based "randomness".
 *
 * Hashing must stay real or the chain tests prove nothing. Randomness must be
 * fake or no two runs produce the same ULIDs, and §16 compares bytes.
 */
export class FakeCrypto implements CryptoPort {
  private counter = 0;

  constructor(private readonly seed = 1) {}

  sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      // A simple LCG: reproducible, not uniform, and never used for security.
      this.counter = (this.counter * 1103515245 + 12345 + this.seed) % 2147483648;
      out[i] = (this.counter >> 16) & 0xff;
    }
    return out;
  }

  reset(): void { this.counter = 0; }
}
