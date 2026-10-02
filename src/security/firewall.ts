import { canonicalJson } from '../substrate/hash.js';

/**
 * The model-request firewall (§13.2).
 *
 * The last net. Every outbound model request passes through here, and if a
 * known secret value is anywhere in it, the request is **refused** — not
 * scrubbed.
 *
 * Refusing rather than scrubbing is the deliberate choice. A scrubbed request
 * still goes out, the agent carries on, and nobody learns that something
 * upstream is leaking credentials into prompts. A refusal is loud, surfaces
 * the bug, and costs one failed turn. §13.2 calls this "the backstop for a bug
 * anywhere upstream" — a backstop that silently papers over the bug is not one.
 */

export interface FirewallViolation {
  label: string;
  /** Where in the request, e.g. `messages[3].content`. Never the value. */
  path: string;
}

export class ModelRequestFirewall {
  /** value → label. Populated by the vault whenever a secret is unwrapped. */
  private readonly known = new Map<string, string>();

  /**
   * Below this length a "secret" is too short to match without constant false
   * positives. Shorter values are not watched — and that limit is stated out
   * loud here rather than discovered later.
   */
  static readonly MIN_WATCHED_LENGTH = 8;

  register(value: string, label: string): void {
    if (value.length < ModelRequestFirewall.MIN_WATCHED_LENGTH) return;
    this.known.set(value, label);
  }

  unregister(value: string): void {
    this.known.delete(value);
  }

  size(): number {
    return this.known.size;
  }

  /**
   * Scan an arbitrary request object. Walks the whole structure rather than
   * stringifying it once, so the report can say *where* the leak is — which is
   * the difference between a five-minute fix and an afternoon.
   */
  scan(request: unknown): FirewallViolation[] {
    const violations: FirewallViolation[] = [];
    if (this.known.size === 0) return violations;
    this.walk(request, '', violations, 0);
    return violations;
  }

  /**
   * Call immediately before handing a request to a provider. Throws on any
   * hit; the error names the label and the path, never the value.
   */
  assertClean(request: unknown): void {
    const violations = this.scan(request);
    if (violations.length === 0) return;
    const detail = violations.map((v) => `${v.label} at ${v.path || '<root>'}`).join('; ');
    throw new SecretLeakError(
      `refusing to send this model request: it contains secret material (${detail}). ` +
        `This is a bug upstream — a secret reached the context instead of staying ` +
        `behind the vault boundary. The request was not sent.`,
      violations,
    );
  }

  private walk(node: unknown, path: string, out: FirewallViolation[], depth: number): void {
    if (depth > 64 || node === null || node === undefined) return;

    switch (typeof node) {
      case 'string':
        this.check(node, path, out);
        return;
      case 'number':
      case 'boolean':
      case 'bigint':
        return;
      case 'object':
        break;
      default:
        return;
    }

    if (node instanceof Uint8Array) {
      // A secret base64'd or utf-8'd into a byte array is still a leak.
      this.check(Buffer.from(node).toString('utf8'), path, out);
      this.check(Buffer.from(node).toString('base64'), path, out);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((v, i) => this.walk(v, `${path}[${i}]`, out, depth + 1));
      return;
    }

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const child = path === '' ? k : `${path}.${k}`;
      this.check(k, `${child} <key>`, out); // a secret used as a key is a leak
      this.walk(v, child, out, depth + 1);
    }
  }

  private check(text: string, path: string, out: FirewallViolation[]): void {
    for (const [value, label] of this.known) {
      if (text.includes(value)) {
        out.push({ label, path });
        continue;
      }
      // Catch the common encodings an accidental leak passes through before
      // reaching a prompt: a token pasted into a URL, a header dumped as
      // base64, a value JSON-escaped into a string.
      if (text.includes(encodeURIComponent(value))) {
        out.push({ label, path: `${path} (url-encoded)` });
        continue;
      }
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      if (b64.length >= ModelRequestFirewall.MIN_WATCHED_LENGTH && text.includes(b64)) {
        out.push({ label, path: `${path} (base64)` });
      }
    }
  }

  /** For the adversarial suite: scan any surface, not just model requests. */
  scanSurface(name: string, value: unknown): FirewallViolation[] {
    const text = typeof value === 'string' ? value : canonicalJson(value);
    const out: FirewallViolation[] = [];
    this.check(text, name, out);
    return out;
  }
}

export class SecretLeakError extends Error {
  constructor(
    message: string,
    readonly violations: FirewallViolation[],
  ) {
    super(message);
    this.name = 'SecretLeakError';
  }
}
