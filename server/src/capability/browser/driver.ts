/**
 * The browser driver port.
 *
 * Exactly the same shape of seam as `ModelProvider`: one function, so
 * there is one thing to supply and nothing to drift. Everything above it —
 * parsing, the agent view, plan enforcement, the policy gates, the
 * quarantine routing — is built and tested without it.
 *
 * `StaticDriver` ships and genuinely works: point the agent at saved HTML
 * and the entire stack runs. **No network driver is compiled in** (§2),
 * for the same reason no model provider is.
 */

export interface FetchRequest {
  url: string;
  /** Present only for a form submission the policy already approved. */
  method: 'GET' | 'POST';
  body?: string | undefined;
}

export interface FetchResponse {
  url: string;
  status: number;
  contentType: string;
  html: string;
}

export type BrowserDriver = (request: FetchRequest) => Promise<FetchResponse>;

export class DriverError extends Error {
  constructor(
    readonly kind: 'not_attached' | 'not_found' | 'unsupported_scheme' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/** Pages larger than this are refused rather than parsed. */
export const MAX_PAGE_BYTES = 2_000_000;

/**
 * A driver over a fixed set of documents.
 *
 * This is how browsing is tested, and also how it genuinely works offline:
 * a saved page, an exported archive, a local file. It is not a mock — the
 * same code path serves it as would serve the network.
 */
export class StaticDriver {
  constructor(private readonly pages: Map<string, string> = new Map()) {}

  set(url: string, html: string): this {
    this.pages.set(normalizeUrl(url), html);
    return this;
  }

  has(url: string): boolean {
    return this.pages.has(normalizeUrl(url));
  }

  readonly fetch: BrowserDriver = async (request) => {
    const url = normalizeUrl(request.url);
    const html = this.pages.get(url);
    if (html === undefined) {
      throw new DriverError('not_found', `No local document for ${url}. This build has no network driver (§2).`);
    }
    if (html.length > MAX_PAGE_BYTES) {
      throw new DriverError('too_large', `Document exceeds ${MAX_PAGE_BYTES} bytes.`);
    }
    return Promise.resolve({ url, status: 200, contentType: 'text/html', html });
  };
}

/**
 * The absence of a network driver, expressed as a driver.
 *
 * Used when nothing is configured, so the failure is a clear refusal at
 * the point of use rather than an undefined somewhere upstream.
 */
export const unattachedDriver: BrowserDriver = (request) =>
  Promise.reject(
    new DriverError(
      'not_attached',
      `Cannot fetch ${request.url}: no browser driver is compiled into this build. ` +
        'The parser, agent view, plan enforcement and policy gates are all live — only the transport is missing.',
    ),
  );

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  // Strip a trailing fragment: two URLs differing only by anchor are the
  // same document, and treating them as different lets a page burn an
  // agent's step budget by linking to itself.
  const withoutHash = trimmed.split('#')[0] ?? trimmed;
  return withoutHash.replace(/\/+$/, '') || withoutHash;
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'file:']);

/**
 * Is this a scheme we are willing to follow?
 *
 * `javascript:` and `data:` links are refused outright. They are not
 * navigation; they are code execution and inline content respectively,
 * and both are standard ways to get an agent to do something that looks
 * like clicking a link.
 */
export function isSafeScheme(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase();
  if (scheme === undefined) return true; // relative URL
  return SAFE_SCHEMES.has(`${scheme}:`);
}
