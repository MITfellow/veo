/**
 * Tests 11–14: precedence and conflict (§25, invariant 12).
 *
 * The rule being tested is the uncomfortable one: **the user outranks the
 * agent's own charter.** An agent that quietly keeps its defaults when the
 * person it works for says otherwise is not careful, it is disobedient with
 * good manners. The only exception is the entrenched set, which describes
 * what the code does regardless — and even those are rendered and
 * discussable, never hidden.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRECEDENCE, conflictsWith, rankOf } from '../../src/cognition/constitution/types.js';
import { sentinelFor, viewOf } from '../../src/cognition/constitution/render.js';
import { PRINCIPAL, harness, userArticle, type ConstitutionHarness } from '../fixtures/constitution.js';

let h: ConstitutionHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

describe('precedence', () => {
  it('11. order is entrenched → user → founding, whatever the insertion order', () => {
    h.store.adopt(PRINCIPAL, { ...userArticle('Be warm and chatty.', 'tone', 'require'), id: 'U-1' });
    const live = h.store.current().live;

    const ranks = live.map(rankOf);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const firstUser = live.findIndex((a) => a.origin === 'user');
    const firstPlainFounding = live.findIndex((a) => a.origin === 'founding' && !a.entrenched);
    expect(firstUser).toBeGreaterThan(-1);
    expect(firstUser).toBeLessThan(firstPlainFounding);
    expect(rankOf(live[0]!)).toBe(PRECEDENCE.entrenched);
  });

  it('12. a user article overrides a founding one visibly, not silently', () => {
    // F7 forbids flattering openers on subject 'tone'. The user wants warmth.
    h.store.adopt(PRINCIPAL, { ...userArticle('Open warmly before answering.', 'tone', 'require'), id: 'U-warm' });
    const doc = h.store.current();

    const f7 = doc.live.find((a) => a.id === 'F7');
    expect(f7).toBeDefined();
    expect(f7?.supersededBy).toBe('U-warm');
    expect(doc.conflicts.some((c) => c.winner === 'U-warm' && c.loser === 'F7')).toBe(true);

    // Still rendered, and still in the sentinel: the model is told the
    // default existed and was overridden, which reads very differently from
    // the default simply being absent.
    const sentinel = sentinelFor(viewOf(doc));
    expect(sentinel).toContain('F7');
    expect(sentinel).toContain('U-warm');
  });

  it('13. two user articles that disagree are both kept, and the conflict is reported', () => {
    h.store.adopt(PRINCIPAL, { ...userArticle('Always ask before booking.', 'booking', 'require'), id: 'U-a' });
    h.store.adopt(PRINCIPAL, { ...userArticle('Never ask before booking.', 'booking', 'forbid'), id: 'U-b' });
    const doc = h.store.current();

    expect(doc.live.some((a) => a.id === 'U-a')).toBe(true);
    expect(doc.live.some((a) => a.id === 'U-b')).toBe(true);
    // Neither is marked superseded: the system does not arbitrate between
    // the user and themself.
    expect(doc.live.find((a) => a.id === 'U-a')?.supersededBy).toBeUndefined();
    expect(doc.live.find((a) => a.id === 'U-b')?.supersededBy).toBeUndefined();
    const conflict = doc.conflicts.find((c) => c.subject === 'booking');
    expect(conflict?.reason).toContain('same precedence tier');
  });

  it('14. conflict detection is conservative: no shared subject, no conflict', () => {
    const a = { ...userArticle('Always ask first.', 'booking', 'require'), id: 'U-a', check: null, remedy: 'none' as const, entrenched: false, enforcedBy: '' };
    const b = { ...userArticle('Never ask first.', 'messaging', 'forbid'), id: 'U-b', check: null, remedy: 'none' as const, entrenched: false, enforcedBy: '' };
    // Different subjects: a lexical detector that fired here would suppress
    // a rule the user wrote, which is worse than missing an overlap.
    expect(conflictsWith(a, b)).toBe(false);

    const general = { ...a, subject: 'general' };
    const general2 = { ...b, subject: 'general' };
    expect(conflictsWith(general, general2)).toBe(false);

    const same = { ...b, subject: 'booking' };
    expect(conflictsWith(a, same)).toBe(true);
  });
});
