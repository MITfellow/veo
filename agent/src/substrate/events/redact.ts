/**
 * Redaction (§13.5, invariant 7).
 *
 * This runs inside `EventLog.append`, not at call sites. That placement is the
 * whole design: a secret cannot reach the log through a path someone forgot to
 * decorate, because there is only one path and it always redacts.
 *
 * Two mechanisms, because they fail differently:
 *
 *  1. **Known values.** When the vault hands a secret to a tool it registers
 *     the literal string here. Substring replacement then catches it wherever
 *     it later surfaces — inside a URL, inside an error message, inside a stack
 *     trace, base64'd into a header dump. This is the reliable one.
 *  2. **Patterns.** Shapes that are obviously credentials even though we never
 *     issued them (a key the user pastes into chat, a token in a fetched page).
 *     Best-effort by nature; it backstops (1), it does not replace it.
 *
 * The placeholder names the *label*, never any part of the value — no prefix,
 * no last-four. A hint is a hint to an attacker reading the log too, and the
 * log is the thing we promise is safe to show someone.
 */

export interface RedactionRule {
  label: string;
  pattern: RegExp;
}

export const DEFAULT_PATTERNS: readonly RedactionRule[] = Object.freeze([
  { label: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'google_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { label: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { label: 'authorization_header', pattern: /("?authorization"?\s*[:=]\s*"?)[^"\s,}]{12,}/gi },
  { label: 'private_key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'basic_auth_url', pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi },
]);

export function placeholder(label: string): string {
  return `[REDACTED:${label}]`;
}

/** Longest-first so an overlapping shorter secret cannot unmask a longer one. */
function sortedEntries(values: Map<string, string>): [string, string][] {
  return [...values.entries()].sort((a, b) => b[0].length - a[0].length);
}

/**
 * The forms a secret takes on its way into a payload.
 *
 * Literal matching alone is not enough, and the adversarial fuzz proved it: a
 * credential interpolated into a URL arrives percent-encoded and sails
 * straight past a substring check. Same for a header block dumped as base64.
 * Each registered value is therefore watched in every shape it plausibly
 * wears by the time it reaches an event payload.
 */
function encodingsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  try {
    forms.add(encodeURIComponent(value));
    forms.add(encodeURI(value));
  } catch {
    // Lone surrogates make encodeURIComponent throw; the literal still counts.
  }
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  if (b64.length >= 8) {
    forms.add(b64);
    forms.add(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); // base64url
  }
  // JSON escaping: a secret containing a quote or backslash looks different
  // once it has been through JSON.stringify.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) forms.add(jsonEscaped);
  return [...forms].filter((f) => f.length >= 8).sort((a, b) => b.length - a.length);
}

export class Redactor {
  /** value → label */
  private readonly values = new Map<string, string>();
  /** value → every encoded form to watch for. Computed once at registration. */
  private readonly encodingCache = new Map<string, string[]>();
  private readonly rules: RedactionRule[];

  constructor(rules: readonly RedactionRule[] = DEFAULT_PATTERNS) {
    this.rules = [...rules];
  }

  /**
   * Register a literal secret. Values shorter than 8 characters are ignored on
   * purpose: redacting a 3-character string would shred unrelated text
   * everywhere and make the log useless, which is its own kind of data loss.
   */
  register(value: string, label: string): void {
    if (value.length < 8) return;
    this.values.set(value, label);
    this.encodingCache.set(value, encodingsOf(value));
  }

  unregister(value: string): void {
    this.values.delete(value);
    this.encodingCache.delete(value);
  }

  addRule(rule: RedactionRule): void {
    this.rules.push(rule);
  }

  /** Everything the vault has handed out, for the "is this leaking?" audit. */
  knownCount(): number {
    return this.values.size;
  }

  redactString(input: string): string {
    let out = input;
    for (const [value, label] of sortedEntries(this.values)) {
      for (const form of this.encodingCache.get(value) ?? [value]) {
        if (out.includes(form)) out = out.split(form).join(placeholder(label));
      }
    }
    for (const { label, pattern } of this.rules) {
      // Rules are module-level and `g`-flagged; reset lastIndex so a previous
      // call cannot make this one start mid-string.
      pattern.lastIndex = 0;
      out = out.replace(pattern, (_match: string, prefix?: string) =>
        typeof prefix === 'string' ? `${prefix}${placeholder(label)}` : placeholder(label),
      );
    }
    return out;
  }

  /**
   * Deep walk. Keys are redacted as well as values — a secret used as a map key
   * is still a secret, and `{"sk-abc": 1}` is a real shape in header dumps.
   */
  redact<T>(input: T): T {
    return this.walk(input, 0) as T;
  }

  private walk(node: unknown, depth: number): unknown {
    if (depth > 64) return '[REDACTED:depth-limit]';
    if (node === null || node === undefined) return node;

    switch (typeof node) {
      case 'string':
        return this.redactString(node);
      case 'number':
      case 'boolean':
      case 'bigint':
        return node;
      case 'object':
        break;
      default:
        return node;
    }

    if (Array.isArray(node)) return node.map((v) => this.walk(v, depth + 1));
    if (node instanceof Uint8Array) return node;

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[this.redactString(k)] = this.walk(v, depth + 1);
    }
    return out;
  }

  /** For tests and the leak audit: does this value survive redaction anywhere? */
  leaks(haystack: unknown, needle: string): boolean {
    return canonicalish(this.redact(haystack)).includes(needle);
  }
}

function canonicalish(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
}
