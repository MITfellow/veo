/**
 * Judgment and remedy (§25, L4).
 *
 * `judge()` is pure: a document plus evidence in, a list of verdicts out. It
 * does no I/O, emits no events and mutates nothing, which is what lets the
 * interesting cases be tested as a table instead of through a live runner.
 *
 * `remedyFor()` decides what to *do* about a violation, and the three
 * options are not interchangeable:
 *
 *   annotate  the answer stands, with a visible note appended. Right for
 *             honesty failures where the content is still useful and the
 *             user deserves to know the agent broke its own rule.
 *   revise    one regeneration, with the violated article quoted back. Right
 *             for style and for claims the model can simply restate
 *             correctly. Exactly once — a loop here is a loop that bills.
 *   block     the output is replaced by a refusal naming the article. Right
 *             only where shipping the text is itself the harm.
 *
 * The annotation is deliberately plain and unapologetic. Hiding a
 * self-detected violation to preserve the illusion of competence is the same
 * move as fabricated intimacy: it protects the agent's image at the user's
 * expense.
 */
import { CHECKS, type RunEvidence, type Verdict } from './checks.js';
import type { Constitution, Remedy, StoredArticle } from './types.js';

export interface ArticleVerdict {
  articleId: string;
  check: string;
  verdict: Verdict;
  detail: string;
}

export interface Judgment {
  verdicts: readonly ArticleVerdict[];
  violations: readonly ArticleVerdict[];
  /** The strongest remedy any violated article asks for. */
  remedy: Remedy;
  /** Article ids whose remedy requires the stream to be buffered. */
  blocking: readonly string[];
}

const REMEDY_STRENGTH: Record<Remedy, number> = {
  none: 0,
  annotate: 1,
  revise: 2,
  block: 3,
};

/** Articles that can stop or rewrite an answer, and so force buffering. */
export function blockingArticles(doc: Constitution): readonly StoredArticle[] {
  return doc.live.filter(
    (a) => a.enforcement === 'checked' && (a.remedy === 'revise' || a.remedy === 'block'),
  );
}

export function judge(doc: Constitution, evidence: RunEvidence): Judgment {
  const verdicts: ArticleVerdict[] = [];

  for (const article of doc.live) {
    if (article.enforcement !== 'checked' || article.check === null) continue;
    // A superseded article is still rendered (so the model can see the
    // override) but is no longer enforced: the user's instruction won, and
    // continuing to screen against the thing they overrode would make the
    // override cosmetic.
    if (article.supersededBy !== undefined) continue;

    const check = CHECKS[article.check];
    if (check === undefined) {
      verdicts.push({
        articleId: article.id,
        check: article.check,
        verdict: 'unverifiable',
        detail: `check '${article.check}' is not registered`,
      });
      continue;
    }
    const result = check.run(evidence);
    verdicts.push({
      articleId: article.id,
      check: check.id,
      verdict: result.verdict,
      detail: result.detail,
    });
  }

  const violations = verdicts.filter((v) => v.verdict === 'violated');
  let remedy: Remedy = 'none';
  for (const v of violations) {
    const article = doc.live.find((a) => a.id === v.articleId);
    const want = article?.remedy ?? 'none';
    if (REMEDY_STRENGTH[want] > REMEDY_STRENGTH[remedy]) remedy = want;
  }

  return {
    verdicts,
    violations,
    remedy,
    blocking: blockingArticles(doc).map((a) => a.id),
  };
}

/** The note appended by `annotate`. Short, specific, and in the agent's voice. */
export function annotationFor(doc: Constitution, violations: readonly ArticleVerdict[]): string {
  if (violations.length === 0) return '';
  const lines = violations.map((v) => {
    const article = doc.live.find((a) => a.id === v.articleId);
    return `- ${v.articleId}: ${article?.text ?? v.check} (${v.detail})`;
  });
  return `\n\n---\nI broke my own rules in that answer:\n${lines.join('\n')}`;
}

/** The refusal `block` substitutes for the answer. */
export function blockMessageFor(doc: Constitution, violations: readonly ArticleVerdict[]): string {
  const first = violations[0];
  const article = first ? doc.live.find((a) => a.id === first.articleId) : undefined;
  return (
    `I stopped myself from sending that answer. It conflicted with ` +
    `${first?.articleId ?? 'one of my articles'}: "${article?.text ?? ''}" ` +
    `(${first?.detail ?? ''}). Tell me how you want to proceed and I will try again.`
  );
}

/**
 * What the user is told when the rewrite did not clear the article.
 *
 * Decision 042: a second violation is disclosed rather than hidden or
 * escalated to a refusal. The article's author chose `revise` over
 * `block`, and those are different severities — but shipping the text
 * without saying anything is the bug that decision exists to fix.
 */
export function revisionFailedNoteFor(
  doc: Constitution,
  violations: readonly ArticleVerdict[],
): string {
  const first = violations[0];
  const article = first ? doc.live.find((a) => a.id === first.articleId) : undefined;
  return (
    `\n\n(I rewrote that once because it conflicted with ${first?.articleId ?? 'one of my articles'}` +
    `${article === undefined ? '' : `: "${article.text}"`}, and the rewrite still ` +
    `${first?.detail ?? 'conflicts'}. You are reading it anyway rather than nothing at all, ` +
    `but I did not manage to fix it.)`
  );
}

/** The instruction handed back to the model for a single `revise` attempt. */
export function revisionPromptFor(
  doc: Constitution,
  violations: readonly ArticleVerdict[],
): string {
  const lines = violations.map((v) => {
    const article = doc.live.find((a) => a.id === v.articleId);
    return `${v.articleId}: "${article?.text ?? ''}" — you ${v.detail}.`;
  });
  return (
    `Your previous draft violated your constitution and was not sent. ` +
    `${lines.join(' ')} Write the answer again, keeping everything that was ` +
    `correct and fixing only the violation. Do not apologise for the draft; ` +
    `the user never saw it.`
  );
}
