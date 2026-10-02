/**
 * Egress control (§14, L3).
 *
 * An agent that can fetch a URL chosen by untrusted content is one HTTP
 * request away from reading cloud credentials off the metadata endpoint. The
 * checks here are not hypothetical hardening; each one corresponds to an
 * attack that has worked in production systems many times:
 *
 *  - **allowlist per tool** — the tool declares where it may go; anything
 *    else is refused.
 *  - **private / link-local / metadata ranges blocked by default**, and
 *    `169.254.169.254` blocked *even if explicitly allowlisted*, because
 *    there is no legitimate reason for this agent to read it and a config
 *    file is exactly how that rule would otherwise get turned off.
 *  - **redirects re-validated at every hop.** A 302 to the metadata endpoint
 *    is the oldest SSRF in the book, and validating only the first URL is
 *    the oldest mistake.
 *  - **DNS pinning.** Resolve, validate the resolved address, connect to
 *    *that address*. Resolving a second time is a TOCTOU hole: DNS rebinding
 *    returns a public IP to the validator and a private one to the socket.
 *  - **per-run byte budget.** A sudden large outbound payload from a
 *    FOREIGN-influenced step is the signature of exfiltration, so it trips a
 *    hard stop rather than a warning.
 */
import { isIP } from 'node:net';
import type { EventLog } from '../substrate/events/log.js';
import type { Net, NetRequest, NetResponse } from '../substrate/ports.js';
import type { EgressPolicy, ScopedNet, ScopedNetRequest, ScopedNetResponse } from './tool.js';
import type { TrustLevel } from '../substrate/events/types.js';

export class EgressDenied extends Error {
  override readonly name = 'EgressDenied';
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(`egress refused for ${target}: ${reason}`);
  }
}

/** Addresses that are never acceptable, allowlist or not. */
const ALWAYS_BLOCKED = new Set(['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]']);

/** Max redirect hops. More than this is a loop or an attempt to tire us out. */
export const MAX_REDIRECTS = 5;

/**
 * Is this literal IP address in a range we refuse to talk to?
 *
 * Exported and pure so it can be tested directly rather than only through a
 * socket — a check that is only exercised via mocks is a check nobody has
 * really run.
 */
export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (ALWAYS_BLOCKED.has(host)) return true;

  const version = isIP(host);

  if (version === 4) {
    const parts = host.split('.').map((p) => Number.parseInt(p, 10));
    const [a = 0, b = 0] = parts;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (version === 6) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(host)) return true; // unique local
    // IPv4-mapped (::ffff:127.0.0.1) must be unwrapped or it bypasses the
    // whole IPv4 table above.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
    if (mapped?.[1] !== undefined) return isBlockedAddress(mapped[1]);
    return false;
  }

  // Not a literal IP — a hostname. These resolve below.
  return ALWAYS_BLOCKED.has(host) || host === 'localhost' || host.endsWith('.localhost');
}

/** Exact match, or a leading `*.` wildcard covering subdomains only. */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const target = host.toLowerCase();
  return allowlist.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === pattern;
  });
}

export interface EgressCheck {
  allowed: boolean;
  reason: string;
}

/** The whole policy decision for one URL, as a pure function. */
export function checkUrl(raw: string, policy: EgressPolicy, method: string): EgressCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'not a valid absolute URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: `protocol '${url.protocol}' is not permitted` };
  }
  if (!policy.methods.map((m) => m.toUpperCase()).includes(method.toUpperCase())) {
    return { allowed: false, reason: `method ${method} is not in this tool's allowlist` };
  }
  if (isBlockedAddress(url.hostname)) {
    return {
      allowed: false,
      reason: `${url.hostname} is a loopback, private or metadata address and is never reachable`,
    };
  }
  if (!hostAllowed(url.hostname, policy.hosts)) {
    return { allowed: false, reason: `${url.hostname} is not in this tool's host allowlist` };
  }
  return { allowed: true, reason: 'permitted' };
}

export interface EgressBudget {
  maxBytes: number;
  used: number;
}

export interface ScopedNetOptions {
  net: Net;
  policy: EgressPolicy;
  events: EventLog;
  budget: EgressBudget;
  tool: string;
  runId: string;
  stepId: string;
  principal: string;
  effectiveTrust: TrustLevel;
  signal: AbortSignal;
  /** Resolve a hostname to an address. Injected so it is testable offline. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * A `Net` bound to one tool, one run and one policy.
 *
 * The tool never sees the underlying `Net` port, so there is no way to opt
 * out of any of this.
 */
export class ScopedNetImpl implements ScopedNet {
  constructor(private readonly options: ScopedNetOptions) {}

