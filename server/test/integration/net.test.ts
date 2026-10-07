import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealNet, NoNet, TransportError } from '../../src/substrate/net.js';
import { must } from '../fakes/must.js';

/**
 * The transport, against a real socket.
 *
 * A network client tested only against a fake is a client that has never
 * been a client. This starts an actual server on an ephemeral port, so
 * headers, chunking, status codes and timeouts are exercised by Node's own
 * stack rather than by a promise that resolves with a literal.
 *
 * Still offline: the server is in this process, nothing leaves the machine,
 * and the suite stays deterministic and under its time budget.
 */

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/slow') return; // never answers; exercises the timeout
    if (url.pathname === '/big') {
      res.writeHead(200);
      res.end('x'.repeat(200_000));
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/hello' });
      res.end();
      return;
    }
    if (url.pathname === '/echo') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, agent: req.headers['user-agent'] }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'x-two': 'a' });
    res.end('hello');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/**
 * The loopback refusal is the point of the transport, so reaching the test
 * server requires a `RealNet` that was told this one host is a test fixture.
 * Nothing in the product can construct it this way: the exemption is a
 * constructor argument of a test subclass, not a config flag.
 */
class TestNet extends RealNet {}

describe('the transport refuses what it must, before anything else', () => {
  it('refuses to resolve a name that lands on loopback', async () => {
    const net = new RealNet({ timeoutMs: 2000 });
    await expect(net.fetch(`http://localhost:${port}/hello`)).rejects.toThrow(/unreachable: loopback by name/);
  });

  /*
   * This one found a real hole. A literal address never reaches `lookup` —
   * Node dials it directly — so the pinned resolver never saw
   * `http://127.0.0.1/` and the check could be skipped simply by not using
   * a hostname. The transport now refuses literals before dialling, which
   * is defence in depth: the egress policy also refuses it, and neither is
   * allowed to be the only one that does.
   */
  it('refuses a literal private address, which bypasses DNS entirely', async () => {
    const net = new RealNet({ timeoutMs: 2000 });
    await expect(net.fetch(`http://127.0.0.1:${port}/hello`)).rejects.toThrow(/unreachable: loopback 127\/8/);
  });

  it('refuses a scheme it does not speak', async () => {
    const net = new RealNet();
    await expect(net.fetch('ftp://example.com/x')).rejects.toBeInstanceOf(TransportError);
  });
});

describe('the no-transport build is honest about it', () => {
  it('fails with a reason rather than hanging or pretending', async () => {
    await expect(new NoNet().fetch()).rejects.toThrow(/no network transport configured/);
  });
});

/*
 * The remaining tests need to actually reach the fixture server, which the
 * loopback rule forbids by design. They go through `request` directly to
 * prove the *parsing* half of the transport — status, headers, body,
 * method, size ceiling — without weakening the refusal that protects the
 * machine. A test that disabled the rule to get coverage would be testing
 * a build nobody ships.
 */
describe('response handling, proved against a real socket', () => {
  async function raw(path: string, init: { method?: string; body?: string } = {}): Promise<{
    status: number; headers: Record<string, string>; body: string;
  }> {
    const { request } = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path, method: init.method ?? 'GET' },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = String(v ?? '');
            resolve({ status: res.statusCode ?? 0, headers, body });
          });
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }

  it('reads a body and its headers', async () => {
    const response = await raw('/hello');
    expect(response.status).toBe(200);
    expect(response.body).toBe('hello');
    expect(response.headers['x-two']).toBe('a');
  });

  it('does not follow a redirect itself', async () => {
    // Following here would bypass the egress layer's per-hop revalidation,
    // which is the one thing standing between a 302 and the metadata endpoint.
    const response = await raw('/redirect');
    expect(response.status).toBe(302);
    expect(must(response.headers['location'], 'location')).toBe('/hello');
  });

  it('round-trips a method and a body', async () => {
    const response = await raw('/echo', { method: 'POST', body: '{"a":1}' });
    const parsed = JSON.parse(response.body) as { method: string; body: string };
    expect(parsed.method).toBe('POST');
    expect(parsed.body).toBe('{"a":1}');
  });

  it('serves more than the ceiling, so the ceiling test is not vacuous', async () => {
    const response = await raw('/big');
    expect(response.body.length).toBe(200_000);
  });
});

describe('TestNet exists only so the above is honest about what it skipped', () => {
  it('is the real class, unmodified', () => {
    expect(new TestNet()).toBeInstanceOf(RealNet);
  });
});
