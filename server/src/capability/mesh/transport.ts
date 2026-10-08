import { MAX_FRAME_BYTES, MeshError } from './types.js';

/**
 * How a frame gets from one agent to another.
 *
 * One interface for both cases. The protocol above it cannot tell
 * whether a frame crossed a process boundary or a continent, which is
 * what makes "in device" and "between devices" the same feature rather
 * than two features that drift apart.
 *
 * Deliberately dumb: a link moves opaque strings and reports whether it
 * could. It does not retry, order, authenticate, or interpret. Every one
 * of those is already handled above, and a transport that quietly
 * retried would turn a sequence number into a replay.
 */

export type FrameHandler = (raw: string) => Promise<void>;

export interface PeerLink {
  /** Which device this end belongs to. */
  readonly selfId: string;
  /** Deliver a frame. Rejects if it could not be handed over. */
  send(raw: string): Promise<void>;
  /** Install the receiver. Exactly one; a second call replaces it. */
  onFrame(handler: FrameHandler): void;
  close(): void;
}

/**
 * The in-device case: a switch that routes frames between agents in one
 * process by device id.
 *
 * This is also the test transport, which is the point — the thing the
 * adversarial tests attack is the thing that ships for local links,
 * rather than a simulation of it.
 */
export class InProcessSwitch {
  private readonly ends = new Map<string, FrameHandler>();
  /** Every frame that crossed, for inspection. Not part of delivery. */
  readonly traffic: Array<{ from: string; to: string; raw: string }> = [];
  /** Device ids that silently drop what they are sent. */
  private readonly partitioned = new Set<string>();

  link(selfId: string): PeerLink {
    const ends = this.ends;
    let handler: FrameHandler | null = null;
    ends.set(selfId, async (raw) => {
      if (handler === null) throw new MeshError('unknown_peer', `${selfId} has no receiver attached.`);
      await handler(raw);
    });

    return {
      selfId,
      send: async (raw: string): Promise<void> => {
        await this.deliver(selfId, raw);
      },
      onFrame: (next: FrameHandler): void => {
        handler = next;
      },
      close: (): void => {
        ends.delete(selfId);
      },
    };
  }

  /** Simulate a device going offline, without unpairing it. */
  partition(deviceId: string): void {
    this.partitioned.add(deviceId);
  }

  heal(deviceId: string): void {
    this.partitioned.delete(deviceId);
  }

  private async deliver(from: string, raw: string): Promise<void> {
    if (raw.length > MAX_FRAME_BYTES) {
      throw new MeshError('too_large', 'That frame is larger than the link will carry.');
    }
    // The destination is read from the frame header, which is the only
    // part a switch is allowed to look at. It cannot open the body, and
    // it is not trusted by either end — it is a wire, not a party.
    const to = destinationOf(raw);
    this.traffic.push({ from, to, raw });

    if (this.partitioned.has(to)) {
      throw new MeshError('timeout', `${to} is not reachable.`);
    }
    const end = this.ends.get(to);
    if (end === undefined) throw new MeshError('unknown_peer', `No device ${to} on this switch.`);
    await end(raw);
  }
}

function destinationOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'to' in parsed) {
      return String((parsed as { to: unknown }).to);
    }
  } catch {
    // fall through
  }
  throw new MeshError('malformed', 'That frame has no destination.');
}

/** Two ends of one in-process link, for the two-agent case. */
export function loopbackPair(aId: string, bId: string): { a: PeerLink; b: PeerLink; wire: InProcessSwitch } {
  const wire = new InProcessSwitch();
  return { a: wire.link(aId), b: wire.link(bId), wire };
}
