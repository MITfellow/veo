import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../../src/capability/browser/html/entities.js';
import { tokenize } from '../../src/capability/browser/html/tokenize.js';
import { parseHtml, textOf, findFirst, elements, isHidden } from '../../src/capability/browser/html/parse.js';
import { buildAgentView, buildObservation, readableText, MAX_LABEL } from '../../src/capability/browser/view.js';
import { must, one } from '../fakes/must.js';

describe('entities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('&#73;&#103;&#110;&#111;&#114;&#101;')).toBe('Ignore');
    expect(decodeEntities('&#x65;&#x78;')).toBe('ex');
  });

  it('remaps the CP1252 range rather than emitting control characters', () => {
    // &#147; is a Windows smart quote in practice, not U+0093.
    expect(decodeEntities('&#147;x&#148;')).toBe('\u201cx\u201d');
  });

  it('leaves a bare ampersand alone', () => {
    expect(decodeEntities('AT&T and &notarealentity;')).toContain('AT&T');
  });
});

describe('tokenizer', () => {
  it('does not treat > inside a quoted attribute as the end of the tag', () => {
    const tokens = tokenize('<a title="a > b" href="/x">hi</a>');
    const start = tokens.find((t) => t.type === 'open');
    expect(start?.type === 'open' && start.attrs['title']).toBe('a > b');
    expect(start?.type === 'open' && start.attrs['href']).toBe('/x');
  });

  it('treats script content as raw text, not markup', () => {
    const tokens = tokenize('<script>if (a < b) { x("</div>") }</script><p>after</p>');
    const names = tokens.filter((t) => t.type === 'open').map((t) => (t.type === 'open' ? t.name : ''));
    expect(names).toEqual(['script', 'p']);
  });

  it('retains comments and marks them', () => {
    const tokens = tokenize('<p>a</p><!-- secret -->');
    expect(tokens.some((t) => t.type === 'comment')).toBe(true);
  });
});

describe('parser', () => {
  it('closes implied ends', () => {
    const doc = parseHtml('<ul><li>one<li>two</ul>');
    const items = elements(doc.root).filter((e) => e.name === 'li');
    expect(items).toHaveLength(2);
    expect(textOf(must(items[0], 'first li')).trim()).toBe('one');
  });

  it('does not let an unclosed tag swallow the rest of the document', () => {
    const doc = parseHtml('<div><p>one</div><p>two');
    expect(textOf(doc.root)).toContain('two');
  });

  it('excludes comments and script text from textOf', () => {
    const doc = parseHtml('<body>visible<!-- hidden --><script>var x=1</script><style>a{}</style></body>');
    expect(textOf(doc.root).trim()).toBe('visible');
  });

  it('recognises the common ways of hiding text', () => {
    const doc = parseHtml(
      '<body><i style="display:none">a</i><i style="visibility:hidden">b</i>' +
        '<i style="font-size:0px">c</i><i hidden>d</i><i aria-hidden="true">e</i><i>f</i></body>',
    );
    const kids = elements(must(findFirst(doc.root, 'body'), 'body')).filter((e) => e.name === 'i');
    expect(kids.map((k) => isHidden(k))).toEqual([true, true, true, true, true, false]);
  });
});

describe('agent view', () => {
  const html = `<!doctype html><html><head><title>Shop</title></head><body>
    <h1>Widgets</h1>
    <p>Some prose the planner must never see.</p>
    <form action="/results" method="post">
      <input name="q" type="search" placeholder="Search">
      <input name="pw" type="password">
      <input type="hidden" name="csrf" value="abc">
      <button type="submit">Go</button>
    </form>
    <a href="https://other.example/x">Partner</a>
    <button disabled>Nope</button>
  </body></html>`;

  const view = buildAgentView(html, 'https://shop.example/items');

  it('numbers affordances in document order', () => {
    expect(view.affordances.map((a) => a.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('omits hidden inputs — they are not affordances', () => {
    expect(view.affordances.some((a) => a.label === 'abc')).toBe(false);
  });

  it('reports a password field as a credential signal', () => {
    expect(view.signals.credentialFields).toBe(1);
    expect(view.affordances.find((a) => a.kind === 'password')).toBeDefined();
  });

  it('gives links an origin but never a URL', () => {
    const link = one(view.affordances, (a) => a.kind === 'link', 'the link');
    expect(link.origin).toBe('https://other.example');
    expect(link.sameOrigin).toBe(false);
    expect(JSON.stringify(view)).not.toContain('/x');
  });

  it('marks a disabled control', () => {
    expect(view.affordances.find((a) => a.label === 'Nope')?.disabled).toBe(true);
  });

  it('reads the document title, which lives in a head element textOf skips', () => {
    expect(view.title).toBe('Shop');
  });

  it('treats a type-less <button> as a submit, the HTML default', () => {
    const v = buildAgentView('<body><form><button>Go</button><button type="button">X</button></form></body>', 'https://s.example/');
    expect(v.affordances.map((a) => a.kind)).toEqual(['submit', 'button']);
  });

  it('carries statistics about body text but not the text', () => {
    expect(view.visibleTextChars).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain('must never see');
  });

  it('truncates a long label and says so', () => {
    const long = `<body><a href="/x">${'word '.repeat(60)}</a></body>`;
    const a = must(buildAgentView(long, 'https://s.example/').affordances[0], 'the long link');
    expect(a.label.length).toBeLessThanOrEqual(MAX_LABEL);
    expect(a.truncated).toBe(true);
  });

  it('keeps destinations in the side table, not the view', () => {
    const { targets } = buildObservation(html, 'https://shop.example/items');
    const link = one(view.affordances, (a) => a.kind === 'link', 'the link');
    expect(targets.get(link.ref)?.href).toBe('https://other.example/x');
  });

  it('gives the user path the full prose the planner was denied', () => {
    expect(readableText(html)).toContain('must never see');
  });
});

describe('accessible names come from where a human would read them', () => {
  it('uses <label for> rather than the field name', () => {
    const view = buildAgentView(
      '<body><form><label for="cc">Card number</label><input id="cc" name="card" type="text"></form></body>',
      'https://s.example/',
    );
    expect(must(view.affordances[0], 'the field').label).toBe('Card number');
  });

  it('prefers an explicit aria-label over the associated label', () => {
    const view = buildAgentView(
      '<body><label for="q">Search</label><input id="q" aria-label="Search the catalogue" type="search"></body>',
      'https://s.example/',
    );
    expect(must(view.affordances[0], 'the field').label).toBe('Search the catalogue');
  });

  it('falls back to the name attribute when nothing better exists', () => {
    const view = buildAgentView('<body><input name="token" type="text"></body>', 'https://s.example/');
    expect(must(view.affordances[0], 'the field').label).toBe('token');
  });
});
