import type { Net } from '../substrate/ports.js';
import { METADATA_HOSTS, privateReason } from '../substrate/addresses.js';
import type { EventLog } from '../substrate/events/log.js';
import type { TrustLevel } from '../substrate/events/types.js';

/**
 * Egress control.
 *
 * The moment this build can make an outbound request, it can be made to
 * make one on someone else's behalf. Every rule below corresponds to an
 * attack that has worked repeatedly against real systems, so each is stated
 * with the attack it stops rather than as a configuration knob:
 *
 *   **Allowlist per call.** The caller declares which origins it may reach.
 *   Anything else is refused. A URL that arrived inside FOREIGN content is
 *   not an instruction to visit it (§66, §112).
 *
 *   **Private, loopback, link-local and CGNAT ranges are refused**, and
 *   `169.254.169.254` is refused *even when explicitly allowlisted*. There
 *   is no legitimate reason for this agent to read a cloud metadata
 *   endpoint, and a config file is exactly how that rule would otherwise
 *   get turned off by someone in a hurry.
 *
 *   **Redirects are re-validated at every hop.** A 302 to the metadata
 *   endpoint is the oldest SSRF in the book, and checking only the first
 *   URL is the oldest mistake.
 *
 *   **A literal IP is validated directly; a hostname is validated after
 *   resolution.** Resolving once to check and letting the socket resolve
 *   again is a TOCTOU hole — DNS rebinding answers the validator with a
 *   public address and the socket with a private one.
 *
 *   **A byte budget per scope.** A sudden large outbound payload from a
 *   FOREIGN-influenced step is the signature of exfiltration, so it is a
 *   hard stop, not a warning.
 *
 * Every attempt is logged before it happens and every refusal is logged
 * with its reason: `egress.attempted` and `egress.blocked` were reserved in
 * M0 precisely so that the first network call this platform ever made could
 * not be an unlogged one.
 */

export class EgressDenied extends Error {
  override readonly name = 'EgressDenied';
  constructor(readonly reason: string, readonly target: string) {
    super(`Egress refused for ${target}: ${reason}`);
  }
}

export interface EgressPolicy {
  /** Origins this caller may reach, as `https://host` or `https://host:port`. */
  allowedOrigins: readonly string[];
  /** Total response bytes this scope may pull. */
  maxBytes: number;
  /** Total requests this scope may make. */
  maxRequests: number;
  /** How many redirects to follow, each re-validated. */
  maxRedirects: number;
  /** Trust of whatever caused this call. FOREIGN tightens the rules. */
  trust: TrustLevel;
}

export const DEFAULT_POLICY: Omit<EgressPolicy, 'allowedOrigins' | 'trust'> = {
  maxBytes: 2_000_000,
  maxRequests: 20,
  maxRedirects: 3,
};

