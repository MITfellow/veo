import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import type { Net } from './ports.js';
import { privateReason } from './addresses.js';

/**
 * The outbound network, and the only place in the platform that opens a
 * socket. Everything else takes the `Net` port.
 *
 * Declared in M0 and left unimplemented on purpose; implemented now because
 * real connectors were asked for and a connector that cannot make a request
 * is a drawing of a connector.
 *
 * **Why `node:http` rather than global `fetch`.** Not preference — the
 * address checks in `security/egress.ts` are worthless without DNS pinning,
 * and global `fetch` gives no hook into name resolution. A validator that
 * resolves a hostname, approves the address, and then hands the *hostname*
 * to the socket has checked nothing: DNS rebinding answers the validator
 * with a public address and the socket with `127.0.0.1`. Here the custom
 * `lookup` is the single resolution, it is validated, and the connection
 * goes to that address.
 *
 * This file sees no policy. It does not know about allow-lists, budgets or
 * trust; it refuses private addresses because that refusal must not be
 * skippable by a caller who forgot a check, and everything else is decided
 * one layer up.
 */

export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(readonly code: 'dns' | 'refused' | 'timeout' | 'protocol', message: string) {
    super(message);
  }
}

export interface RealNetOptions {
  /** Hard ceiling on a single response, independent of any caller's budget. */
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export class RealNet implements Net {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: RealNetOptions = {}) {
    this.maxBytes = options.maxBytes ?? 8_000_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.userAgent = options.userAgent ?? 'arish/0.1 (+personal agent; no inference)';
  }

  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    if (!secure && target.protocol !== 'http:') {
      return Promise.reject(new TransportError('protocol', `${target.protocol} is not a transport this build speaks.`));
    }

    /*
     * A literal address never reaches `lookup` — Node dials it directly —
     * so the pinned resolver below would never see `http://127.0.0.1/` and
     * the whole check could be walked around by not using a hostname.
     * Found by a test that expected a refusal and got a 200.
     */
    const literal = privateReason(target.hostname);
    if (literal !== null) {
      return Promise.reject(new TransportError(
        'dns', `${target.hostname} is unreachable: ${literal}.`,
      ));
    }

    return new Promise((resolve, reject) => {
      const send = secure ? httpsRequest : httpRequest;
      const req = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: init.method ?? 'GET',
          headers: { 'user-agent': this.userAgent, ...(init.headers ?? {}) },
          // Redirects are followed by the egress layer, which re-validates
          // every hop. Following them here would bypass that entirely.
          lookup: pinnedLookup,
          timeout: this.timeoutMs,
        },
        (res) => collect(res, this.maxBytes, resolve, reject),
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new TransportError('timeout', `No response within ${this.timeoutMs}ms.`));
      });
      req.on('error', (error) => {
        reject(error instanceof TransportError ? error : new TransportError('refused', error.message));
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }
}

/** Read the body under a hard ceiling, then normalise the headers. */
function collect(
  res: IncomingMessage,
  maxBytes: number,
  resolve: (value: { status: number; headers: Record<string, string>; body: string }) => void,
  reject: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      reject(new TransportError('refused', `Response exceeded ${maxBytes} bytes.`));
      return;
    }
    chunks.push(chunk);
  });
  res.on('end', () => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
    resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
  });
  res.on('error', (error: Error) => reject(new TransportError('refused', error.message)));
}

/**
 * Resolve once, validate what came back, connect to exactly that.
 *
 * The signature is Node's, awkwardly overloaded, because this is handed
 * straight to `http.request`. The important line is the refusal: a name
 * that resolves inside the trust boundary never reaches a socket, and it
 * cannot resolve differently a second time because there is no second time.
 */
function pinnedLookup(
  hostname: string,
  _options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookup(hostname, { family: 0 }, (error, address, family) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }
    if (privateReason(address) !== null) {
      const refusal = new TransportError(
        'dns',
        `${hostname} resolves to ${address}, which is inside the trust boundary. ` +
        'A public name resolving to a private address is the signature of DNS rebinding.',
      ) as NodeJS.ErrnoException;
      callback(refusal, '', 0);
      return;
    }
    callback(null, address, family);
  });
}

/**
 * The honest no-transport implementation, kept for the default build.
 *
 * `arish doctor` reports which one is installed, because "the request
 * failed" and "this build cannot make requests" are different facts and a
 * user is entitled to know which one they are looking at.
 */
export class NoNet implements Net {
  fetch(): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return Promise.reject(new TransportError('refused', 'This build has no network transport configured.'));
  }
}
