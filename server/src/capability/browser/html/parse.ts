import { tokenize, type Token } from './tokenize.js';

/**
 * Tree construction.
 *
 * Browsers recover from malformed markup with a long list of specific
 * rules; we implement the handful that change the shape of real documents
 * — void elements, implied end tags, and a stack unwind that refuses to
 * pop past a boundary. Everything else nests as written.
 */

export interface ElementNode {
  type: 'element';
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: ElementNode | null;
}

export interface TextNode {
  type: 'text';
  text: string;
  parent: ElementNode | null;
}

export interface CommentNode {
  type: 'comment';
  text: string;
  parent: ElementNode | null;
}

export type Node = ElementNode | TextNode | CommentNode;

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** `<p>` and friends end when one of these begins. */
const IMPLIED_END: Readonly<Record<string, readonly string[]>> = {
  p: ['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer',
    'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p',
    'pre', 'section', 'table', 'ul'],
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  td: ['td', 'th', 'tr'],
  th: ['td', 'th', 'tr'],
  tr: ['tr'],
  option: ['option', 'optgroup'],
  optgroup: ['optgroup'],
  thead: ['tbody', 'tfoot'],
  tbody: ['tbody', 'tfoot'],
};

/** A close tag may not unwind past one of these. */
const SCOPE_BOUNDARY = new Set(['html', 'body', 'table', 'template', 'td', 'th']);

const element = (name: string, attrs: Record<string, string>, parent: ElementNode | null): ElementNode =>
  ({ type: 'element', name, attrs, children: [], parent });

function closeImplied(stack: ElementNode[], opening: string): void {
  // Pop any element whose content model cannot contain `opening`.
  for (;;) {
    const top = stack[stack.length - 1];
    if (top === undefined || stack.length <= 1) return;
    if (!(IMPLIED_END[top.name] ?? []).includes(opening)) return;
    stack.pop();
  }
}

function closeTag(stack: ElementNode[], name: string): void {
  // Find the nearest matching open element without crossing a boundary.
  for (let i = stack.length - 1; i > 0; i--) {
    const node = stack[i];
    if (node === undefined) continue;
    if (node.name === name) {
      stack.length = i;
      return;
    }
    if (SCOPE_BOUNDARY.has(node.name)) return;
  }
  // No match: a stray close tag is ignored, as browsers do.
}

function appendToken(stack: ElementNode[], token: Token): void {
  const parent = stack[stack.length - 1];
  if (parent === undefined) return;

  if (token.type === 'text') {
    parent.children.push({ type: 'text', text: token.text, parent });
    return;
  }
  if (token.type === 'comment') {
    parent.children.push({ type: 'comment', text: token.text, parent });
    return;
  }
  if (token.type === 'close') {
    closeTag(stack, token.name);
    return;
  }
  if (token.type !== 'open') return;

  closeImplied(stack, token.name);
  const holder = stack[stack.length - 1] ?? parent;
  const node = element(token.name, token.attrs, holder);
  holder.children.push(node);
  if (!token.selfClosing && !VOID.has(token.name)) stack.push(node);
}

export interface Document {
  root: ElementNode;
  title: string;
}

export function parseHtml(html: string): Document {
  const root = element('#document', {}, null);
  const stack: ElementNode[] = [root];
  for (const token of tokenize(html)) appendToken(stack, token);
  return { root, title: findTitle(root) };
}

// ────────────────────────────────────────────────────────────── traversal

export function* walk(node: Node): Generator<Node> {
  yield node;
  if (node.type === 'element') for (const child of node.children) yield* walk(child);
}

export function elements(node: Node): ElementNode[] {
  const out: ElementNode[] = [];
  for (const n of walk(node)) if (n.type === 'element') out.push(n);
  return out;
}

export function findFirst(node: Node, name: string): ElementNode | undefined {
  for (const n of walk(node)) if (n.type === 'element' && n.name === name) return n;
  return undefined;
}

function findTitle(root: ElementNode): string {
  const title = findFirst(root, 'title');
  if (title === undefined) return '';
  // Read the children directly rather than calling textOf on the element:
  // `title` is in NON_RENDERED, so textOf would correctly return '' for it.
  // The title is not body text, but it is the one piece of head content the
  // agent view legitimately needs.
  return title.children
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Elements whose text is never shown to a reader. */
const NON_RENDERED = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link']);

/**
 * Visible text.
 *
 * Comments are excluded and so is script and style content. A page's
 * *visible* text is what the user would read, and the gap between that and
 * its *source* text is where hidden instructions live.
 */
export function textOf(node: Node): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'comment') return '';
  if (NON_RENDERED.has(node.name)) return '';
  if (isHidden(node)) return '';
  return node.children.map(textOf).join('');
}

/**
 * Hidden by an inline style or attribute.
 *
 * Not a layout engine — we cannot know what a stylesheet did. But the
 * crude cases (`display:none`, `hidden`, `aria-hidden`, a 1px font, white
 * on white, an off-screen absolute position) are exactly the ones used to
 * plant text a human will never see, so detecting them cheaply is worth
 * more than detecting them perfectly.
 */
export function isHidden(node: ElementNode): boolean {
  if (HIDDEN_ATTRS.some((test) => test(node.attrs))) return true;
  const style = (node.attrs['style'] ?? '').toLowerCase().replace(/\s+/g, '');
  return style.length > 0 && HIDDEN_STYLES.some((pattern) => pattern.test(style));
}

/** Attribute-level ways of being invisible. */
const HIDDEN_ATTRS: Array<(attrs: Record<string, string>) => boolean> = [
  (a) => 'hidden' in a,
  (a) => a['aria-hidden'] === 'true',
  (a) => a['type']?.toLowerCase() === 'hidden',
];

/**
 * Inline-style ways of being invisible.
 *
 * A list rather than a boolean chain so that adding the next trick seen in
 * the wild is one line and needs no rereading of the logic around it.
 */
const HIDDEN_STYLES: RegExp[] = [
  /display:none/,
  /visibility:hidden/,
  /opacity:0(?![.1-9])/,
  /font-size:0(px|em|rem|pt)?\b/,
  /(left|top):-\d{3,}/,
  /width:0(px)?;?.*height:0(px)?/,
  /clip:rect\(0/,
  /clip-path:inset\(100%/,
];

export { tokenize };
