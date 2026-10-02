import { afterEach, describe, expect, it, vi } from 'vitest';
import * as types from '../../src/substrate/events/types.js';
import { upcast, withUpcasters } from '../../src/substrate/events/migrations/index.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

/**
 * Upcasters are the mechanism that lets a 2026 event be readable by a 2036
 * build without ever rewriting the row. The test has to exist before the first
 * real schema change, so it uses a simulated one: `session.titled` is pretended
 * to have moved v1 → v3.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function pretendCurrentVersion(type: types.EventType, version: number): void {
  vi.spyOn(types, 'currentVersionOf').mockImplementation((t) => (t === type ? version : 1));
}

describe('upcasters', () => {
  it('reads a v1 payload through to the current version', () => {
    pretendCurrentVersion('session.titled', 2);
    withUpcasters(
      [['session.titled', 1, (p) => ({ title: (p as { name: string }).name })]],
      () => {
        const out = upcast('session.titled', 1, { name: 'old shape' });
        expect(out.payload).toEqual({ title: 'old shape' });
        expect(out.from).toBe(1);
        expect(out.to).toBe(2);
      },
    );
  });

  it('composes across two versions', () => {
    pretendCurrentVersion('session.titled', 3);
    withUpcasters(
      [
        ['session.titled', 1, (p) => ({ title: (p as { name: string }).name })],
        ['session.titled', 2, (p) => ({ ...(p as object), titleVersion: 2 })],
      ],
      () => {
        expect(upcast('session.titled', 1, { name: 'x' }).payload).toEqual({
          title: 'x',
          titleVersion: 2,
        });
      },
    );
  });

  it('returns a current-version payload untouched', () => {
    const payload = { title: 'already current' };
    const out = upcast('session.titled', 1, payload);
    expect(out.payload).toBe(payload);
  });

  it('refuses a payload from a future version rather than guessing', () => {
    expect(() => upcast('session.titled', 9, {})).toThrow(/only understands v1/);
  });

  it('reports a missing step instead of silently skipping it', () => {
    pretendCurrentVersion('session.titled', 2);
    expect(() => upcast('session.titled', 1, {})).toThrow(/missing upcaster for session.titled v1/);
  });

  it('never writes: the stored row is still v1 after being read', () => {
    const s = createTestSubstrate();
    s.events.append({
      type: 'session.titled',
      payload: { title: 'kept' },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    pretendCurrentVersion('session.titled', 2);
    withUpcasters([['session.titled', 1, (p) => ({ ...(p as object), upcast: true })]], () => {
      const read = s.events.bySeq(1);
      expect(read?.payload).toMatchObject({ upcast: true });
    });

    const row = s.storage.get<{ schema_version: number; payload: string }>(
      'SELECT schema_version, payload FROM events WHERE seq = 1',
    );
    expect(row?.schema_version).toBe(1);
    expect(row?.payload).toBe('{"title":"kept"}');
    s.close();
  });

  it('keeps the hash chain valid across a schema migration', () => {
    // The chain hashes the bytes that were written. Upcasting on read must not
    // make historical events look tampered with.
    const s = createTestSubstrate();
    s.events.append({
      type: 'session.titled',
      payload: { title: 'v1 era' },
      principal: 'user:ara',
      trust: 'USER',
      sessionId: 'sess-1',
    });

    pretendCurrentVersion('session.titled', 2);
    withUpcasters([['session.titled', 1, (p) => ({ ...(p as object), migrated: true })]], () => {
      const result = s.events.verifyChain();
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
    s.close();
  });
});
