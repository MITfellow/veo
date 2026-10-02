import type { Net, NetRequest, NetResponse } from '../../src/substrate/ports.js';

/** A Net that answers from a script. No sockets are opened, ever. */
export class FakeNet implements Net {
  readonly requests: NetRequest[] = [];
  constructor(private readonly handler: (req: NetRequest) => NetResponse) {}

  async fetch(req: NetRequest): Promise<NetResponse> {
    this.requests.push(req);
    return this.handler(req);
  }
}

export function respond(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): NetResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}
