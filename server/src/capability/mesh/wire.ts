import { openFromPeer, sealForPeer } from '../../security/link.js';
import {
  BodySchema, FrameSchema, MAX_FRAME_BYTES, MAX_SKEW_MS, MeshError,
  PROTOCOL_VERSION, type Body, type Frame,
} from './types.js';

/**
 * Frames on the wire.
 *
 * The sealed body is bound to its header by AAD, so the three fields an
 * attacker can see — `from`, `to`, `seq` — are also three fields they
 * cannot change. Editing any of them makes the body fail to open, which
 * is the difference between authenticated metadata and decoration.
 *
 * Everything here is symmetric about the two cases: an in-device frame
 * is sealed exactly like one crossing a network. Encrypting a message
 * that never leaves the machine looks redundant until you notice that
 * "never leaves the machine" is a claim about a process boundary, and
 * process boundaries are what attackers cross.
 */

function aad(frame: Omit<Frame, 'sealed'>): string {
  return `${frame.v}|${frame.from}|${frame.to}|${frame.seq}`;
}

export async function sealFrame(
  key: Uint8Array,
  header: { from: string; to: string; seq: number },
  body: Body,
): Promise<Frame> {
  const head = { v: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, ...header };
  const sealed = await sealForPeer(key, JSON.stringify(body), aad(head));
  return { ...head, sealed };
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a frame off the wire, cheaply, before any crypto happens.
 *
 * Size is checked first and on the raw string: a peer must not be able
 * to make the receiver allocate, parse or decrypt something enormous by
 * sending it. Refusing at the byte count costs nothing.
 */
export function decodeFrame(raw: string): Frame {
  if (raw.length > MAX_FRAME_BYTES) {
    throw new MeshError('too_large', `A frame may be ${MAX_FRAME_BYTES} bytes; this one is ${raw.length}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MeshError('malformed', 'That frame is not JSON.');
  }
  const result = FrameSchema.safeParse(parsed);
  if (!result.success) throw new MeshError('malformed', 'That frame is not an ARISH mesh frame.');
  return result.data;
}

export interface OpenExpectation {
  /** The device id this agent answers to. */
  selfId: string;
  peerId: string;
  /** Highest sequence number already accepted from this peer. */
  lastSeqIn: number;
  now: number;
}

/**
 * Open a frame, or say precisely which rule it broke.
 *
 * The order is deliberate — cheapest and most-certain first, so that an
 * attacker learns as little as possible and costs us as little as
 * possible. Addressing and sequencing are free; decryption is not.
 */
export async function openFrame(key: Uint8Array, frame: Frame, expect: OpenExpectation): Promise<Body> {
  if (frame.to !== expect.selfId) {
    throw new MeshError('tampered', `That frame is addressed to ${frame.to}, not to this device.`);
  }
  if (frame.from !== expect.peerId) {
    throw new MeshError('unknown_peer', `That frame claims to be from ${frame.from}.`);
  }
  if (frame.seq <= expect.lastSeqIn) {
    // Strictly increasing, not a window: a window is a replay budget.
    throw new MeshError('replay', `Sequence ${frame.seq} was already used; the last accepted was ${expect.lastSeqIn}.`);
  }

  const body = await decrypt(key, frame);
  if (Math.abs(expect.now - body.sentAt) > MAX_SKEW_MS) {
    throw new MeshError('stale', 'That frame was sealed too long ago, or by a clock too far out.');
  }
  return body;
}

async function decrypt(key: Uint8Array, frame: Frame): Promise<Body> {
  const { sealed, ...head } = frame;
  let plaintext: string;
  try {
    plaintext = await openFromPeer(key, sealed, aad(head));
  } catch (error) {
    throw new MeshError('tampered', error instanceof Error ? error.message : 'That frame did not open.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new MeshError('malformed', 'The sealed body is not JSON.');
  }
  const result = BodySchema.safeParse(parsed);
  if (!result.success) throw new MeshError('malformed', 'The sealed body is not a mesh message.');
  return result.data;
}
