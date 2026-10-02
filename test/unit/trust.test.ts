import { describe, expect, it } from 'vitest';
import {
  type Capability,
  capabilitiesFor,
  checkCapabilities,
  combineTrust,
  effectiveTrust,
  permits,
} from '../../src/security/trust.js';
import { TRUST_LEVELS, type TrustLevel } from '../../src/substrate/events/types.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

describe('effective trust over a causal closure', () => {
  it('takes the minimum along the chain', () => {
    const s = createTestSubstrate();
    const sys = s.events.append({
      type: 'message.system',
      payload: { text: 'kernel instructions' },
      principal: 'system',
      trust: 'SYSTEM',
      sessionId: 'sess-1',
    });
    const user = s.events.append({
      type: 'message.user',
      payload: { text: 'summarise this page', attachments: [] },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
      causationId: sys.id,
    });
    const page = s.events.append({
      type: 'tool.succeeded',
      payload: { tool: 'http', durationMs: 10, resultTrust: 'FOREIGN', artifacts: [] },
      principal: 'tool:http',
      trust: 'FOREIGN',
      sessionId: 'sess-1',
      causationId: user.id,
    });
    // The model's own output claims DERIVED. It does not get to.
    const derived = s.events.append({
      type: 'step.started',
      payload: { index: 1, effectiveTrust: 'DERIVED' },
      principal: 'system',
      trust: 'DERIVED',
      sessionId: 'sess-1',
      causationId: page.id,
    });

    const result = effectiveTrust(s.events, derived.id);
    expect(result.level).toBe('FOREIGN');
    expect(result.closureSize).toBe(4);
    expect(result.limitedBy?.eventId).toBe(page.id);
    expect(result.limitedBy?.type).toBe('tool.succeeded');
    s.close();
  });

  it('leaves a clean USER chain at USER', () => {
    const s = createTestSubstrate();
    const a = s.events.append({
      type: 'message.user',
      payload: { text: 'hello', attachments: [] },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });
    const b = s.events.append({
      type: 'step.started',
      payload: { index: 0, effectiveTrust: 'USER' },
      principal: 'system',
      trust: 'SYSTEM',
      sessionId: 'sess-1',
      causationId: a.id,
    });
    expect(effectiveTrust(s.events, b.id).level).toBe('USER');
    s.close();
  });

  it('treats an unknown event as untrusted rather than trusted', () => {
    const s = createTestSubstrate();
    const result = effectiveTrust(s.events, 'NOTAREALEVENTID0000000000');
    expect(result.level).toBe('FOREIGN');
    expect(result.closureSize).toBe(0);
    s.close();
  });

  it('combines several inputs by taking the minimum', () => {
    expect(combineTrust('SYSTEM', 'USER', 'TOOL')).toBe('TOOL');
    expect(combineTrust('USER', 'USER')).toBe('USER');
  });
});

describe('capability ceilings', () => {
  it('shrink monotonically as trust drops', () => {
    const sizes = TRUST_LEVELS.map((t) => capabilitiesFor(t).size);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!, `${TRUST_LEVELS[i]} should not exceed ${TRUST_LEVELS[i - 1]}`).toBeLessThanOrEqual(
        sizes[i - 1]!,
      );
    }
  });

  it('are nested: anything FOREIGN may do, every higher level may do', () => {
    for (let i = TRUST_LEVELS.length - 1; i > 0; i--) {
      const lower = capabilitiesFor(TRUST_LEVELS[i]!);
      const higher = capabilitiesFor(TRUST_LEVELS[i - 1]!);
      for (const cap of lower) {
        expect(higher.has(cap), `${TRUST_LEVELS[i - 1]} must include ${cap}`).toBe(true);
      }
    }
  });

  it('denies FOREIGN exactly what §12.2 says it must', () => {
    for (const cap of ['vault:read', 'spend', 'send', 'fs:write', 'net:write'] as Capability[]) {
      expect(permits('FOREIGN', cap), `FOREIGN must not have ${cap}`).toBe(false);
    }
  });

  it('denies an unrecognised capability at every level (deny-by-default)', () => {
    const invented = 'launch:missiles' as Capability;
    for (const level of TRUST_LEVELS) {
      expect(permits(level, invented)).toBe(false);
    }
  });

  it('keeps vault reads above DERIVED — a hallucinated read is still a read', () => {
    expect(permits('DERIVED', 'vault:read')).toBe(false);
    expect(permits('TOOL', 'vault:read')).toBe(false);
    expect(permits('USER', 'vault:read')).toBe(true);
  });

  it('only lets FOREIGN write quarantined memory, never active memory', () => {
    expect(permits('FOREIGN', 'memory:write')).toBe(false);
    expect(permits('FOREIGN', 'memory:write:quarantined')).toBe(true);
  });
});

describe('the gate returns data, not exceptions', () => {
  it('allows a permitted request', () => {
    const d = checkCapabilities('USER', ['vault:read', 'send']);
    expect(d.allowed).toBe(true);
    expect(d.missing).toEqual([]);
  });

  it('explains a denial in words a user and a model can both act on', () => {
    const d = checkCapabilities('FOREIGN', ['spend', 'vault:read']);
    expect(d.allowed).toBe(false);
    expect(d.missing.sort()).toEqual(['spend', 'vault:read']);
    expect(d.explanation).toContain('FOREIGN');
    expect(d.explanation).toContain('untrusted source');
    expect(d.escalatable).toBe(true); // a human holds these, so approval is possible
  });

  it('marks a denial unescalatable when no principal holds the capability', () => {
    const d = checkCapabilities('FOREIGN', ['launch:missiles' as Capability]);
    expect(d.allowed).toBe(false);
    expect(d.escalatable).toBe(false);
    expect(d.explanation).toContain('cannot be approved');
  });

  it('never silently grants a partially-permitted set', () => {
    const d = checkCapabilities('TOOL', ['net:read', 'spend']);
    expect(d.allowed).toBe(false);
    expect(d.missing).toEqual(['spend']);
  });
});

describe('the lattice as a whole', () => {
  it('has a ceiling defined for every declared trust level', () => {
    for (const level of TRUST_LEVELS satisfies readonly TrustLevel[]) {
      expect(capabilitiesFor(level).size).toBeGreaterThan(0);
    }
  });
});
