/**
 * The request firewall (§23).
 *
 * A final pass over every outbound model request and egress body, refusing on
 * any hit against a known secret value. It is the backstop *behind* the
 * design — secrets already never enter events, contexts or traces — and it
 * exists because "already never" is a claim about code that will be rewritten
 * a hundred times over ten years, by people who have not read §23.
 *
 * Two properties matter more than cleverness:
 *
 *   **It refuses rather than redacting.** A redacting firewall teaches callers
 *   that leaking is survivable and silently ships a request the user did not
 *   intend. A refusal is a bug report.
 *
 *   **The refusal never contains the value.** It names the secret by
 *   reference. A firewall whose error message quotes the secret has moved the
 *   leak from the request body into the log.
 */

export interface FirewallHit {
  /** `secret://name/version` — never the value. */
  reference: string;
  /**
   * Where in the body, so a developer can find it without being shown it.
   * `-1` means the value was reassembled across fields and has no single
   * offset — which is itself the most useful thing to report.
   */
  atOffset: number;
}

export type FirewallVerdict =
  | { ok: true }
  | { ok: false; hits: FirewallHit[]; message: string };

export interface KnownSecret {
  reference: string;
  value: string;
}

/**
 * Values shorter than this are not scanned.
 *
 * A four-character secret would match inside ordinary prose constantly, and a
 * firewall that cries wolf gets disabled. Short secrets are a vault-policy
 * problem, not a scanner problem.
 */
export const MIN_SCANNABLE = 8;

/**
 * Strip characters that encoding could have inserted between a secret's bytes.
 *
 * A body can carry a secret through JSON escaping, line wrapping or
 * whitespace injection without ever containing the literal substring. Scanning
 * a normalized copy catches `"abc\ndef"` and `"abc", "def"` splits that a
 * naive `includes` misses, which is test 42's "split across JSON fields".
 */
function normalize(text: string): { flat: string; offsets: number[] } {
  const flat: string[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (/[\s"',\\]/.test(char)) continue;
    flat.push(char);
    offsets.push(i);
  }
  return { flat: flat.join(''), offsets };
}

/**
 * The longest contiguous run of a secret that may appear in a body.
 *
 * Normalization bridges whitespace and escaping, but it cannot bridge an
 * intervening JSON *key*: `{"a":"sk-live-9f3a","b":"2b7c"}` flattens to
 * `{a:sk-live-9f3ab:2b7c}` and the `b:` sits inside the secret. So we also
 * refuse on any long contiguous fragment, which catches splits the
 * normalizer cannot see and treats half a live key as what it is — a leak.
 *
 * Sixteen is above the length of any realistic shared prefix (`sk-live-`,
 * `ghp_`) so it does not fire on unrelated keys from the same issuer.
 */
export const FRAGMENT_THRESHOLD = 16;

/**
 * Every string *value* in a JSON body, concatenated in document order.
 *
 * Keys are excluded deliberately: a key is chosen by our code, a value can
 * come from anywhere. Concatenating values is what catches a secret
 * deliberately or accidentally chunked across adjacent fields.
 */
function jsonStringValues(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(parsed);
  return parts.join('');
}

function fragmentHit(haystacks: readonly string[], value: string): boolean {
  if (value.length <= FRAGMENT_THRESHOLD) return false;
  for (let i = 0; i + FRAGMENT_THRESHOLD <= value.length; i++) {
    const fragment = value.slice(i, i + FRAGMENT_THRESHOLD);
    if (haystacks.some((h) => h.includes(fragment))) return true;
  }
  return false;
}

interface ScanContext {
  body: string;
  normalized: ReturnType<typeof normalize>;
  /** JSON string values, concatenated, and the same with separators stripped. */
  joined: string;
  joinedFlat: string;
}

function buildContext(body: string): ScanContext {
  const joined = jsonStringValues(body);
  return { body, normalized: normalize(body), joined, joinedFlat: normalize(joined).flat };
}

function scanOne(ctx: ScanContext, secret: KnownSecret): FirewallHit | null {
  if (secret.value.length < MIN_SCANNABLE) return null;
  const { reference, value } = secret;

  const direct = ctx.body.indexOf(value);
  if (direct >= 0) return { reference, atOffset: direct };

  const flatSecret = normalize(value).flat;
  if (flatSecret.length < MIN_SCANNABLE) return null;

  const split = ctx.normalized.flat.indexOf(flatSecret);
  if (split >= 0) return { reference, atOffset: ctx.normalized.offsets[split] ?? split };

  // Reassembled across JSON fields, or present only as a long fragment.
  if (ctx.joinedFlat.includes(flatSecret) || fragmentHit([ctx.normalized.flat, ctx.joinedFlat], flatSecret)) {
    return { reference, atOffset: -1 };
  }

  return null;
}

/** Scan an outbound body. Returns every hit, so one pass fixes every leak. */
export function inspect(body: string, secrets: readonly KnownSecret[]): FirewallVerdict {
  const ctx = buildContext(body);
  const hits: FirewallHit[] = [];
  for (const secret of secrets) {
    const hit = scanOne(ctx, secret);
    if (hit) hits.push(hit);
  }
  if (hits.length === 0) return { ok: true };
  return {
    ok: false,
    hits,
    message:
      `Refusing to send: the body contains ${hits.length} known secret value(s) — ` +
      `${hits.map((h) => h.reference).join(', ')}. ` +
      'Pass a secret:// reference and let the invoke pipeline resolve it (§23).',
  };
}

export class FirewallError extends Error {
  constructor(readonly hits: readonly FirewallHit[], message: string) {
    super(message);
    this.name = 'FirewallError';
  }
}

/** Throwing form, for the egress path where there is no sensible fallback. */
export function enforce(body: string, secrets: readonly KnownSecret[]): void {
  const verdict = inspect(body, secrets);
  if (!verdict.ok) throw new FirewallError(verdict.hits, verdict.message);
}
