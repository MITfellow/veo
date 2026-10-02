import { describe, expect, it } from 'vitest';
import { createTestSecurity } from '../../src/security/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';
import { canonicalJson } from '../../src/substrate/hash.js';
import { JsonLogger } from '../../src/substrate/log.js';

/**
 * The M1 acceptance test (§33, §31 "Secret leakage").
 *
 * > Fuzz every surface — events, contexts, logs, model requests, traces,
 * > exports — for known secret values. Zero hits.
 *
 * The point of this test is to be *hostile*. It does not drive the happy
 * path; it deliberately does the careless things a real integration will do
 * two years from now: interpolate a credential into an error message, use one
 * as a map key, put one in a stack trace, encode one into a URL, dump headers
 * into a trace. Every one of those must still come out clean.
 *
 * Never weaken this test. If it fails, something leaks.
 */

const PASS = 'a passphrase long enough';

const SECRET_SHAPES = [
  (i: number) => `sk-live-${'a'.repeat(8)}${i}${'f9e8d7c6b5'.repeat(2)}`,
  (i: number) => `ghp_${'Z'.repeat(12)}${i}${'0123456789abcdef'}`,
  (i: number) => `postgres://admin:pw-${i}-${'x'.repeat(16)}@db.internal/main`,
  (i: number) => `-----BEGIN RSA PRIVATE KEY-----\nMIIB${i}${'Q'.repeat(40)}\n-----END RSA PRIVATE KEY-----`,
  (i: number) => `AKIA${'IOSFODNN7EXAMPL'.slice(0, 15)}${i % 10}`,
];

