import { describe, expect, it } from 'vitest';
import { CapabilityBroker, type BrokerContext, type IdentityRef } from '../../src/capability/semantics/broker.js';
import { CAPABILITIES, capability, disclosure, type CapabilityFamily } from '../../src/capability/semantics/ontology.js';
import { MANIFESTS, describeForModel, implementorsOf, manifest } from '../../src/capability/semantics/manifest.js';
import { must } from '../fakes/must.js';

/**
 * Phases 8–10: the semantic layer.
 *
 * The claim under test is the brief's §202 — the user does not operate the
 * harness. They state an objective; the harness picks the connector, picks
 * the account, and when it cannot, says something a person can act on.
 */

const broker = new CapabilityBroker();

function identity(over: Partial<IdentityRef> = {}): IdentityRef {
  return {
    identityId: 'id-work', provider: 'google', scope: 'WORK',
    grantedScopes: ['gmail.readonly', 'gmail.send', 'calendar.readonly', 'calendar.events'],
    status: 'active', lastVerified: 1_000, ...over,
  };
}

function context(over: Partial<BrokerContext> = {}): BrokerContext {
  return {
    scope: 'WORK',
    health: new Map([['gmail', 'AVAILABLE'], ['gcal', 'AVAILABLE'], ['notes', 'AVAILABLE'], ['files', 'AVAILABLE']]),
    identities: [identity()],
    enabled: ['gmail', 'gcal', 'notes', 'files'],
    ...over,
  };
}

describe('the ontology is coherent', () => {
  it('gives every objective a reason not to use it (§22)', () => {
    for (const c of CAPABILITIES) {
      expect(c.whenNotToUse.length, `${c.id} has no negative knowledge`).toBeGreaterThan(0);
      expect(c.whenToUse.length).toBeGreaterThan(0);
    }
  });

  it('makes every external effect say how it is verified and whether it can be undone', () => {
    for (const c of CAPABILITIES.filter((x) => x.risk !== 'none' && x.risk !== 'local')) {
      expect(c.verification, `${c.id}`).not.toBe('');
      expect(c.rollback, `${c.id}`).not.toBe('');
      expect(c.postconditions.length, `${c.id}`).toBeGreaterThan(0);
    }
  });

  it('never lets the model choose an identity for a consequential action (§6)', () => {
    for (const c of CAPABILITIES.filter((x) => x.identity.needed !== 'none')) {
      expect(c.identity.resolvedByHarness, `${c.id}`).toBe(true);
    }
  });

  it('states that an irreversible action cannot be undone, rather than implying it can', () => {
    const send = must(capability('SEND_EXTERNAL_MESSAGE'), 'send');
    expect(send.risk).toBe('irreversible-external');
    expect(send.rollback).toMatch(/none/i);
    expect(send.rollback).toMatch(/not a rollback/);
  });

  it('discloses progressively, so a planner is not handed every schema (§23)', () => {
    const families = disclosure.level1();
    expect(families.length).toBeGreaterThan(3);
    const family = must(families.find((f) => f.count > 0), 'a populated family').family as CapabilityFamily;

    const second = disclosure.level2(family);
    expect(must(second[0], 'an objective')).not.toHaveProperty('inputs');

    const third = must(disclosure.level3(must(second[0], 'first').id), 'detail');
    expect(third).not.toHaveProperty('inputs');
    expect(disclosure.level4(must(second[0], 'first').id)).toBeDefined();
  });
});

describe('the manifests describe reality', () => {
  it('only claims objectives that exist in the ontology', () => {
    for (const m of MANIFESTS) {
      for (const impl of m.implements) {
        expect(capability(impl.capabilityId), `${m.connectorId} claims ${impl.capabilityId}`).toBeDefined();
      }
    }
  });

  it('says what each connector cannot do, which is as useful as what it can', () => {
    for (const m of MANIFESTS) expect(m.cannotDo.length, m.connectorId).toBeGreaterThan(0);
  });

  it('never claims external content is better than FOREIGN', () => {
    for (const m of MANIFESTS.filter((x) => x.identityProviders.length > 0)) {
      expect(m.yieldsTrust, m.connectorId).toBe('FOREIGN');
    }
  });

  it('generates the model-facing description instead of keeping a second copy (§19)', () => {
    const gmail = must(manifest('gmail'), 'gmail');
    const described = describeForModel(gmail, 'AUTH_REQUIRED');
    expect(described).toContain('SEND_EXTERNAL_MESSAGE');
    expect(described).toContain('cannot:');
    expect(described).toContain('do not plan work that needs it');
    // The prose exists nowhere else, so it cannot drift.
    expect(described).toContain(gmail.represents);
  });

  it('offers an alternative where one genuinely exists (§147)', () => {
    expect(must(manifest('gcal'), 'gcal').alternatives).toContain('calendar-local');
    expect(implementorsOf('READ_CURRENT_STATE').length).toBeGreaterThan(1);
  });
});

