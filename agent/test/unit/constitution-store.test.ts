/**
 * Tests 1–10: the document (§25).
 *
 * The property under test throughout is *answerability*. §25 promises that
 * "the agent started talking differently on this date, because of this" is
 * always answerable, and every test here is a way of asking that question:
 * what was in force then, who changed it, what did it say before, and does
 * the answer survive dropping every table and replaying the log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArticleSchema, EntrenchedArticleError } from '../../src/cognition/constitution/types.js';
import { ENTRENCHED_IDS, FOUNDING_ARTICLES } from '../../src/cognition/constitution/founding.js';
import { ConstitutionStore } from '../../src/cognition/constitution/store.js';
import { DAY, PRINCIPAL, harness, userArticle, type ConstitutionHarness } from '../fixtures/constitution.js';

let h: ConstitutionHarness;
beforeEach(() => {
  h = harness({ founding: false });
});
afterEach(() => {
  h.close();
});

describe('the founding charter arrives ratified, through the log', () => {
  it('1. first boot ratifies version 1 and records every article id', () => {
    const doc = h.store.ensureFounding(PRINCIPAL);
    expect(doc.version).toBe(1);
    expect(doc.live.length).toBe(FOUNDING_ARTICLES.length);

    const ratified = h.substrate.events.read({ types: ['constitution.ratified'] });
    expect(ratified).toHaveLength(1);
    const payload = ratified[0]!.payload as { articles: { id: string }[] };
    expect(payload.articles.map((a) => a.id)).toEqual(FOUNDING_ARTICLES.map((a) => a.id));

    // Idempotent: a second boot must not re-ratify, or every restart would
    // look like a change of terms.
    h.store.ensureFounding(PRINCIPAL);
    expect(h.substrate.events.read({ types: ['constitution.ratified'] })).toHaveLength(1);
  });

  it('2. the schema refuses an article that lies about how it is kept', () => {
    expect(ArticleSchema.safeParse({ ...base(), text: '' }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...base(), id: '' }).success).toBe(false);
    expect(ArticleSchema.safeParse({ ...base(), enforcement: 'vibes' }).success).toBe(false);

    // Checked but naming no check: the compliance panel would report a rule
    // nobody runs as "upheld, 100%".
    const noCheck = ArticleSchema.safeParse({ ...base(), enforcement: 'checked' });
    expect(noCheck.success).toBe(false);
    expect(JSON.stringify(noCheck.error?.issues)).toContain('names no check');

    // Advisory but naming one: the opposite lie.
    const orphan = ArticleSchema.safeParse({
      ...base(),
      enforcement: 'advisory',
      check: 'no-position-flip',
    });
    expect(orphan.success).toBe(false);
    expect(JSON.stringify(orphan.error?.issues)).toContain('nothing would run it');

    // Structural without naming the module that enforces it.
    const vague = ArticleSchema.safeParse({ ...base(), enforcement: 'structural' });
    expect(vague.success).toBe(false);
    expect(JSON.stringify(vague.error?.issues)).toContain('does not say which');
  });
});

describe('amendment', () => {
  beforeEach(() => {
    h.store.ensureFounding(PRINCIPAL);
  });

  it('3. an amendment is an event, bumps the version, and keeps the old text readable', () => {
    const before = h.store.current().version;
    h.clock.advance(DAY);
    const doc = h.store.adopt(PRINCIPAL, { ...userArticle('Be blunt with me.'), id: 'U-1' });
    expect(doc.version).toBe(before + 1);

    const events = h.substrate.events.read({ types: ['constitution.amended'] });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { change: string; author: string; before: unknown };
    expect(payload.change).toBe('added');
    expect(payload.author).toBe(PRINCIPAL);
    expect(payload.before).toBeNull();

    h.clock.advance(DAY);
    h.store.adopt(PRINCIPAL, { ...userArticle('Be blunt, and short.'), id: 'U-1' });
    const edits = h.substrate.events.read({ types: ['constitution.amended'] });
    const edit = edits[1]!.payload as { change: string; before: { text: string } | null };
    expect(edit.change).toBe('edited');
    expect(edit.before?.text).toBe('Be blunt with me.');
  });

  it('4. at(ts) answers with the document that was in force then', () => {
    const t0 = h.clock.now();
    h.clock.advance(DAY);
    h.store.adopt(PRINCIPAL, { ...userArticle('Never use bullet points.'), id: 'U-9' });
    const t1 = h.clock.now();

    expect(h.store.at(t0).live.some((a) => a.id === 'U-9')).toBe(false);
    expect(h.store.at(t0).live.length).toBe(FOUNDING_ARTICLES.length);
    expect(h.store.at(t1).live.some((a) => a.id === 'U-9')).toBe(true);
  });

  it('5. an entrenched article cannot be repealed, and the refusal says why', () => {
    const target = ENTRENCHED_IDS[0]!;
    const versionBefore = h.store.current().version;
    expect(() => h.store.repeal(PRINCIPAL, target)).toThrow(EntrenchedArticleError);
    try {
      h.store.repeal(PRINCIPAL, target);
    } catch (error) {
      // The refusal has to carry the reason, or it is indistinguishable
      // from a bug: it cites the spec clause the article descends from.
      expect((error as EntrenchedArticleError).cites).toContain('§');
      expect((error as Error).message).toContain('enforces in code');
    }
    expect(h.store.current().version).toBe(versionBefore);
    expect(h.substrate.events.read({ types: ['constitution.amended'] })).toHaveLength(0);
  });

  it('6. a user article can be repealed and survives in history', () => {
    h.store.adopt(PRINCIPAL, { ...userArticle('Call me Ara.'), id: 'U-2' });
    h.clock.advance(DAY);
    h.store.repeal(PRINCIPAL, 'U-2');

    expect(h.store.current().live.some((a) => a.id === 'U-2')).toBe(false);
    const stored = h.store.article('U-2');
    expect(stored?.repealedAt).not.toBeNull();
    expect(stored?.text).toBe('Call me Ara.');
    expect(h.store.history().some((v) => v.change === 'repealed' && v.articleId === 'U-2')).toBe(true);
  });

  it('7. the hash moves on amendment and is stable across a reload', () => {
    const first = h.store.current().hash;
    h.store.adopt(PRINCIPAL, { ...userArticle('Answer in metric units.'), id: 'U-3' });
    const second = h.store.current().hash;
    expect(second).not.toBe(first);

    const reopened = new ConstitutionStore({
      storage: h.substrate.storage,
      events: h.substrate.events,
      clock: h.clock,
      ids: h.substrate.ids,
    });
    expect(reopened.current().hash).toBe(second);
  });

  it('8. dropping the projection and replaying rebuilds the same document (§34.2)', () => {
    h.store.adopt(PRINCIPAL, { ...userArticle('Never schedule anything on a Sunday.'), id: 'U-4' });
    h.store.adopt(PRINCIPAL, { ...userArticle('Use short paragraphs.'), id: 'U-5' });
    h.store.repeal(PRINCIPAL, 'U-5');
    const before = h.store.current();

    h.substrate.events.rebuild();
    const after = h.store.current();

    expect(after.hash).toBe(before.hash);
    expect(after.version).toBe(before.version);
    expect(after.live.map((a) => a.id)).toEqual(before.live.map((a) => a.id));
    expect(after.live.map((a) => a.text)).toEqual(before.live.map((a) => a.text));
  });
});

describe('proposals: the agent may suggest and may never adopt', () => {
  beforeEach(() => {
    h.store.ensureFounding(PRINCIPAL);
  });

  it('9. a proposal changes nothing until a principal ratifies it', () => {
    const hashBefore = h.store.current().hash;
    const proposal = h.store.propose(
      PRINCIPAL,
      userArticle('Always summarise long answers first.'),
      'you have reworded my answers this way four times',
      'rule-7',
    );
    expect(proposal).not.toBeNull();
    expect(h.store.current().hash).toBe(hashBefore);
    expect(h.store.proposals('pending')).toHaveLength(1);

    h.store.ratifyProposal(PRINCIPAL, proposal!.id);
    expect(h.store.current().hash).not.toBe(hashBefore);
    expect(h.store.proposals('pending')).toHaveLength(0);
    // Ratified articles enter as the user's, not as the agent's: the
    // authority is the signature, not the authorship.
    expect(h.store.current().live.filter((a) => a.origin === 'user')).toHaveLength(1);
  });

  it('10. a dismissed proposal cannot come back in the same words', () => {
    const first = h.store.propose(PRINCIPAL, userArticle('Always use bullet points.'), 'noticed a pattern');
    h.store.dismiss(PRINCIPAL, first!.id);

    const again = h.store.propose(PRINCIPAL, userArticle('always use bullet points'), 'noticed it again');
    expect(again).toBeNull();

    // A genuine rewrite is allowed back — "no" to one sentence is not "no"
    // forever to the whole subject.
    const different = h.store.propose(
      PRINCIPAL,
      userArticle('Lead with the recommendation, then the reasoning.'),
      'different idea',
    );
    expect(different).not.toBeNull();
  });
});

function base() {
  return {
    id: 'X1',
    text: 'something',
    origin: 'user' as const,
    kind: 'directive' as const,
    enforcement: 'advisory' as const,
  };
}
