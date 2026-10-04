import { describe, expect, it } from 'vitest';
import { FirewallError, MIN_SCANNABLE, enforce, inspect, type KnownSecret } from '../../src/security/firewall.js';

const SECRET = 'sk-live-9f3a2b7c4e1d8a6f';
const OTHER = 'ghp_AbCdEf0123456789XyZ';
const secrets: KnownSecret[] = [
  { reference: 'secret://stripe/v3', value: SECRET },
  { reference: 'secret://github/v1', value: OTHER },
];

describe('§23 the firewall catches the obvious case', () => {
  it('passes a clean body', () => {
    expect(inspect('{"prompt":"summarise my week"}', secrets)).toEqual({ ok: true });
  });

  it('refuses a direct hit and reports the offset', () => {
    const verdict = inspect(`{"auth":"Bearer ${SECRET}"}`, secrets);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.hits).toHaveLength(1);
    expect(verdict.hits[0]?.reference).toBe('secret://stripe/v3');
    expect(verdict.hits[0]?.atOffset).toBeGreaterThan(0);
  });

  it('reports every hit in one pass, so one fix clears the body', () => {
    const verdict = inspect(`a=${SECRET}&b=${OTHER}`, secrets);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.hits.map((h) => h.reference).sort()).toEqual(['secret://github/v1', 'secret://stripe/v3']);
  });
});

describe('§23 it catches the evasions', () => {
  it('a secret split across JSON fields', () => {
    // No literal substring of the body equals the secret.
    const body = `{"a":"sk-live-9f3a2b","b":"7c4e1d8a6f"}`;
    expect(body).not.toContain(SECRET);
    expect(inspect(body, secrets).ok).toBe(false);
  });

  it('a secret split across lines', () => {
    expect(inspect(`sk-live-9f3a2b\n7c4e1d8a6f`, secrets).ok).toBe(false);
  });

  it('a secret broken up by whitespace', () => {
    expect(inspect(`sk-live-9f3a 2b7c 4e1d 8a6f`, secrets).ok).toBe(false);
  });

  it('a secret inside a JSON string array', () => {
    expect(inspect(`["sk-live-", "9f3a2b7c4e1d8a6f"]`, secrets).ok).toBe(false);
  });
});

describe('§23 the refusal itself must not leak', () => {
  it('no part of the secret appears anywhere in the verdict', () => {
    const verdict = inspect(`{"auth":"${SECRET}"}`, secrets);
    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toContain(SECRET);
    // Not even a fragment: slide a window across the secret.
    for (let i = 0; i + 6 <= SECRET.length; i++) {
      expect(serialized, `leaked fragment at ${i}`).not.toContain(SECRET.slice(i, i + 6));
    }
    expect(serialized).toContain('secret://stripe/v3');
  });

  it('the thrown error leaks nothing either, including its stack', () => {
    try {
      enforce(`{"auth":"${SECRET}"}`, secrets);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FirewallError);
      const e = error as FirewallError;
      expect(`${e.name}${e.message}${e.stack ?? ''}${JSON.stringify(e.hits)}`).not.toContain(SECRET);
      expect(e.message).toContain('secret://stripe/v3');
    }
  });

  it('refuses rather than redacting — there is no sanitised body to send', () => {
    // If this ever returns a cleaned string, §23 has been inverted.
    const verdict = inspect(`x ${SECRET}`, secrets) as Record<string, unknown>;
    expect(Object.keys(verdict).sort()).toEqual(['hits', 'message', 'ok']);
    expect(verdict).not.toHaveProperty('redacted');
    expect(verdict).not.toHaveProperty('body');
  });
});

describe('§23 it does not cry wolf', () => {
  it(`ignores values shorter than MIN_SCANNABLE (${MIN_SCANNABLE})`, () => {
    const short: KnownSecret[] = [{ reference: 'secret://pin/v1', value: 'the' }];
    expect(inspect('the quick brown fox jumps over the lazy dog', short).ok).toBe(true);
  });

  it('a secret at exactly MIN_SCANNABLE is scanned', () => {
    const value = 'a'.repeat(MIN_SCANNABLE);
    expect(inspect(`prefix ${value} suffix`, [{ reference: 'secret://edge/v1', value }]).ok).toBe(false);
  });

  it('an empty secret list is a pass, not a crash', () => {
    expect(inspect(`{"auth":"${SECRET}"}`, []).ok).toBe(true);
  });

  it('an empty body is a pass', () => {
    expect(inspect('', secrets).ok).toBe(true);
  });

  it('does not match a secret that merely shares a prefix', () => {
    expect(inspect('sk-live-0000000000000000', secrets).ok).toBe(true);
  });
});