describe('routing — the harness chooses, not the user (§145)', () => {
  it('picks a connector for an objective without being told one', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context());
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    expect(routing.route.connectorId).toBe('gmail');
    expect(must(routing.route.identity, 'identity').scope).toBe('WORK');
    expect(routing.route.because).toMatch(/verification is strong/);
  });

  it('prefers the implementation whose result can be verified', () => {
    // Local calendar is faster, Google Calendar is verifiable. A slow
    // correct answer beats a fast unverifiable one.
    const routing = broker.route('READ_CURRENT_STATE', context({
      enabled: ['gcal', 'calendar-local'],
      health: new Map([['gcal', 'AVAILABLE'], ['calendar-local', 'AVAILABLE']]),
    }));
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    expect(routing.route.connectorId).toBe('gcal');
    expect(routing.route.alternatives.map((a) => a.connectorId)).toContain('calendar-local');
  });

  it('falls back to the next source when the first is excluded (§147)', () => {
    const first = broker.route('READ_CURRENT_STATE', context({
      enabled: ['gcal', 'calendar-local'],
      health: new Map([['gcal', 'AVAILABLE'], ['calendar-local', 'AVAILABLE']]),
    }));
    expect(first.ok && first.route.connectorId).toBe('gcal');

    const second = broker.next('READ_CURRENT_STATE', context({
      enabled: ['gcal', 'calendar-local'],
      health: new Map([['gcal', 'AVAILABLE'], ['calendar-local', 'AVAILABLE']]),
    }), ['gcal']);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.route.connectorId).toBe('calendar-local');
  });

  it('lets history reorder candidates without granting permission (§150)', () => {
    const base = context({
      enabled: ['gcal', 'calendar-local'],
      health: new Map([['gcal', 'AVAILABLE'], ['calendar-local', 'AVAILABLE']]),
    });
    const biased: BrokerContext = {
      ...base,
      successRate: new Map([['gcal:READ_CURRENT_STATE', 0.0], ['calendar-local:READ_CURRENT_STATE', 1.0]]),
    };
    const routing = broker.route('READ_CURRENT_STATE', biased);
    expect(routing.ok && routing.route.connectorId).toBe('calendar-local');

    // But history cannot resurrect a connector that is switched off.
    const off = broker.route('READ_CURRENT_STATE', { ...biased, enabled: [] });
    expect(off.ok).toBe(false);
  });
});

describe('refusing is a feature, and it says what would help (§136, §160)', () => {
  it('names the connector and the reason when nothing is switched on', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({ enabled: [] }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/gmail \(not switched on/);
    expect(routing.refusal.remedy).toContain('switch on gmail');
  });

  it('distinguishes "needs signing in" from "unavailable"', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({
      health: new Map([['gmail', 'AUTH_REQUIRED']]),
    }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/needs signing in again/);
    expect(routing.refusal.remedy).toContain('sign in to gmail again');
  });

  it('refuses when the account lacks the provider scope, naming the scope', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({
      identities: [identity({ grantedScopes: ['gmail.readonly'] })],
    }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/gmail\.send/);
  });

  it('refuses rather than reaching a personal account for work', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({
      scope: 'WORK',
      identities: [identity({ scope: 'PERSONAL', identityId: 'id-home' })],
    }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/no account for work/);
  });

  it('asks which account rather than flipping a coin (§106, §139)', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({
      scope: 'WORK',
      identities: [
        identity({ identityId: 'a', scope: 'WORK' }),
        identity({ identityId: 'b', scope: 'PROJECT' }),
      ],
    }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/two accounts could do this/);
    expect(routing.refusal.remedy).toContain('tell me which account to use');
  });

  it('is honest when the build simply cannot do something', () => {
    const routing = broker.route('TELEPORT_THE_USER', context());
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/no objective called/);
  });

  it('treats an unknown connector health as unavailable, never as healthy', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({ health: new Map() }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.reason).toMatch(/not available in this build/);
  });

  it('records every candidate it considered, for "why not?" (§92)', () => {
    const routing = broker.route('SEND_EXTERNAL_MESSAGE', context({ enabled: [] }));
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(routing.refusal.considered.length).toBeGreaterThan(0);
    expect(must(routing.refusal.considered[0], 'first').connectorId).toBe('gmail');
  });
});

describe('objectives that need no account still work', () => {
  it('routes recall with no identity at all', () => {
    const routing = broker.route('RECALL_KNOWLEDGE', context({ enabled: ['notes'], scope: 'PERSONAL' }));
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    expect(routing.route.identity).toBeNull();
    expect(routing.route.because).toContain('no account needed');
  });
});
