import { elements, findFirst, isHidden, parseHtml, textOf, walk, type Document, type ElementNode } from './html/parse.js';

/**
 * The agent view (§21, decision 009).
 *
 * This is the only representation of a page the privileged path ever
 * receives. It is a list of **affordances** — things that can be
 * interacted with — plus structure and counts. It contains no body prose,
 * so an instruction written into a paragraph is not merely ignored by the
 * planner; it is not present in the planner's input at all.
 *
 * The page's readable text still exists. It goes into the quarantine and
 * reaches the *user*, who is the right audience for something a stranger
 * wrote.
 */

/** Labels are affordance names, not free text. See decision 009. */
export const MAX_LABEL = 80;

export type ElementKind =
  | 'link' | 'button' | 'textbox' | 'password' | 'checkbox' | 'radio'
  | 'select' | 'file' | 'submit' | 'search' | 'textarea';

export interface Affordance {
  /** Stable within one observation: `e1`, `e2`, … */
  ref: string;
  kind: ElementKind;
  /** Accessible name, truncated to MAX_LABEL. */
  label: string;
  /** True when the label had to be cut, so the planner knows it is partial. */
  truncated: boolean;
  disabled: boolean;
  required: boolean;
  /** Whether the field already holds something. Never the value itself. */
  hasValue: boolean;
  /** For links: the origin only. The full URL is quarantined. */
  origin: string | null;
  sameOrigin: boolean;
  /** Index into the form this element belongs to, if any. */
  formIndex: number | null;
}

export interface PageSignals {
  /** Text present in the source but not visible to a reader. */
  hiddenTextChars: number;
  /** Characters inside HTML comments. */
  commentChars: number;
  /** Inline script elements. */
  scripts: number;
  /** Distinct third-party origins referenced. */
  foreignOrigins: string[];
  /** Fields that take a credential. */
  credentialFields: number;
}

export interface AgentView {
  url: string;
  origin: string;
  title: string;
  affordances: Affordance[];
  forms: Array<{ index: number; action: string | null; method: string; fields: number }>;
  headings: string[];
  /** Visible text statistics, never the text. */
  visibleTextChars: number;
  signals: PageSignals;
}

const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch']);

function originOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url);
  if (match === null) return null;
  return `${match[1]?.toLowerCase()}://${match[2]?.toLowerCase()}`;
}

function resolveOrigin(href: string, base: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return originOf(href);
  if (/^(mailto|tel|javascript|data):/i.test(href)) return href.split(':')[0]?.toLowerCase() ?? null;
  return originOf(base);
}

function truncate(text: string): { label: string; truncated: boolean } {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_LABEL
    ? { label: clean, truncated: false }
    : { label: `${clean.slice(0, MAX_LABEL - 1)}…`, truncated: true };
}

/**
 * Accessible name, in roughly the order a screen reader uses.
 *
 * `aria-label` first because it is explicit, then the alt text of a lone
 * image child (a common pattern for icon buttons), then visible text, then
 * the placeholder, then the form field's name as a last resort.
 */
const NAME_SOURCES: Array<(node: ElementNode, doc: Document) => string | undefined> = [
  (n) => n.attrs['aria-label'],
  (n) => textOf(n),
  // A <label for="…"> is how most real forms name their fields. Without
  // this, a card number field is called "card" — which is what the
  // developer typed, not what the human about to approve it would read.
  labelFor,
  (n) => findFirst(n, 'img')?.attrs['alt'],
  (n) => n.attrs['placeholder'],
  (n) => n.attrs['title'],
  (n) => n.attrs['value'],
  (n) => n.attrs['name'],
];

function labelFor(node: ElementNode, doc: Document): string | undefined {
  const id = node.attrs['id'];
  if (id === undefined) return undefined;
  for (const candidate of elements(doc.root)) {
    if (candidate.name === 'label' && candidate.attrs['for'] === id) return textOf(candidate);
  }
  return undefined;
}

function accessibleName(node: ElementNode, doc: Document): string {
  for (const source of NAME_SOURCES) {
    const candidate = source(node, doc)?.trim() ?? '';
    if (candidate.length > 0) return candidate;
  }
  return '';
}

