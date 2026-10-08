import { z } from 'zod';

/**
 * The mesh: one agent talking to another.
 *
 * Two cases, one protocol:
 *
 *   **In device** — two agents in the same process or on the same
 *   machine (the phone's agent and the laptop's agent are different
 *   devices; a background indexer and the foreground assistant are not).
 *   **Between devices** — the laptop asking the phone whether its owner
 *   is free on Thursday.
 *
 * They share every rule and differ only in transport. A local socket is
 * reachable by any process on the machine, and "it is local therefore it
 * is me" is exactly the assumption that makes a local privilege
 * escalation into a full compromise. So the in-device case is paired,
 * sealed and scoped identically; it simply skips the network.
 *
 * The governing rule, from §20: **a peer is FOREIGN.** Another instance
 * of this same program, running for the same human, on hardware they
 * own, is still FOREIGN. It is a different machine with a different
 * history, possibly compromised, and nothing it says may raise its own
 * trust. Every doctrine that applies to a web page applies to a peer.
 */

export const PROTOCOL_VERSION = 1;

/** Frames above this are dropped unread. A peer cannot exhaust memory. */
export const MAX_FRAME_BYTES = 64_000;

/** How far apart two devices' clocks may be before a frame is stale. */
export const MAX_SKEW_MS = 5 * 60_000;

/** How long an unanswered request stays pending. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class MeshError extends Error {
  constructor(
    readonly code:
      | 'unknown_peer' | 'not_paired' | 'bad_code' | 'replay' | 'stale'
      | 'tampered' | 'too_large' | 'not_granted' | 'unknown_topic'
      | 'timeout' | 'malformed' | 'self',
    message: string,
  ) {
    super(message);
    this.name = 'MeshError';
  }
}

/**
 * What a peer is allowed to ask for.
 *
 * Grants are per peer and deliberately coarse and few. A long list of
 * fine-grained permissions is a list nobody reads; four that a person can
 * hold in their head is a decision they can actually make.
 *
 * Note what is absent: there is no grant that lets a peer cause an
 * effect. A peer can ask questions and offer information. It can never
 * make this agent send an email, write a file, or spend money — not
 * because the grant would be refused, but because no such grant exists
 * to give (§19, and the reason the Rule of Two holds across the mesh).
 */
export const GRANTS = ['presence', 'availability', 'recall', 'share'] as const;
export type Grant = (typeof GRANTS)[number];
export const GrantSchema = z.enum(GRANTS);

export interface PeerRecord {
  /** The peer's device id, as it claimed at pairing and signs with now. */
  id: string;
  /** What the user calls it: "Laptop", "Phone". Never trusted for routing. */
  label: string;
  /** How to reach it, or '' for an in-device link that needs no address. */
  address: string;
  grants: readonly Grant[];
  /** `secret://` reference to the pairing secret. Never the secret. */
  keyRef: string;
  /** Highest sequence number accepted from this peer. Replay defence. */
  lastSeqIn: number;
  /** Next sequence number to use when sending. */
  nextSeqOut: number;
  pairedAt: number;
  lastSeenAt: number | null;
  status: 'active' | 'revoked';
}

/**
 * The visible part of a frame.
 *
 * Only what the receiver must read *before* it can decrypt: who it is
 * from, who it is for, and the sequence number. Everything else — topic,
 * payload, timestamps — is inside the sealed body, because a header field
 * is a field an eavesdropper reads and an attacker edits.
 */
export const FrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  seq: z.number().int().min(1),
  /** base64 of the sealed body. */
  sealed: z.string().min(1),
}).strict();

export type Frame = z.infer<typeof FrameSchema>;

export const BODY_KINDS = ['ask', 'answer', 'error', 'share', 'ping', 'pong'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

/**
 * The sealed body.
 *
 * `sentAt` is inside the seal so that a replay cannot be re-dated, and
 * `requestId` is inside it so that an answer cannot be redirected to a
 * different question.
 */
export const BodySchema = z.object({
  kind: z.enum(BODY_KINDS),
  requestId: z.string().min(1).max(64),
  topic: z.string().min(1).max(64),
  sentAt: z.number().int(),
  /** Opaque to the transport. Each topic validates its own shape. */
  payload: z.unknown(),
}).strict();

export type Body = z.infer<typeof BodySchema>;

/** What a handler may return. Never a thrown error for a normal refusal. */
export type Answer =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string };

export interface HandlerContext {
  peer: PeerRecord;
  now: number;
}

export interface TopicHandler {
  readonly topic: string;
  readonly requires: Grant;
  /** One line, shown when the user reviews what a peer may ask. */
  readonly describes: string;
  handle(payload: unknown, ctx: HandlerContext): Promise<Answer>;
}
