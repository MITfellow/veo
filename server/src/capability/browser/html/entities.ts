/**
 * Entity decoding.
 *
 * Only the entities that appear in real documents, plus the numeric forms.
 * A complete HTML5 entity table is 2,231 entries and would be the largest
 * file in the project for no benefit a personal agent can measure.
 *
 * Decoding matters for security as well as display: `&#108;ogin` and
 * `login` must produce the same label, or an attacker can hide the real
 * text of a button from anything matching on it.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', dagger: '†', permil: '‰', prime: '′',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
};

/**
 * Codepoints Windows-1252 put where C1 controls belong. Browsers remap
 * these and so must we, or `&#146;` renders as an invisible control
 * character instead of an apostrophe.
 */
const CP1252: Readonly<Record<number, string>> = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡',
  136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '\u2018',
  146: '\u2019', 147: '\u201c', 148: '\u201d', 149: '•', 150: '–', 151: '—',
  152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

function fromCodePoint(code: number): string {
  const remapped = CP1252[code];
  if (remapped !== undefined) return remapped;
  // Surrogates and out-of-range values become the replacement character
  // rather than throwing: a malformed entity is a bad page, not a crash.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(code);
}

const PATTERN = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g;

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(PATTERN, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isNaN(code) ? match : fromCodePoint(code);
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? match;
  });
}
