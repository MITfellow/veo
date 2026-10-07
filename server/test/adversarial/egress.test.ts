import { describe, expect, it } from 'vitest';
import { createTestSubstrate, type TestSubstrate } from '../fakes/substrate.js';
import { Egress, EgressDenied, refuseReason, originOf, DEFAULT_POLICY, type EgressPolicy } from '../../src/security/egress.js';
import type { Net } from '../../src/substrate/ports.js';
import { must } from '../fakes/must.js';

/**
 * Egress, attacked.
 *
 * This is the first module in the build that can cause something to happen
 * outside the machine, so every test here is an attempt to reach somewhere
 * it must not. Green means the attempt failed.
 */

const ALLOWED = 'https://api.example.com';

function policy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return { ...DEFAULT_POLICY, allowedOrigins: [ALLOWED], trust: 'USER', ...over };
}

/** A network that records what it was asked for and answers from a script. */
function fakeNet(script: Array<{ status: number; headers?: Record<string, string>; body?: string }>): Net & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    fetch: (url: string) => {
      calls.push(url);
      const step = script[Math.min(index++, script.length - 1)] ?? { status: 200 };
      return Promise.resolve({ status: step.status, headers: step.headers ?? {}, body: step.body ?? '' });
    },
  };
}

function harness(script: Parameters<typeof fakeNet>[0], over: Partial<EgressPolicy> = {}): {
  s: TestSubstrate; net: ReturnType<typeof fakeNet>; egress: Egress;
} {
  const s = createTestSubstrate();
  const net = fakeNet(script);
  const egress = new Egress({ net, events: s.events, now: () => s.clock.now() }, policy(over));
  return { s, net, egress };
}

describe('the places it must never go', () => {
  const FORBIDDEN = [
    ['http://169.254.169.254/latest/meta-data/', 'AWS metadata'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata'],
    ['http://127.0.0.1:8787/api/vault', 'its own loopback API'],
    ['http://localhost/admin', 'loopback by name'],
    ['http://10.0.0.5/internal', 'private 10/8'],
    ['http://192.168.1.1/router', 'home router'],
    ['http://172.16.9.9/', 'private 172.16/12'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fd00::1]/', 'IPv6 unique local'],
    ['http://100.64.0.1/', 'carrier-grade NAT'],
    ['http://0.0.0.0/', 'this-network'],
    ['file:///etc/passwd', 'the filesystem by scheme'],
    ['https://user:pass@api.example.com/', 'credentials in the URL'],
  ] as const;

  for (const [url, what] of FORBIDDEN) {
    it(`refuses ${what}`, () => {
      // Allow-listed on purpose, so the refusal cannot be coming from the
      // allow-list. These must be refused *despite* permission.
      const permissive = policy({ allowedOrigins: [originOfSafe(url), ALLOWED] });
      expect(refuseReason(url, permissive)).not.toBeNull();
    });
  }

  it('refuses the metadata endpoint even when it is the only allowed origin', () => {
    const reason = refuseReason('http://169.254.169.254/', policy({ allowedOrigins: ['http://169.254.169.254'] }));
    expect(reason).toMatch(/allow-list or not/);
  });

  it('permits an ordinary allow-listed origin, so the suite is not refusing everything', () => {
    expect(refuseReason(`${ALLOWED}/v1/things`, policy())).toBeNull();
  });
});

describe('the allow-list is the whole permission', () => {
  it('refuses an origin nobody allowed', () => {
    expect(refuseReason('https://attacker.example/x', policy())).toMatch(/not in the allow-list/);
  });

  it('treats a different port as a different origin', () => {
    expect(refuseReason('https://api.example.com:8443/x', policy())).toMatch(/not in the allow-list/);
  });

  it('is not fooled by a hostname that merely ends with an allowed one', () => {
    expect(refuseReason('https://api.example.com.attacker.test/x', policy())).toMatch(/not in the allow-list/);
  });

  it('refuses everything when the list is empty, rather than allowing everything', () => {
    expect(refuseReason(`${ALLOWED}/x`, policy({ allowedOrigins: [] }))).toMatch(/no origin is allowed/);
  });

  it('refuses cleartext http for an untrusted caller', () => {
    const p = policy({ allowedOrigins: ['http://api.example.com'], trust: 'FOREIGN' });
    expect(refuseReason('http://api.example.com/x', p)).toMatch(/cleartext/);
  });
});

describe('redirects are re-validated at every hop', () => {
  it('follows an allowed redirect', async () => {
    const { s, net, egress } = harness([
      { status: 302, headers: { location: `${ALLOWED}/second` } },
      { status: 200, body: 'ok' },
    ]);
    const response = await egress.fetch({ url: `${ALLOWED}/first` });
    expect(response.body).toBe('ok');
    expect(response.chain).toHaveLength(2);
    expect(net.calls).toHaveLength(2);
    s.close();
  });

  it('refuses a redirect to the metadata endpoint — the oldest SSRF there is', async () => {
    const { s, net, egress } = harness([
      { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } },
      { status: 200, body: 'SECRETS' },
    ]);
    await expect(egress.fetch({ url: `${ALLOWED}/start` })).rejects.toBeInstanceOf(EgressDenied);
    // The second request was never made: the refusal happened before the call.
    expect(net.calls).toEqual([`${ALLOWED}/start`]);
    expect(s.events.read().map((e) => e.type)).toContain('egress.blocked');
    s.close();
  });

  it('refuses a redirect off the allow-list', async () => {
    const { s, net, egress } = harness([
      { status: 301, headers: { location: 'https://attacker.example/collect' } },
    ]);
    await expect(egress.fetch({ url: `${ALLOWED}/start` })).rejects.toThrow(/not in the allow-list/);
    expect(net.calls).toHaveLength(1);
    s.close();
  });

  it('stops a redirect loop instead of following it forever', async () => {
    const { s, net, egress } = harness(
      [{ status: 302, headers: { location: `${ALLOWED}/loop` } }],
      { maxRedirects: 2 },
    );
    await expect(egress.fetch({ url: `${ALLOWED}/loop` })).rejects.toThrow(/more than 2 redirects/);
    expect(net.calls.length).toBeLessThanOrEqual(3);
    s.close();
  });
});

