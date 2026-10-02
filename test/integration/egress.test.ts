import { beforeEach, describe, expect, it } from 'vitest';
import {
  EgressDenied,
  ScopedNetImpl,
  checkUrl,
  hostAllowed,
  isBlockedAddress,
} from '../../src/capability/egress.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import type { Substrate } from '../../src/substrate/index.js';
import type { EgressPolicy } from '../../src/capability/tool.js';
import { FakeNet, respond } from '../fakes/net.js';
import type { TrustLevel } from '../../src/substrate/events/types.js';

const POLICY: EgressPolicy = { hosts: ['api.example.com', '*.cdn.example.com'], methods: ['GET', 'POST'] };

let substrate: Substrate;
beforeEach(() => {
  substrate = createTestSubstrate();
});

function scoped(
  handler: (url: string) => ReturnType<typeof respond>,
  options: {
    policy?: EgressPolicy;
    trust?: TrustLevel;
    maxBytes?: number;
    resolve?: (h: string) => Promise<string[]>;
  } = {},
): ScopedNetImpl {
  return new ScopedNetImpl({
    net: new FakeNet((req) => handler(req.url)),
    policy: options.policy ?? POLICY,
    events: substrate.events,
    budget: { maxBytes: options.maxBytes ?? 1_000_000, used: 0 },
    tool: 'test.http',
    runId: 'run-1',
    stepId: 'step-1',
    principal: 'system',
    effectiveTrust: options.trust ?? 'USER',
    signal: new AbortController().signal,
    ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
  });
}

