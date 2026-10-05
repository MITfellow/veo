import { decodeEntities } from './entities.js';

/**
 * An HTML tokenizer.
 *
 * Not spec-complete — the HTML5 tokenizer is a 70-state machine — but
 * correct on the constructs that appear in documents an agent will meet,
 * and deliberately *lenient*: real pages are malformed, and a parser that
 * throws on bad input is a parser that cannot browse.
 *
 * Two behaviours matter for security rather than fidelity:
 *
 *   **`<script>` and `<style>` are raw-text elements.** Their contents are
 *   consumed to the matching close tag without tokenizing. A naive parser
 *   that tokenizes inside a script will find `<div>` in a JavaScript string
 *   and build a tree the browser never had — letting an attacker show the
 *   agent a different page than the user sees.
 *
 *   **Comments are kept.** They are not rendered, so they are the obvious
 *   place to hide an instruction. We keep them, mark them, and make sure
 *   they never reach the planner.
 */

export type Token =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string }
  | { type: 'comment'; text: string }
  | { type: 'doctype' };

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** Attribute names are case-insensitive; values keep their case. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]*)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || name.length === 0) continue;
    const raw = match[3] ?? match[4] ?? match[5] ?? '';
    // First declaration wins, matching browser behaviour on duplicates.
    if (!(name in attrs)) attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

interface Cursor {
  html: string;
  i: number;
  tokens: Token[];
}

/** Consume to the matching close tag without interpreting the contents. */
function readRawText(c: Cursor, name: string): void {
  const closeRe = new RegExp(`</${name}\\s*>`, 'i');
  const rest = c.html.slice(c.i);
  const found = closeRe.exec(rest);
  const end = found?.index ?? rest.length;
  const text = rest.slice(0, end);
  // `title` and `textarea` are escapable raw text: their content is shown
  // to a user, so entities in them are real. Script and style are not.
  if (text.length > 0) {
    c.tokens.push({ type: 'text', text: name === 'script' || name === 'style' ? text : decodeEntities(text) });
  }
  c.i += end + (found?.[0].length ?? 0);
  if (found !== undefined) c.tokens.push({ type: 'close', name });
}

function readComment(c: Cursor): void {
  const end = c.html.indexOf('-->', c.i + 4);
  const stop = end === -1 ? c.html.length : end;
  c.tokens.push({ type: 'comment', text: c.html.slice(c.i + 4, stop) });
  c.i = end === -1 ? c.html.length : end + 3;
}

function readTag(c: Cursor): void {
  const end = findTagEnd(c.html, c.i);
  const inner = c.html.slice(c.i + 1, end);
  c.i = end + 1;

  if (inner.startsWith('/')) {
    const name = /^\/\s*([^\s/>]+)/.exec(inner)?.[1]?.toLowerCase();
    if (name !== undefined) c.tokens.push({ type: 'close', name });
    return;
  }

  const nameMatch = /^([^\s/>]+)/.exec(inner);
  const name = nameMatch?.[1]?.toLowerCase();
  if (name === undefined) return;

  const selfClosing = inner.trimEnd().endsWith('/');
  const attrs = parseAttributes(inner.slice(name.length).replace(/\/\s*$/, ''));
  c.tokens.push({ type: 'open', name, attrs, selfClosing });
  if (!selfClosing && RAW_TEXT.has(name)) readRawText(c, name);
}

/**
 * Find the `>` that ends a tag, skipping any inside quoted attributes.
 *
 * `<a title="a > b">` is one tag. Scanning for the first `>` splits it and
 * produces a tree that differs from the browser's, which is exactly the
 * kind of divergence an attacker looks for.
 */
function findTagEnd(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i] as string;
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return html.length;
}

export function tokenize(html: string): Token[] {
  const c: Cursor = { html, i: 0, tokens: [] };

  while (c.i < c.html.length) {
    const lt = c.html.indexOf('<', c.i);
    if (lt === -1) {
      pushText(c, c.html.slice(c.i));
      break;
    }
    if (lt > c.i) pushText(c, c.html.slice(c.i, lt));
    c.i = lt;

    const ahead = c.html.slice(c.i, c.i + 4).toLowerCase();
    if (ahead.startsWith('<!--')) readComment(c);
    else if (ahead.startsWith('<!')) skipTo(c, '>', 'doctype');
    else if (ahead.startsWith('<?')) skipTo(c, '>', null);
    else if (/^<[a-zA-Z/]/.test(c.html.slice(c.i, c.i + 2))) readTag(c);
    else {
      // A bare `<` that is not a tag is literal text, as in `a < b`.
      pushText(c, '<');
      c.i += 1;
    }
  }
  return c.tokens;
}

function pushText(c: Cursor, raw: string): void {
  if (raw.length === 0) return;
  c.tokens.push({ type: 'text', text: decodeEntities(raw) });
}

function skipTo(c: Cursor, terminator: string, emit: 'doctype' | null): void {
  const end = c.html.indexOf(terminator, c.i);
  c.i = end === -1 ? c.html.length : end + 1;
  if (emit === 'doctype') c.tokens.push({ type: 'doctype' });
}
