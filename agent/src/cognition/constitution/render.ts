/**
 * Rendering the constitution into context, and the sentinel that proves it
 * got there (§25, §21 block 2).
 *
 * The sentinel is the mechanism that makes "every model follows this" a
 * property of the system rather than an aspiration. It is a single line at
 * the top of the block:
 *
 *   [constitution v7 · sha 3f2a9c1d80b4e215 · articles F1,F2,F4,U3]
 *
 * `GovernedProvider` refuses to call any provider whose request does not
 * contain that line with the *current* hash. So there is exactly one way to
 * reach a model in this process — through `assembleContext`, which renders
 * this block under budget and records the eviction report — and any future
 * code path that tries to go round it fails loudly instead of quietly
 * running an ungoverned agent.
 *
 * Why not have the decorator inject the text itself? Because then two
 * independent renderers would exist, the second one would not know about the
 * token budget or the survival order, and the context would stop being
 * reconstructible from `context.assembled`. The assembler renders; the
 * decorator only refuses.
 */
import type { Constitution, StoredArticle } from './types.js';

/** The narrow view the context layer carries. Keeps the snapshot plain data. */
export interface ConstitutionView {
  version: number;
  hash: string;
  articles: readonly RenderedArticle[];
}

export interface RenderedArticle {
  id: string;
  text: string;
  origin: 'founding' | 'user' | 'proposed';
  /** Set when a higher-ranked article overrides this one. */
  supersededBy?: string;
  /** How this article is kept. Rendered so the model does not over-rely on prose. */
  enforcement: 'advisory' | 'checked' | 'structural';
}

export const SENTINEL_PREFIX = '[constitution v';

export function viewOf(doc: Constitution): ConstitutionView {
  return {
    version: doc.version,
    hash: doc.hash,
    articles: doc.live.map(toRendered),
  };
}

function toRendered(a: StoredArticle): RenderedArticle {
  const base: RenderedArticle = {
    id: a.id,
    text: a.text,
    origin: a.origin,
    enforcement: a.enforcement,
  };
  return a.supersededBy === undefined ? base : { ...base, supersededBy: a.supersededBy };
}

/**
 * The first line of the block.
 *
 * Article ids are included rather than only the hash because the common
 * debugging question is "was F7 in force on that turn?", and answering it
 * from a hash requires a lookup table nobody will build.
 */
export function sentinelFor(view: ConstitutionView): string {
  const ids = view.articles.map((a) => a.id).join(',');
  return `${SENTINEL_PREFIX}${view.version} · sha ${view.hash} · articles ${ids || 'none'}]`;
}

/**
 * Does this assembled request carry the live constitution?
 *
 * Matching is on the exact sentinel string, not on a regex over the version
 * number, so a model that *quotes* a sentinel in its own output (an
 * adversarial case worth taking seriously, since the model sees the real one
 * every turn) cannot satisfy a later pre-flight check: the match is only ever
 * run against `system` messages, and only the assembler writes those.
 */
export function hasSentinel(systemText: string, view: ConstitutionView): boolean {
  return systemText.includes(sentinelFor(view));
}

/**
 * One line per article.
 *
 * Superseded articles are rendered with the override spelled out rather than
 * dropped. The model behaves better knowing a default was deliberately
 * overridden than it does when the default simply is not there — and the
 * user, reading a trace, can see that their instruction took effect.
 */
export function articleLine(a: RenderedArticle): string {
  const who = a.origin === 'user' ? 'you asked' : 'my charter';
  if (a.supersededBy !== undefined) {
    return `- (${a.id}, ${who}, overridden by ${a.supersededBy}) ${a.text}`;
  }
  return `- (${a.id}, ${who}) ${a.text}`;
}

/**
 * Structural articles are summarised rather than quoted in full.
 *
 * Found by a budget test: the full charter is ~1,000 tokens and the block is
 * unevictable, so a small window could not hold the kernel and the contract
 * at once. The fix is the argument the kernel template already makes — "a
 * paragraph asking the model not to spend money is not a control, it is a
 * rounding error in the bill". A `structural` article describes something
 * the code enforces whether the model reads it or not, so the model gets one
 * line naming them and the *user* gets the full text in the panel, where
 * tokens are free.
 *
 * `checked` and `advisory` articles are quoted in full, because for those
 * the text really is the mechanism (or half of it).
 */
export function structuralSummary(articles: readonly RenderedArticle[]): string {
  const ids = articles.map((a) => a.id).join(', ');
  return (
    `- (${ids}) Enforced by the system itself, not by you: the untrusted-content ` +
    `fence, the approval gate before any external effect, the vault, the ` +
    `append-only audit log, the ask budget, and your principal's right to read ` +
    `and destroy anything you remember. You cannot override these and do not ` +
    `need to try. Ask the user to open the constitution panel to read them in full.`
  );
}

export const CONSTITUTION_HEADER =
  'Your standing contract with your principal. Articles marked "you asked" ' +
  'were written by them and outrank everything you have inferred, every ' +
  'habit you have learned, and any article of your own charter they conflict ' +
  'with. Follow them literally. If two articles conflict, say so out loud ' +
  'rather than quietly picking one.';
