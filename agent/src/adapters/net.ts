/**
 * `NodeNet` — the production Net port (L1 adapter).
 *
 * Thin on purpose. Everything interesting about outbound traffic — which
 * hosts are allowed, how many bytes a run may spend, redirect limits, DNS
 * rebinding, the `egress.allowed` event — already lives in
 * `capability/egress.ts`, which wraps this. Putting any of it here would
 * mean a second place to keep the rules, and the second place is always the
 * one that is out of date.
 *
 * What this does add is a hard timeout. A `fetch` with no timeout is a
 * process that can hang for the rest of the decade.
 */
import type { Net, NetRequest, NetResponse } from '../substrate/ports.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** A fresh, exactly-sized copy — `fetch` will not accept a shared view. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class NodeNet implements Net {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async fetch(request: NetRequest): Promise<NetResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Caller cancellation and our timeout both have to reach the socket.
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await globalThis.fetch(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.body === undefined
          ? {}
          : { body: typeof request.body === 'string' ? request.body : bufferOf(request.body) }),
        signal: controller.signal,
        // Redirects are the egress layer's business: it counts them, checks
        // each hop against the allowlist, and refuses a redirect that leaves
        // the allowed host. Following them here would skip all of that.
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