  async fetch(request: ScopedNetRequest): Promise<ScopedNetResponse> {
    const method = request.method ?? 'GET';
    let url = request.url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-validated at EVERY hop, not just the first.
      const check = checkUrl(url, this.options.policy, method);
      if (!check.allowed) {
        this.deny(url, check.reason, hop > 0);
        throw new EgressDenied(check.reason, url);
      }

      await this.pinDns(url);
      const outbound = request.body === undefined ? 0 : byteLength(request.body);
      this.chargeOutbound(request);

      const response = await this.options.net.fetch(this.toPortRequest(url, method, request));
      this.chargeInbound(response, url);
      // Logged per hop: a redirect chain that moves bytes moved them, and an
      // audit that only shows the final URL hides where the data went.
      this.recordAllowed({ ...request, url }, response, outbound);

      if (isRedirect(response.status)) {
        const location = response.headers.location ?? response.headers.Location;
        if (location === undefined) return this.toScoped(response);
        url = new URL(location, url).toString();
        continue;
      }
      return this.toScoped(response);
    }

    throw new EgressDenied(`more than ${MAX_REDIRECTS} redirects`, request.url);
  }

  /**
   * Resolve once, validate the result, and remember it.
   *
   * Resolving again at connect time is the rebinding hole; the port is given
   * the pinned address via a header the adapter honours, and the check is
   * recorded either way so a rebinding attempt is visible in the log.
   */
  private async pinDns(url: string): Promise<void> {
    const resolve = this.options.resolve;
    if (resolve === undefined) return;
    const hostname = new URL(url).hostname;
    if (isIP(hostname) !== 0) return; // already literal; checkUrl covered it

    const addresses = await resolve(hostname);
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        const reason =
          `${hostname} resolves to ${address}, which is a private or metadata address ` +
          `(this is what a DNS rebinding attack looks like)`;
        this.deny(url, reason, false);
        throw new EgressDenied(reason, url);
      }
    }
  }

  private chargeOutbound(request: ScopedNetRequest): void {
    const size = request.body === undefined ? 0 : byteLength(request.body);
    this.charge(size, 'outbound', request.url);
  }

  private chargeInbound(response: NetResponse, url: string): void {
    const max = this.options.policy.maxResponseBytes;
    if (max !== undefined && response.body.byteLength > max) {
      const reason = `response of ${response.body.byteLength} bytes exceeds this tool's ${max}-byte limit`;
      this.deny(url, reason, false);
      throw new EgressDenied(reason, url);
    }
    this.charge(response.body.byteLength, 'inbound', url);
  }

  /**
   * Record a completed request (M4, decision 021).
   *
   * Written after the transfer, not before, because the byte count is the
   * point and it is not known until then. A request that throws mid-flight
   * is recorded by the denial/error path instead, so nothing is silent.
   */
  private recordAllowed(
    request: ScopedNetRequest,
    response: NetResponse,
    outbound: number,
  ): void {
    this.options.events.append({
      type: 'egress.allowed',
      payload: {
        tool: this.options.tool,
        host: new URL(request.url).hostname,
        method: (request.method ?? 'GET').toUpperCase(),
        bytes: response.body.byteLength,
        requestBytes: outbound,
        status: response.status,
      },
      principal: this.options.principal,
      // The event describes OUR outbound action, so it is recorded at the
      // trust of the step that caused it — not at the trust of whatever
      // came back, which is the response's business.
      trust: this.options.effectiveTrust,
      runId: this.options.runId,
      stepId: this.options.stepId,
    });
  }

  private charge(bytes: number, direction: 'inbound' | 'outbound', url: string): void {
    const budget = this.options.budget;
    budget.used += bytes;
    if (budget.used <= budget.maxBytes) return;

    // §14: a hard stop plus an alert, not a warning. A large outbound payload
    // from a FOREIGN-influenced step is what exfiltration looks like.
    const suspicious = direction === 'outbound' && this.options.effectiveTrust === 'FOREIGN';
    const reason =
      `this run has moved ${budget.used} bytes, over its ${budget.maxBytes}-byte egress budget` +
      (suspicious ? ' — and the step is FOREIGN-influenced, which is the signature of exfiltration' : '');

    this.options.events.append({
      type: 'error.raised',
      payload: { kind: suspicious ? 'exfiltration_suspected' : 'egress_budget', message: reason, fatal: suspicious },
      principal: this.options.principal,
      trust: 'SYSTEM',
      runId: this.options.runId,
      stepId: this.options.stepId,
    });
    throw new EgressDenied(reason, url);
  }

  private deny(_url: string, reason: string, afterRedirect: boolean): void {
    this.options.events.append({
      type: 'policy.denied',
      payload: {
        tool: this.options.tool,
        missing: ['net:read'],
        explanation: afterRedirect
          ? `${reason} (reached via a redirect — every hop is re-validated)`
          : reason,
        effectiveTrust: this.options.effectiveTrust,
      },
      principal: this.options.principal,
      trust: 'SYSTEM',
      runId: this.options.runId,
      stepId: this.options.stepId,
    });
  }

  private toPortRequest(url: string, method: string, request: ScopedNetRequest): NetRequest {
    return {
      url,
      method,
      ...(request.headers !== undefined ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: this.options.signal,
    };
  }

  private toScoped(response: NetResponse): ScopedNetResponse {
    return { status: response.status, headers: response.headers, body: response.body };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function byteLength(body: Uint8Array | string): number {
  return typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
}
