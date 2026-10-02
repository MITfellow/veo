import { describe, expect, it } from 'vitest';
import { Redactor } from '../../src/substrate/events/redact.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

const SECRET = 'hunter2-correct-horse-battery-staple';

describe('redaction of registered values', () => {
  it('catches the secret at the top level, nested, in arrays, and inside larger strings', () => {
    const r = new Redactor();
    r.register(SECRET, 'db_password');

    const out = r.redact({
      top: SECRET,
      nested: { deep: { deeper: SECRET } },
      list: ['fine', SECRET, { also: SECRET }],
      embedded: `postgres://user:${SECRET}@host/db`,
      [SECRET]: 'secret-as-a-key',
    });

    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED:db_password]');
    // The key itself was redacted too.
    expect(Object.keys(out as object)).toContain('[REDACTED:db_password]');
  });

  it('names the label and never leaks a prefix or suffix of the value', () => {
    const r = new Redactor();
    r.register(SECRET, 'db_password');
    const out = r.redactString(SECRET);
    expect(out).toBe('[REDACTED:db_password]');
    expect(out).not.toContain('hunter');
    expect(out).not.toContain('staple');
  });

  it('redacts the longer secret when two registered values overlap', () => {
    const r = new Redactor();
    r.register('abcdefgh', 'short');
    r.register('abcdefgh-ijklmnop', 'long');
    expect(r.redactString('value abcdefgh-ijklmnop end')).toBe('value [REDACTED:long] end');
  });

  it('ignores values too short to redact safely', () => {
    const r = new Redactor();
    r.register('abc', 'tiny');
    // Redacting "abc" would shred every unrelated word containing it.
    expect(r.redactString('abc is a substring of abcdef')).toBe('abc is a substring of abcdef');
  });

  it('finds a secret split across two separate fields', () => {
    const r = new Redactor();
    r.register('AAAAAAAAAAAA', 'half_a');
    r.register('BBBBBBBBBBBB', 'half_b');
    const out = JSON.stringify(r.redact({ a: 'x AAAAAAAAAAAA y', b: { c: 'BBBBBBBBBBBB' } }));
    expect(out).not.toContain('AAAAAAAAAAAA');
    expect(out).not.toContain('BBBBBBBBBBBB');
  });
});

describe('redaction by pattern', () => {
  const cases: Array<[string, string]> = [
    ['sk-abcdefghijklmnopqrstuvwxyz0123', 'openai_key'],
    ['ghp_0123456789abcdefghijklmnopqrstuvwx', 'github_token'],
    ['Bearer abcdefghijklmnopqrstuvwxyz012345', 'bearer_token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
    ['xoxb-1234567890-abcdefghijkl', 'slack_token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gF', 'jwt'],
  ];

  it.each(cases)('redacts %s as %s', (value, label) => {
    const r = new Redactor();
    const out = r.redactString(`token is ${value} ok`);
    expect(out).not.toContain(value);
    expect(out).toContain(`[REDACTED:${label}]`);
  });

  it('redacts a PEM private key block entirely', () => {
    const r = new Redactor();
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nabcdef\n-----END RSA PRIVATE KEY-----`;
    const out = r.redactString(`key:\n${pem}\nafter`);
    expect(out).not.toContain('MIIBOgIBAAJBAK');
    expect(out).toContain('[REDACTED:private_key]');
    expect(out).toContain('after');
  });

  it('strips credentials from a URL without destroying the host', () => {
    const r = new Redactor();
    const out = r.redactString('https://admin:s3cretpassword@internal.example.com/path');
    expect(out).not.toContain('s3cretpassword');
    expect(out).toContain('internal.example.com/path');
  });
});

describe('redaction is not optional', () => {
  it('is applied by append() itself, so no call site can skip it', () => {
    const s = createTestSubstrate();
    s.redactor.register(SECRET, 'db_password');

    s.events.append({
      type: 'message.user',
      payload: { text: `my password is ${SECRET}`, attachments: [] },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    const stored = s.storage.get<{ payload: string }>('SELECT payload FROM events WHERE seq = 1');
    expect(stored?.payload).not.toContain(SECRET);
    expect(stored?.payload).toContain('[REDACTED:db_password]');
    s.close();
  });

  it('survives a fuzz of 500 payload shapes with a planted secret', () => {
    const r = new Redactor();
    r.register(SECRET, 'planted');
    let rng = 12345;
    const next = (n: number): number => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng % n;
    };
    const build = (depth: number): unknown => {
      if (depth > 3) return next(2) === 0 ? SECRET : 'benign';
      switch (next(4)) {
        case 0:
          return [build(depth + 1), build(depth + 1)];
        case 1:
          return { a: build(depth + 1), [`k${next(5)}`]: build(depth + 1) };
        case 2:
          return `prefix-${SECRET}-suffix`;
        default:
          return { only: build(depth + 1) };
      }
    };
    for (let i = 0; i < 500; i++) {
      const payload = build(0);
      expect(JSON.stringify(r.redact(payload))).not.toContain(SECRET);
    }
  });
});