/**
 * `<input type>` to affordance kind.
 *
 * A table, because this is data. Anything absent from it — `text`, `email`,
 * `number`, a type nobody has invented yet — is a textbox, which is what a
 * browser does with an unknown input type too.
 */
const INPUT_KINDS: Record<string, ElementKind | null> = {
  hidden: null,
  password: 'password',
  checkbox: 'checkbox',
  radio: 'radio',
  file: 'file',
  search: 'search',
  submit: 'submit',
  button: 'submit',
  image: 'submit',
};

function inputKind(node: ElementNode): ElementKind | null {
  const type = (node.attrs['type'] ?? 'text').toLowerCase();
  return type in INPUT_KINDS ? (INPUT_KINDS[type] ?? null) : 'textbox';
}

/**
 * Element name to affordance kind.
 *
 * A `<button>` with no `type` submits its form — that is the HTML default,
 * and calling it a plain button would quietly downgrade an effect action
 * into an interaction, which is the gate it is meant to face.
 */
const TAG_KINDS: Record<string, (node: ElementNode) => ElementKind | null> = {
  a: (n) => (n.attrs['href'] === undefined ? null : 'link'),
  button: (n) => ((n.attrs['type'] ?? 'submit').toLowerCase() === 'submit' ? 'submit' : 'button'),
  textarea: () => 'textarea',
  select: () => 'select',
  input: inputKind,
  summary: () => 'button',
};

function kindOf(node: ElementNode): ElementKind | null {
  const byTag = TAG_KINDS[node.name];
  if (byTag !== undefined) return byTag(node);

  // Anything claiming a clickable ARIA role is clickable, whatever it is
  // built from: a div with role="button" is a button to a user.
  const role = node.attrs['role']?.toLowerCase();
  if (role !== undefined && CLICKABLE_ROLES.has(role)) return role === 'link' ? 'link' : 'button';
  return node.attrs['onclick'] === undefined ? null : 'button';
}

function formIndexOf(node: ElementNode, forms: ElementNode[]): number | null {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    const index = forms.indexOf(parent);
    if (index >= 0) return index;
  }
  return null;
}

/**
 * What a ref actually points at.
 *
 * Deliberately *not* part of `AgentView`. The planner gets an origin and a
 * label; the full URL and the field name live here, in a side table the
 * session dereferences when it executes. The planner names a ref, the
 * session resolves it — so a page cannot smuggle a destination through a
 * label the planner reads.
 */
export interface Target {
  ref: string;
  /** Raw href/action, unresolved. Never shown to the planner. */
  href: string | null;
  /** Form field name, for composing a submission. */
  name: string | null;
  kind: ElementKind;
  formIndex: number | null;
}

function toAffordance(node: ElementNode, kind: ElementKind, ref: string, formIndex: number | null, baseUrl: string, doc: Document): Affordance {
  const href = node.attrs['href'];
  const { label, truncated } = truncate(accessibleName(node, doc));
  const origin = href === undefined ? null : resolveOrigin(href, baseUrl);
  return {
    ref,
    kind,
    label,
    truncated,
    disabled: 'disabled' in node.attrs || node.attrs['aria-disabled'] === 'true',
    required: 'required' in node.attrs,
    hasValue: (node.attrs['value'] ?? '').length > 0 || (kind === 'textarea' && textOf(node).trim().length > 0),
    origin,
    sameOrigin: origin === null || origin === originOf(baseUrl),
    formIndex,
  };
}

function buildAffordances(doc: Document, baseUrl: string, targets?: Map<string, Target>): Affordance[] {
  const forms = elements(doc.root).filter((e) => e.name === 'form');
  const out: Affordance[] = [];

  for (const node of elements(doc.root)) {
    const kind = kindOf(node);
    // Hidden elements are not affordances. An agent that can click what a
    // human cannot see is an agent that can be driven invisibly.
    if (kind === null || isHidden(node) || hasHiddenAncestor(node)) continue;

    const ref = `e${out.length + 1}`;
    const formIndex = formIndexOf(node, forms);
    targets?.set(ref, { ref, href: node.attrs['href'] ?? null, name: node.attrs['name'] ?? null, kind, formIndex });
    out.push(toAffordance(node, kind, ref, formIndex, baseUrl, doc));
  }
  return out;
}