describe('the blocked-address table is a pure function', () => {
  it('blocks loopback, private, link-local and CGNAT ranges', () => {
    for (const address of [
      '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1',
      '::1', 'fe80::1', 'fc00::1', 'fd12::3',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('blocks the cloud metadata endpoint, which is the whole point', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('metadata.google.internal')).toBe(true);
  });

  it('unwraps IPv4-mapped IPv6, which would otherwise bypass the IPv4 table', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('allows a public hostname but blocks localhost by name', () => {
    expect(isBlockedAddress('example.com')).toBe(false);
    expect(isBlockedAddress('localhost')).toBe(true);
    expect(isBlockedAddress('api.localhost')).toBe(true);
  });
});

describe('host allowlisting', () => {
  it('matches exactly, and matches a wildcard only on real subdomains', () => {
    expect(hostAllowed('api.example.com', POLICY.hosts)).toBe(true);
    expect(hostAllowed('img.cdn.example.com', POLICY.hosts)).toBe(true);
    expect(hostAllowed('cdn.example.com', POLICY.hosts)).toBe(false); // bare, not a subdomain
    expect(hostAllowed('evil.com', POLICY.hosts)).toBe(false);
  });

  it('is not fooled by a suffix that merely ends the same way', () => {
    // The classic bug: 'evilexample.com'.endsWith('example.com') is true.
    expect(hostAllowed('evilexample.com', ['example.com'])).toBe(false);
    expect(hostAllowed('notapi.example.com.evil.com', POLICY.hosts)).toBe(false);
  });
});

describe('checkUrl', () => {
  it('permits an allowlisted host and method', () => {
    expect(checkUrl('https://api.example.com/v1', POLICY, 'GET').allowed).toBe(true);
  });
  it('refuses a method not on the list', () => {
    const check = checkUrl('https://api.example.com', POLICY, 'DELETE');
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('DELETE');
  });
  it('refuses a non-HTTP protocol', () => {
    expect(checkUrl('file:///etc/passwd', POLICY, 'GET').allowed).toBe(false);
    expect(checkUrl('gopher://x/', POLICY, 'GET').allowed).toBe(false);
  });
  it('refuses the metadata endpoint EVEN IF explicitly allowlisted', () => {
    const permissive: EgressPolicy = { hosts: ['169.254.169.254'], methods: ['GET'] };
    const check = checkUrl('http://169.254.169.254/latest/meta-data/', permissive, 'GET');
    // There is no legitimate reason for this agent to read cloud metadata,
    // and a config file is exactly how that rule would get turned off.
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('never reachable');
  });
});

describe('the scoped Net enforces it', () => {
  it('fetches an allowed URL', async () => {
    const net = scoped(() => respond(200, 'hello'));
    const response = await net.fetch({ url: 'https://api.example.com/x' });
    expect(new TextDecoder().decode(response.body)).toBe('hello');
  });

  it('refuses a host off the list and records the denial', async () => {
    const net = scoped(() => respond(200));
    await expect(net.fetch({ url: 'https://evil.com/x' })).rejects.toThrow(EgressDenied);
    const denied = substrate.events.read({ types: ['policy.denied'] }).at(0);
    expect((denied?.payload as { explanation: string }).explanation).toContain('allowlist');
  });

  it('re-validates at EVERY redirect hop, not just the first', async () => {
    const net = scoped((url) =>
      url.includes('api.example.com')
        ? respond(302, '', { location: 'http://169.254.169.254/latest/meta-data/' })
        : respond(200, 'SECRET CREDENTIALS'),
    );
    await expect(net.fetch({ url: 'https://api.example.com/start' })).rejects.toThrow(
      /never reachable/,
    );
    const denied = substrate.events.read({ types: ['policy.denied'] }).at(0);
    // Validating only the first URL is the oldest SSRF mistake there is.
    expect((denied?.payload as { explanation: string }).explanation).toContain('via a redirect');
  });

  it('follows an allowed redirect', async () => {
    const net = scoped((url) =>
      url.endsWith('/start')
        ? respond(302, '', { location: 'https://api.example.com/final' })
        : respond(200, 'arrived'),
    );
    const response = await net.fetch({ url: 'https://api.example.com/start' });
    expect(new TextDecoder().decode(response.body)).toBe('arrived');
  });

  it('stops a redirect loop', async () => {
    const net = scoped(() => respond(302, '', { location: 'https://api.example.com/loop' }));
    await expect(net.fetch({ url: 'https://api.example.com/loop' })).rejects.toThrow(/redirects/);
  });

  it('blocks DNS rebinding: the RESOLVED address is what is validated', async () => {
    const net = scoped(() => respond(200, 'secrets'), {
      // The name is allowlisted and looks fine; it resolves to the metadata
      // endpoint. Checking only the name is the TOCTOU hole.
      resolve: async () => ['169.254.169.254'],
    });
    await expect(net.fetch({ url: 'https://api.example.com/x' })).rejects.toThrow(
      /rebinding/,
    );
  });

  it('allows a name that resolves to a public address', async () => {
    const net = scoped(() => respond(200, 'fine'), { resolve: async () => ['93.184.216.34'] });
    await expect(net.fetch({ url: 'https://api.example.com/x' })).resolves.toBeDefined();
  });

  it('enforces the per-run byte budget with a hard stop', async () => {
    const net = scoped(() => respond(200, 'x'.repeat(5000)), { maxBytes: 4000 });
    await expect(net.fetch({ url: 'https://api.example.com/big' })).rejects.toThrow(
      /egress budget/,
    );
    const raised = substrate.events.read({ types: ['error.raised'] }).at(0);
    expect((raised?.payload as { kind: string }).kind).toBe('egress_budget');
  });

  it('treats a large FOREIGN-influenced upload as suspected exfiltration', async () => {
    const net = scoped(() => respond(200, ''), { maxBytes: 100, trust: 'FOREIGN' });
    await expect(
      net.fetch({ url: 'https://api.example.com/upload', method: 'POST', body: 'y'.repeat(500) }),
    ).rejects.toThrow(/exfiltration/);
    const raised = substrate.events.read({ types: ['error.raised'] }).at(0);
    expect((raised?.payload as { kind: string }).kind).toBe('exfiltration_suspected');
    // §14 says a hard stop plus an alert, not a warning.
    expect((raised?.payload as { fatal: boolean }).fatal).toBe(true);
  });

  it('enforces a per-call response cap separately from the run budget', async () => {
    const net = scoped(() => respond(200, 'x'.repeat(2000)), {
      policy: { ...POLICY, maxResponseBytes: 1000 },
    });
    await expect(net.fetch({ url: 'https://api.example.com/x' })).rejects.toThrow(/exceeds/);
  });
});
