import { describe, expect, it } from 'vitest';
import { createRedactor, redact, REDACTED } from '../../src/substrate/events/redact.js';

describe('redaction', () => {
  it('removes a registered secret wherever it appears', () => {
    const r = createRedactor({ secrets: ['hunter2-very-secret'] });
    const out = redact(
      { note: 'the key is hunter2-very-secret ok', nested: [{ deep: 'hunter2-very-secret' }] },
      r,
    );
    expect(JSON.stringify(out)).not.toContain('hunter2-very-secret');
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it('scrubs known-sensitive field names regardless of content', () => {
    const out = redact({ password: 'abc', apiKey: 'xyz', keep: 'visible' }, createRedactor());
    expect(out).toEqual({ password: REDACTED, apiKey: REDACTED, keep: 'visible' });
  });

  it('preserves structure so a reader can still see the shape', () => {
    const out = redact({ a: { b: [1, 2, { c: 'x' }] } }, createRedactor()) as Record<string, unknown>;
    expect(out).toEqual({ a: { b: [1, 2, { c: 'x' }] } });
  });

  it('ignores secrets too short to scrub safely', () => {
    // Redacting every "ab" would shred unrelated prose into noise.
    const out = redact({ text: 'a cab is abuzz' }, createRedactor({ secrets: ['ab'] }));
    expect(out).toEqual({ text: 'a cab is abuzz' });
  });
});