describe('secret leakage fuzz — the M1 bar', () => {
  it('finds zero hits across every surface after 200 operations on 50 secrets', async () => {
    const substrate = createTestSubstrate();

    // Capture every log line this run produces; logs are a surface too.
    const logLines: string[] = [];
    // Configured exactly as createSubstrate configures the real one: wired to
    // the same Redactor the event log uses.
    const logger = new JsonLogger(
      {},
      { level: 'debug', sink: (l) => logLines.push(l), redactor: substrate.redactor },
    );

    const security = createTestSecurity(substrate);
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);

    const values: string[] = [];
    for (let i = 0; i < 50; i++) {
      const value = SECRET_SHAPES[i % SECRET_SHAPES.length]!(i);
      values.push(value);
      await security.vault.create(`svc-${i}`, value, { principal: 'user:ara', label: `svc_${i}` });
    }

    const modelRequests: unknown[] = [];
    const traces: unknown[] = [];

    for (let op = 0; op < 200; op++) {
      const i = op % 50;
      const ref = `secret://svc-${i}/1`;

      await security.vault.useSecret(
        ref,
        { principal: 'user:ara', tool: `tool-${op % 7}`, runId: `run-${op}` },
        (value) => {
          const text = new TextDecoder().decode(value);

          switch (op % 7) {
            case 0:
              // Careless: interpolate the credential into an event payload.
              substrate.events.append({
                type: 'error.raised',
                payload: { kind: 'http', message: `401 using ${text}`, fatal: false },
                principal: 'system',
                trust: 'SYSTEM',
              });
              break;
            case 1:
              // Careless: a stack trace carrying the value.
              substrate.events.append({
                type: 'tool.failed',
                payload: {
                  tool: 'http',
                  kind: 'auth',
                  message: new Error(`at request(${text})\n  at retry(${text})`).stack ?? text,
                  retryable: false,
                },
                principal: 'system',
                trust: 'TOOL',
              });
              break;
            case 2:
              // Careless: the secret as an object key.
              substrate.events.append({
                type: 'tool.requested',
                payload: { tool: 'http', version: '1', input: { [text]: 'used-as-key' } },
                principal: 'system',
                trust: 'SYSTEM',
              });
              break;
            case 3:
              // Careless: url-encoded into a query string.
              substrate.events.append({
                type: 'tool.requested',
                payload: {
                  tool: 'http',
                  version: '1',
                  input: { url: `https://api.example.com/v1?key=${encodeURIComponent(text)}` },
                },
                principal: 'system',
                trust: 'SYSTEM',
              });
              break;
            case 4:
              // Careless: logged.
              logger.error('request failed', { authorization: `Bearer ${text}`, runId: `run-${op}` });
              break;
            case 5:
              // Careless: built into a model request.
              modelRequests.push({
                model: 'fake-1',
                messages: [{ role: 'system', content: `your api key is ${text}` }],
              });
              break;
            default:
              // Careless: dumped into a trace.
              traces.push({ step: op, headers: { authorization: text }, note: 'debug dump' });
          }
          return undefined;
        },
      );
    }

    /* ── surface 1: every event payload in the log ───────────────────────── */
    const allEvents = canonicalJson(substrate.events.read().map((e) => e.payload));

    /* ── surface 2: every row of every table ─────────────────────────────── */
    const tables = substrate.storage.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    let dbDump = '';
    for (const { name } of tables) {
      for (const row of substrate.storage.all<Record<string, unknown>>(`SELECT * FROM ${name}`)) {
        for (const v of Object.values(row)) {
          dbDump += v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v ?? '');
          dbDump += '\u0000';
        }
      }
    }

    /* ── surface 3: the export ───────────────────────────────────────────── */
    const exported = canonicalJson({
      events: substrate.events.read(),
      secrets: security.vault.list(),
      tombstones: security.shredder.list(),
    });

    /* ── the assertions ──────────────────────────────────────────────────── */
    const surfaces: Array<[string, string]> = [
      ['event payloads', allEvents],
      ['database dump', dbDump],
      ['log lines', logLines.join('\n')],
      ['export', exported],
    ];

    for (const value of values) {
      for (const [name, haystack] of surfaces) {
        expect(haystack, `secret leaked into ${name}`).not.toContain(value);
        expect(haystack, `url-encoded secret leaked into ${name}`).not.toContain(
          encodeURIComponent(value),
        );
      }
    }

    // Model requests and traces are not auto-redacted — they never pass
    // through append(). They are exactly what the firewall exists for, and it
    // must catch every single one.
    let caught = 0;
    for (const request of [...modelRequests, ...traces]) {
      const violations = security.firewall.scan(request);
      if (violations.length > 0) caught++;
    }
    expect(caught, 'the firewall must catch every leaky request').toBe(
      modelRequests.length + traces.length,
    );
    expect(modelRequests.length + traces.length).toBeGreaterThan(50);

    // And the log itself must still verify — redaction happens before the
    // hash, so stripping a secret cannot corrupt the chain.
    expect(substrate.events.verifyChain().ok).toBe(true);
    substrate.close();
  });

  it('keeps the secret out of the one place people forget: the error of a failed decrypt', async () => {
    const substrate = createTestSubstrate();
    const security = createTestSecurity(substrate);
    await security.keyring.initialize(PASS);
    await security.keyring.unlock(PASS);

    const value = 'sk-live-must-never-appear-in-an-error-message';
    await security.vault.create('svc', value, { principal: 'user:ara' });

    const err = await security.vault
      .useSecret('secret://svc/1', { principal: 'user:ara' }, () => {
        throw new Error('downstream exploded');
      })
      .catch((e: unknown) => e as Error);

    expect(err.message).not.toContain(value);
    expect(err.stack ?? '').not.toContain(value);
    substrate.close();
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * M4: the SSE stream, which until now had no redactor at all.
 *
 * The log redacts on append and the invoker redacts observations, but a
 * live token delta goes model → stream → browser without ever touching
 * either. It was the one surface §31's "fuzz every surface" had not been
 * pointed at.
 * ──────────────────────────────────────────────────────────────────────── */
describe('the SSE stream is redacted too (invariant 7)', () => {
  it('scrubs a secret from a live delta frame', async () => {
    const { Redactor } = await import('../../src/substrate/events/redact.js');
    const { SseConnection } = await import('../../src/interface/stream.js');
    const { FakeClock } = await import('../../src/substrate/clock.js');

    const SECRET = 'sk-live-STREAMED-SECRET-001';
    const redactor = new Redactor();
    redactor.register(SECRET, 'api-key');

    const written: string[] = [];
    const res = {
      writeHead() {},
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
      end() {},
      on() {},
      once() {},
      writableEnded: false,
    } as unknown as import('node:http').ServerResponse;

    const connection = new SseConnection({ res, clock: new FakeClock(), redactor });
    await connection.send({ id: 1, event: 'delta', data: { text: `the key is ${SECRET}` } });
    await connection.close();

    const everything = written.join('');
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain('delta'); // the frame still arrived
  });
});