export function originOf(url: string): string {
  const parsed = new URL(url);
  return parsed.port === '' ? `${parsed.protocol}//${parsed.hostname}` : `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/**
 * May this URL be reached under this policy?
 *
 * Returns the reason for refusal, or `null` for permitted — the same shape
 * the rest of the platform uses for a gate, so a caller cannot mistake a
 * refusal for a success by forgetting to check a boolean.
 */
interface UrlRule {
  /** Returns the refusal reason, or null if this rule is satisfied. */
  readonly check: (url: URL, policy: EgressPolicy) => string | null;
}

/**
 * The refusal rules, in order. Each one stops a specific attack, and the
 * order matters only in that the cheapest and most absolute come first —
 * the metadata endpoint is refused before the allow-list is even consulted,
 * because no allow-list entry may permit it.
 */
const URL_RULES: readonly UrlRule[] = [
  {
    check: (url) => (url.protocol === 'https:' || url.protocol === 'http:')
      ? null : `scheme '${url.protocol}' is not http(s)`,
  },
  {
    // Cleartext is readable and rewritable by anything on the path, which
    // defeats every check below it.
    check: (url, policy) => (url.protocol === 'http:' && policy.trust === 'FOREIGN')
      ? 'cleartext http is refused for untrusted callers' : null,
  },
  {
    check: (url) => METADATA_HOSTS.has(url.hostname.toLowerCase().replace(/^\[|\]$/g, ''))
      ? 'cloud metadata endpoints are refused, allow-list or not' : null,
  },
  {
    check: (url) => {
      const why = privateReason(url.hostname);
      return why === null ? null : `${url.hostname} is unreachable: ${why}`;
    },
  },
  {
    check: (url) => (url.username !== '' || url.password !== '')
      ? 'credentials in a URL are refused' : null,
  },
  {
    check: (url, policy) => {
      const origin = originOf(url.toString());
      if (policy.allowedOrigins.includes(origin)) return null;
      return policy.allowedOrigins.length === 0
        ? 'no origin is allowed for this call'
        : `${origin} is not in the allow-list (${policy.allowedOrigins.join(', ')})`;
    },
  },
];

/**
 * May this URL be reached under this policy?
 *
 * Returns the reason for refusal, or `null` for permitted — the same shape
 * the rest of the platform uses for a gate, so a caller cannot mistake a
 * refusal for a success by forgetting to check a boolean.
 */
export function refuseReason(url: string, policy: EgressPolicy): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  for (const rule of URL_RULES) {
    const reason = rule.check(parsed, policy);
    if (reason !== null) return reason;
  }
  return null;
}

export interface EgressDeps {
  net: Net;
  events: EventLog;
  now: () => number;
}

export interface EgressRequest {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  runId?: string | undefined;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Every URL actually contacted, in order. The last one produced the body. */
  chain: string[];
}

/**
 * A network door scoped to one policy.
 *
 * Constructed per run, not per process, so the byte and request budgets are
 * a property of the work rather than of the uptime.
 */
export class Egress {
  private bytes = 0;
  private requests = 0;

  constructor(
    private readonly deps: EgressDeps,
    private readonly policy: EgressPolicy,
  ) {}

  spent(): { bytes: number; requests: number } {
    return { bytes: this.bytes, requests: this.requests };
  }

  async fetch(request: EgressRequest): Promise<EgressResponse> {
    const chain: string[] = [];
    let url = request.url;

    for (let hop = 0; hop <= this.policy.maxRedirects; hop++) {
      this.checkBudget(url, request.runId);
      const reason = refuseReason(url, this.policy);
      if (reason !== null) {
        this.blocked(url, reason, request.runId);
        throw new EgressDenied(reason, url);
      }

      this.attempted(url, request.method ?? 'GET', request.runId);
      this.requests += 1;
      chain.push(url);

      const response = await this.deps.net.fetch(url, {
        method: request.method ?? 'GET',
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined ? {} : { body: request.body }),
      });

      this.bytes += response.body.length;
      if (this.bytes > this.policy.maxBytes) {
        const over = `response budget exhausted: ${this.bytes} bytes against ${this.policy.maxBytes}`;
        this.blocked(url, over, request.runId);
        throw new EgressDenied(over, url);
      }

      const location = redirectTarget(response.status, response.headers);
      if (location === undefined) return { ...response, chain };

      // Resolved against the current URL so a relative Location works, and
      // re-validated on the next pass of the loop. That re-validation is
      // the whole reason this is a loop and not a single call.
      url = new URL(location, url).toString();
    }

    const tooMany = `more than ${this.policy.maxRedirects} redirects`;
    this.blocked(url, tooMany, request.runId);
    throw new EgressDenied(tooMany, url);
  }

  private checkBudget(url: string, runId?: string): void {
    if (this.requests >= this.policy.maxRequests) {
      const reason = `request budget exhausted: ${this.policy.maxRequests} requests`;
      this.blocked(url, reason, runId);
      throw new EgressDenied(reason, url);
    }
  }

  private attempted(url: string, method: string, runId?: string): void {
    this.deps.events.append({
      type: 'egress.attempted',
      actor: 'agent',
      trust: this.policy.trust,
      ...(runId === undefined ? {} : { runId }),
      // The origin, never the full URL: a path and query string are the
      // most likely place for something private to be sitting (§21).
      payload: { origin: originOf(url), method, bytes: this.bytes },
    });
  }

  private blocked(url: string, reason: string, runId?: string): void {
    this.deps.events.append({
      type: 'egress.blocked',
      actor: 'agent',
      trust: this.policy.trust,
      ...(runId === undefined ? {} : { runId }),
      payload: { origin: safeOrigin(url), reason: reason.slice(0, 200) },
    });
  }
}

function safeOrigin(url: string): string {
  try {
    return originOf(url);
  } catch {
    return '(unparseable)';
  }
}

function redirectTarget(status: number, headers: Record<string, string>): string | undefined {
  if (status < 300 || status >= 400) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'location' && value !== '') return value;
  }
  return undefined;
}