describe('budgets are hard stops, not warnings', () => {
  it('stops when the response budget is exhausted', async () => {
    const { s, egress } = harness([{ status: 200, body: 'x'.repeat(5000) }], { maxBytes: 1000 });
    await expect(egress.fetch({ url: `${ALLOWED}/big` })).rejects.toThrow(/response budget/);
    s.close();
  });

  it('stops when the request budget is exhausted', async () => {
    const { s, egress } = harness([{ status: 200, body: 'ok' }], { maxRequests: 2 });
    await egress.fetch({ url: `${ALLOWED}/a` });
    await egress.fetch({ url: `${ALLOWED}/b` });
    await expect(egress.fetch({ url: `${ALLOWED}/c` })).rejects.toThrow(/request budget/);
    expect(egress.spent().requests).toBe(2);
    s.close();
  });
});

describe('nothing leaves unlogged, and nothing private is logged', () => {
  it('records the attempt before the call, with the origin only', async () => {
    const { s, egress } = harness([{ status: 200, body: 'ok' }]);
    await egress.fetch({ url: `${ALLOWED}/v1/users/ara?token=SEKRIT&email=ara@example.com` });

    const attempted = must(s.events.read().find((e) => e.type === 'egress.attempted'), 'the attempt');
    expect(attempted.payload['origin']).toBe(ALLOWED);
    // The path and query are where private data sits, so they are not logged.
    const log = JSON.stringify(s.events.read());
    expect(log).not.toContain('SEKRIT');
    expect(log).not.toContain('ara@example.com');
    s.close();
  });

  it('records a refusal with its reason', async () => {
    const { s, egress } = harness([{ status: 200 }]);
    await expect(egress.fetch({ url: 'https://attacker.example/x' })).rejects.toThrow();
    const blocked = must(s.events.read().find((e) => e.type === 'egress.blocked'), 'the refusal');
    expect(String(blocked.payload['reason'])).toMatch(/allow-list/);
    s.close();
  });

  it('survives a rebuild — the egress history is replayable like everything else', async () => {
    const { s, egress } = harness([{ status: 200, body: 'ok' }]);
    await egress.fetch({ url: `${ALLOWED}/a` });
    const before = s.events.count();
    s.events.rebuild();
    expect(s.events.count()).toBe(before);
    s.close();
  });
});

function originOfSafe(url: string): string {
  try {
    return originOf(url);
  } catch {
    return 'https://unparseable.invalid';
  }
}
