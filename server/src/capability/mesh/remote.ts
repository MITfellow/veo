import type { Net } from '../../substrate/ports.js';
import type { MeshAgent } from './agent.js';
import type { PeerDirectory } from './directory.js';
import { MAX_FRAME_BYTES, MeshError } from './types.js';
import type { FrameHandler, PeerLink } from './transport.js';

/**
 * The between-devices transport: one HTTP POST per frame.
 *
 * **Why this does not go through `Egress`.** The egress guard (013)
 * exists to stop the agent being talked into fetching an address it was
 * never meant to touch — so it refuses private ranges and enforces an
 * allow-list. A peer on the user's own LAN *is* a private address, and
 * putting it on the browsing allow-list would open the whole range to
 * every other subsystem. These are different doors with different
 * threat models, and merging them would weaken the one that matters.
 *
 * So this door is narrower in every dimension instead:
 *
 *   - The destination is **never caller-supplied**. It comes from the
 *     paired peer's record, which a person created by reading a code
 *     aloud. There is no code path from a model, a web page or a peer
 *     message to the address dialled here.
 *   - The path is fixed: `/mesh/frame`. Not a URL — a verb.
 *   - The body is a sealed frame and nothing else. Even a compromised
 *     peer address receives only ciphertext bound to a key it does not
 *     have.
 *   - Size is capped before sending, so a bug upstream cannot turn into
 *     an upload.
 *
 * Plaintext HTTP is acceptable here and only here: the payload is
 * already sealed and authenticated by `security/link.ts`, so TLS would
 * add confidentiality we already have and certificate management we
 * cannot do on a LAN of self-named devices.
 */

export const MESH_PATH = '/mesh/frame';

export interface RemoteLinkDeps {
  selfId: string;
  net: Net;
  directory: PeerDirectory;
}

/**
 * An outbound link to every paired peer.
 *
 * One link object serves all peers because the address is looked up per
 * frame, from the directory, at send time — so revoking a peer or
 * changing its address takes effect on the next frame rather than
 * requiring the link to be rebuilt.
 */
export class RemotePeerLink implements PeerLink {
  private handler: FrameHandler | null = null;
  private observer: ((raw: string) => void) | null = null;

  constructor(private readonly deps: RemoteLinkDeps) {}

  /**
   * See every frame as it goes out, after sealing.
   *
   * For diagnostics and for the test that asserts a question never
   * reaches the wire in the clear. It is handed the sealed frame, which
   * is all that exists at this point — there is no hook that could leak
   * plaintext because there is no plaintext here to leak.
   */
  watch(observer: (raw: string) => void): void {
    this.observer = observer;
  }

  get selfId(): string {
    return this.deps.selfId;
  }

  async send(raw: string): Promise<void> {
    if (raw.length > MAX_FRAME_BYTES) {
      throw new MeshError('too_large', 'That frame is larger than the link will carry.');
    }
    this.observer?.(raw);
    const peer = this.deps.directory.require(destinationOf(raw));
    if (peer.address === '') {
      throw new MeshError('unknown_peer', `${peer.label} has no address; it is an in-device link.`);
    }

    const response = await this.deps.net.fetch(`http://${peer.address}${MESH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });

    if (response.status !== 202) {
      throw new MeshError('timeout', `${peer.label} answered ${response.status} to a frame.`);
    }
  }

  /** Called by the HTTP layer when a frame arrives. */
  async deliver(raw: string): Promise<void> {
    if (this.handler === null) throw new MeshError('unknown_peer', 'This device has no mesh receiver attached.');
    await this.handler(raw);
  }

  onFrame(handler: FrameHandler): void {
    this.handler = handler;
  }

  close(): void {
    this.handler = null;
  }
}

/**
 * Handle an inbound frame POST.
 *
 * Always 202, whatever happened. A frame from an unpaired device, a
 * replay and a perfectly good question all look identical from outside,
 * because a status code that distinguished them would be an oracle: an
 * attacker could discover which device ids are paired, and which
 * sequence numbers have been used, without ever holding a key.
 *
 * The real answer, when there is one, arrives as a separate frame in the
 * other direction. The mesh is message-passing that happens to ride on
 * request/response, not request/response pretending to be secure.
 */
export async function receiveMeshFrame(
  agent: MeshAgent,
  raw: unknown,
): Promise<{ status: number; body: { accepted: boolean } }> {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES) {
    return { status: 202, body: { accepted: false } };
  }
  await agent.receive(raw);
  return { status: 202, body: { accepted: true } };
}

function destinationOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'to' in parsed) {
      return String((parsed as { to: unknown }).to);
    }
  } catch {
    // fall through to the throw below
  }
  throw new MeshError('malformed', 'That frame has no destination.');
}
