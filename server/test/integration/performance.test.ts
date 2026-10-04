import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../fakes/substrate.js';

/**
 * §57 performance budgets, measured on the real SQLite path.
 *
 * These use the wall clock deliberately — they are the one place a real
 * duration is the subject of the test rather than a nuisance. The thresholds
 * are the spec's, with no slack added: if the sandbox cannot meet them the
 * right response is to learn that now, not to widen the budget.
 */
describe('§57 performance budgets', () => {
  it('event append stays under 2 ms', () => {
    const s = createTestSubstrate();
    const n = 2000;
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      s.clock.advance(5);
      s.events.append({
        type: 'capture.received', actor: 'user:ara', trust: 'FOREIGN',
        payload: { captureId: `c${i}`, source: 'paste', kind: 'text', content: `blob ${i}` },
      });
    }
    const perAppend = (performance.now() - started) / n;
    expect(perAppend).toBeLessThan(2);
    s.close();
  });

  it('a projection query over 10k events stays under 100 ms', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 10_000; i++) {
      s.clock.advance(1000);
      const sid = `s${i % 200}`;
      if (i % 200 < 1) {
        s.events.append({ type: 'session.started', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { channel: 'veo' } });
      } else {
        s.events.append({ type: 'message.received', actor: 'user:ara', trust: 'USER', sessionId: sid, payload: { messageId: `m${i}`, role: 'user', content: `msg ${i}` } });
      }
    }
    const started = performance.now();
    const rows = s.storage.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 50').all('s5');
    const elapsed = performance.now() - started;
    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
    s.close();
  });

  it('a filtered log read over 10k events stays under 100 ms', () => {
    const s = createTestSubstrate();
    for (let i = 0; i < 10_000; i++) {
      s.clock.advance(100);
      s.events.append({ type: 'capture.received', actor: 'user:ara', trust: 'FOREIGN', sessionId: `s${i % 50}`, payload: { captureId: `c${i}`, source: 'paste', kind: 'text', content: `x${i}` } });
    }
    const started = performance.now();
    const rows = s.events.read({ sessionId: 's7', limit: 100 });
    expect(performance.now() - started).toBeLessThan(100);
    expect(rows.length).toBe(100);
    s.close();
  });
});