function hasHiddenAncestor(node: ElementNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) if (isHidden(p)) return true;
  return false;
}

const LINKING_ATTRS = ['src', 'href', 'action', 'formaction'] as const;

/** Origins this element points at, other than the page's own. */
function foreignOriginsOf(node: ElementNode, base: string | null, baseUrl: string): string[] {
  const found: string[] = [];
  for (const key of LINKING_ATTRS) {
    const raw = node.attrs[key];
    if (raw === undefined) continue;
    const origin = resolveOrigin(raw, baseUrl);
    if (origin !== null && origin !== base && origin.includes('://')) found.push(origin);
  }
  return found;
}

/** Characters of text sitting directly inside a hidden element. */
function hiddenTextIn(node: ElementNode): number {
  if (!isHidden(node)) return 0;
  return node.children.reduce((total, c) => total + (c.type === 'text' ? c.text.trim().length : 0), 0);
}

function isCredentialField(node: ElementNode): boolean {
  return node.name === 'input' && (node.attrs['type'] ?? '').toLowerCase() === 'password';
}

/**
 * The things about a page that the planner is allowed to know.
 *
 * Deliberately counts rather than content: "there are 240 characters you
 * cannot see" is actionable and cannot carry an instruction, whereas the
 * 240 characters themselves are precisely the payload.
 */
function collectSignals(doc: Document, baseUrl: string): PageSignals {
  const base = originOf(baseUrl);
  const foreign = new Set<string>();
  const counts = { hiddenTextChars: 0, commentChars: 0, scripts: 0, credentialFields: 0 };

  for (const node of walk(doc.root)) {
    if (node.type === 'comment') {
      counts.commentChars += node.text.trim().length;
      continue;
    }
    if (node.type !== 'element') continue;
    if (node.name === 'script') counts.scripts++;
    if (isCredentialField(node)) counts.credentialFields++;
    counts.hiddenTextChars += hiddenTextIn(node);
    for (const origin of foreignOriginsOf(node, base, baseUrl)) foreign.add(origin);
  }

  return { ...counts, foreignOrigins: [...foreign].sort() };
}

export function buildAgentView(html: string, url: string): AgentView {
  return buildObservation(html, url).view;
}

/**
 * The agent view plus the private side table of what each ref points at.
 *
 * Callers in the privileged path use the view. Only the executor touches
 * `targets`, and only to resolve a ref the plan already authorised.
 */
export function buildObservation(html: string, url: string): { view: AgentView; targets: ReadonlyMap<string, Target> } {
  const targets = new Map<string, Target>();
  const doc = parseHtml(html);
  const forms = elements(doc.root).filter((e) => e.name === 'form');
  const body = findFirst(doc.root, 'body') ?? doc.root;

  const view: AgentView = {
    url,
    origin: originOf(url) ?? '',
    title: truncate(doc.title).label,
    affordances: buildAffordances(doc, url, targets),
    forms: forms.map((f, index) => ({
      index,
      action: f.attrs['action'] === undefined ? null : resolveOrigin(f.attrs['action'], url),
      method: (f.attrs['method'] ?? 'get').toLowerCase(),
      fields: elements(f).filter((e) => ['input', 'select', 'textarea'].includes(e.name)).length,
    })),
    headings: elements(body)
      .filter((e) => /^h[1-3]$/.test(e.name))
      .slice(0, 12)
      .map((e) => truncate(textOf(e)).label)
      .filter((h) => h.length > 0),
    visibleTextChars: textOf(body).replace(/\s+/g, ' ').trim().length,
    signals: collectSignals(doc, url),
  };
  return { view, targets };
}

/** The readable text, for the *user* — never for the planner. */
export function readableText(html: string): string {
  const doc = parseHtml(html);
  const body = findFirst(doc.root, 'body') ?? doc.root;
  return textOf(body).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export { parseHtml, textOf };
