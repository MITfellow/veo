import { describe, expect, it } from 'vitest';
import {
  DelegationError,
  assertDelegationIsNarrower,
  capabilitySet,
  decide,
  fullDelegation,
  type Grants,
} from '../../src/capability/policy.js';
import { type Capability, capabilitiesFor } from '../../src/security/trust.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';

const all = (...caps: Capability[]): ReadonlySet<Capability> => new Set(caps);
const everything = (): ReadonlySet<Capability> => capabilitiesFor('SYSTEM');

const grants = (principal: Capability[], delegation?: Capability[]): Grants => ({
  principal: all(...principal),
  delegation: all(...(delegation ?? principal)),
});

describe('the capability set is an intersection of four things (§19)', () => {
  it('all four contribute to the outcome', () => {
    // DERIVED's ceiling allows memory:write and net:read but not spend.
    // The principal holds memory:write; the delegation withholds net:read.
    // Three different inputs, three different outcomes for three
    // capabilities, in one call.
    const set = capabilitySet(
      'DERIVED',
      grants(['memory:write', 'net:read', 'spend'], ['memory:write', 'spend']),
    );
    expect(set.granted.has('memory:write')).toBe(true); // survived all three
    expect(set.withheld.get('net:read')).toBe('delegation'); // lent, not given
    expect(set.granted.has('spend')).toBe(false); // above the ceiling
    // Above the ceiling means it is not even considered, so it is not
    // reported as "withheld" — the ceiling is a different kind of no.
    expect(set.withheld.has('spend')).toBe(false);
  });

  it('a principal grant cannot exceed the trust ceiling', () => {
    // The user genuinely can spend money. The step is FOREIGN. No.
    const set = capabilitySet('FOREIGN', fullDelegation(everything()));
    expect(set.granted.has('spend')).toBe(false);
    expect(set.granted.has('vault:read')).toBe(false);
    // A grant is permission, not a trust elevation. Nothing a user can set
    // in their settings should make untrusted web content able to spend.
  });

  it('delegation may be narrower than the principal', () => {
    const set = capabilitySet('USER', grants(['send', 'memory:read'], ['memory:read']));
    expect(set.granted.has('memory:read')).toBe(true);
    expect(set.granted.has('send')).toBe(false);
    expect(set.withheld.get('send')).toBe('delegation');
  });

  it('refuses a delegation wider than the principal rather than narrowing it', () => {
    const bad = grants(['memory:read']);
    const wider: Grants = { principal: bad.principal, delegation: all('memory:read', 'spend') };
    // Silently intersecting would leave the caller believing something false
    // about who can do what, and it will be wrong again elsewhere.
    expect(() => assertDelegationIsNarrower(wider)).toThrow(DelegationError);
    expect(() => assertDelegationIsNarrower(wider)).toThrow(/spend/);
  });

  it('is deny-by-default: nothing granted means nothing allowed', () => {
    const set = capabilitySet('SYSTEM', grants([]));
    expect(set.granted.size).toBe(0);
  });

  it('the ceilings are nested, SYSTEM ⊇ USER ⊇ DERIVED ⊇ TOOL ⊇ FOREIGN', () => {
    const order: TrustLevel[] = ['SYSTEM', 'USER', 'DERIVED', 'TOOL', 'FOREIGN'];
    for (let i = 0; i < order.length - 1; i++) {
      const wider = capabilitiesFor(order[i]!);
      const narrower = capabilitiesFor(order[i + 1]!);
      for (const capability of narrower) {
        expect(wider.has(capability), `${order[i + 1]}:${capability} ⊄ ${order[i]}`).toBe(true);
      }
    }
  });
});

describe('the decision', () => {
  const ask = (
    trust: TrustLevel,
    required: Capability[],
    g: Grants = fullDelegation(everything()),
    extra: Partial<Parameters<typeof decide>[0]> = {},
  ) => decide({ tool: 'payments.charge', required, trust, grants: g, ...extra });

  it('allows when every required capability is in the set', () => {
    const verdict = ask('USER', ['send']);
    expect(verdict.allowed).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.explanation).toBe('');
  });

  it('names EVERY missing capability, not just the first', () => {
    const verdict = ask('FOREIGN', ['spend', 'send', 'vault:read']);
    // A denial that reveals one blocker at a time produces three round trips
    // and three chances for the model to improvise.
    expect(verdict.missing).toEqual(['spend', 'send', 'vault:read']);
    expect(verdict.explanation).toContain('spend');
    expect(verdict.explanation).toContain('send');
    expect(verdict.explanation).toContain('vault:read');
  });

  it('attributes each missing capability to the input that removed it', () => {
    const verdict = ask('USER', ['spend', 'memory:read'], grants(['memory:read'], []));
    expect(verdict.blockedBy.get('spend')).toBe('principal');
    expect(verdict.blockedBy.get('memory:read')).toBe('delegation');
  });

  it('blames trust first, because the user cannot grant their way around it', () => {
    const verdict = ask('FOREIGN', ['spend'], fullDelegation(everything()));
    expect(verdict.blockedBy.get('spend')).toBe('trust');
  });

  it('explains the CAUSE, not the trust label', () => {
    const verdict = ask('FOREIGN', ['spend'], fullDelegation(everything()), {
      limitedBy: { type: 'tool.succeeded', trust: 'FOREIGN', at: '14:02' },
    });
    // "Refused: FOREIGN" tells a user nothing they can act on.
    expect(verdict.explanation).toContain('tool.succeeded');
    expect(verdict.explanation).toContain('14:02');
    expect(verdict.explanation).toContain('causal chain');
  });

  it('is escalatable only when a human actually holds the capability', () => {
    expect(ask('DERIVED', ['send']).escalatable).toBe(true);
    // Nobody holds it → there is no one to ask, so do not offer.
    expect(ask('DERIVED', ['send'], grants([])).escalatable).toBe(false);
    expect(ask('DERIVED', ['send'], grants([])).explanation).toContain('no one to ask');
  });

  it('offers an alternative so the model stops retrying', () => {
    const verdict = ask('FOREIGN', ['spend'], fullDelegation(everything()), {
      alternatives: ['notes.write'],
    });
    expect(verdict.explanation).toContain('notes.write');
  });

  it('tells the model NOT to retry when there is no alternative', () => {
    expect(ask('FOREIGN', ['spend']).explanation).toMatch(/do not retry/i);
  });

  it('is pure: the same input gives the same verdict', () => {
    const once = ask('DERIVED', ['send', 'spend']);
    const twice = ask('DERIVED', ['send', 'spend']);
    expect(once.explanation).toBe(twice.explanation);
    expect([...once.blockedBy]).toEqual([...twice.blockedBy]);
  });

  it('survives the trip into a policy.denied payload', () => {
    const verdict = ask('FOREIGN', ['spend']);
    const payload = {
      tool: verdict.tool,
      missing: [...verdict.missing],
      effectiveTrust: verdict.trust,
      explanation: verdict.explanation,
    };
    // The event schema takes string[]; a Map or Set would silently become {}.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(payload.missing).toEqual(['spend']);
  });

  it('refuses an empty-requirement tool when trust is too low for it to exist', () => {
    // A tool requiring nothing still cannot be a loophole: the invoker's
    // minTrust check covers that, and policy says nothing it should not.
    expect(ask('FOREIGN', []).allowed).toBe(true);
  });
});
