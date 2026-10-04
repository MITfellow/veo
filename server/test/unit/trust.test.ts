import { describe, expect, it } from 'vitest';
import { meetTrust, permitted, TRUST_LEVELS, type TrustLevel } from '../../src/substrate/events/types.js';

describe('trust lattice (§20)', () => {
  it('meet always returns the weaker level', () => {
    expect(meetTrust('SYSTEM', 'FOREIGN')).toBe('FOREIGN');
    expect(meetTrust('USER', 'DERIVED')).toBe('DERIVED');
    expect(meetTrust('TOOL', 'TOOL')).toBe('TOOL');
  });

  it('meet is commutative and associative, so causal order cannot change trust', () => {
    for (const a of TRUST_LEVELS) {
      for (const b of TRUST_LEVELS) {
        expect(meetTrust(a, b)).toBe(meetTrust(b, a));
        for (const c of TRUST_LEVELS) {
          expect(meetTrust(meetTrust(a, b), c)).toBe(meetTrust(a, meetTrust(b, c)));
        }
      }
    }
  });

  it('trust is monotonically non-increasing along a chain', () => {
    const chain: TrustLevel[] = ['SYSTEM', 'USER', 'FOREIGN', 'TOOL'];
    let effective: TrustLevel = 'SYSTEM';
    for (const link of chain) effective = meetTrust(effective, link);
    expect(effective).toBe('FOREIGN');
  });

  it('permits only at or above the required level', () => {
    expect(permitted('USER', 'SYSTEM')).toBe(true);
    expect(permitted('USER', 'USER')).toBe(true);
    expect(permitted('USER', 'DERIVED')).toBe(false);
    expect(permitted('FOREIGN', 'FOREIGN')).toBe(true);
  });
});
