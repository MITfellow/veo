import type { EventLog } from '../../substrate/events/log.js';
import type { Logger } from '../../substrate/ports.js';
import type { PeerDirectory } from './directory.js';
import { FrameBudget } from './ratelimit.js';
import { decodeFrame, encodeFrame, openFrame, sealFrame } from './wire.js';
import type { PeerLink } from './transport.js';
import {
  MeshError, REQUEST_TIMEOUT_MS,
  type Answer, type Body, type PeerRecord, type TopicHandler,
} from './types.js';

/**
 * One end of the mesh.
 *
 * `ask()` sends a question and waits for the answer; `receive()` handles
 * whatever arrives. Both directions pass through the same three checks,
 * in the same order, whether the peer is across the room or in the next
 * process:
 *
 *   1. **Is this a paired peer, and did the frame really come from it?**
 *      (`wire.ts` — addressing, sequence, seal.)
 *   2. **Is it allowed to ask this?** (grants.)
 *   3. **What does the handler return?** — data, never an action.
 *
 * What a peer can never do is worth stating plainly, because it is a
 * property of the design and not of the current handler list: there is
 * no message that causes this agent to use a tool, spend money, send
 * mail, or write a fact at anything other than FOREIGN. A peer asks
 * questions and offers information. Everything it offers is quarantined
 * exactly like a web page, because a peer *is* a web page that happens
 * to be friendly (§20, §21).
 */

export interface MeshAgentDeps {
  selfId: string;
  directory: PeerDirectory;
  link: PeerLink;
  handlers: readonly TopicHandler[];
  events: EventLog;
  log: Logger;
  now: () => number;
  newId: () => string;
}

interface Pending {
  topic: string;
  peerId: string;
  sentAt: number;
  settle(answer: Answer): void;
}

export class MeshAgent {
  private readonly pending = new Map<string, Pending>();
  private readonly budget: FrameBudget;
  private readonly byTopic = new Map<string, TopicHandler>();

  constructor(private readonly deps: MeshAgentDeps) {
    this.budget = new FrameBudget(deps.now);
    for (const handler of deps.handlers) this.byTopic.set(handler.topic, handler);
    deps.link.onFrame((raw) => this.receive(raw));
  }

  /** What this agent will answer, and what a peer must be granted to ask. */
  describeTopics(): Array<{ topic: string; requires: string; describes: string }> {
    return [...this.byTopic.values()].map((h) => ({
      topic: h.topic, requires: h.requires, describes: h.describes,
    }));
  }

  /**
   * Ask a peer something and wait for its answer.
   *
   * The returned promise settles with the peer's refusal rather than
   * rejecting: "your laptop will not tell me that" is an answer, and
   * turning it into an exception makes callers handle it by accident.
   */
  async ask(peerId: string, topic: string, payload: unknown): Promise<Answer> {
    const requestId = this.deps.newId();
    const sent = this.send(peerId, { kind: 'ask', requestId, topic, sentAt: this.deps.now(), payload });

    const answer = new Promise<Answer>((resolve) => {
      this.pending.set(requestId, { topic, peerId, sentAt: this.deps.now(), settle: resolve });
    });

    try {
      await sent;
    } catch (error) {
      this.pending.delete(requestId);
      return failure(error);
    }
    return answer;
  }

  /** Offer a peer something unasked. Fire and forget, by design. */
  async share(peerId: string, topic: string, payload: unknown): Promise<void> {
    await this.send(peerId, { kind: 'share', requestId: this.deps.newId(), topic, sentAt: this.deps.now(), payload });
  }

  /**
   * Time out requests whose answers never came.
   *
   * Driven by the caller rather than a timer: a `setTimeout` is a second
   * source of truth about time, invisible to the injected clock, and the
   * vault made exactly this choice for idle locking.
   */
  expire(): number {
    const now = this.deps.now();
    let expired = 0;
    for (const [id, request] of this.pending) {
      if (now - request.sentAt < REQUEST_TIMEOUT_MS) continue;
      this.pending.delete(id);
      request.settle({ ok: false, code: 'timeout', message: `${request.peerId} did not answer.` });
      expired += 1;
    }
    return expired;
  }

  // ───────────────────────────────────────────────────────────── inbound

  async receive(raw: string): Promise<void> {
    let frame;
    try {
      frame = decodeFrame(raw);
    } catch (error) {
      return this.denied('mesh.frame', error);
    }

    // Charged before the seal is opened: an unmetered AEAD open is the
    // expensive path, and metering only what authenticates would leave
    // the flood free. See `ratelimit.ts` for what this costs.
    if (!this.budget.take(frame.from)) {
      this.deps.events.append({
        type: 'policy.denied', actor: `peer:${frame.from}`, trust: 'FOREIGN',
        payload: { rule: 'mesh.rate', detail: `${frame.from} exceeded its frame budget`, capabilities: [] },
      });
      return;
    }

    let peer: PeerRecord;
    let body: Body;
    try {
      peer = this.deps.directory.require(frame.from);
      const keys = await this.deps.directory.keysFor(peer.id);
      body = await openFrame(keys.in, frame, {
        selfId: this.deps.selfId, peerId: peer.id, lastSeqIn: peer.lastSeqIn, now: this.deps.now(),
      });
    } catch (error) {
      return this.denied('mesh.authenticate', error);
    }

    this.deps.directory.acceptSeq(peer.id, frame.seq);
    await this.dispatch(peer, body);
  }

  private async dispatch(peer: PeerRecord, body: Body): Promise<void> {
    if (body.kind === 'answer' || body.kind === 'error') return this.settle(body);
    if (body.kind === 'ping') {
      await this.reply(peer, body, { ok: true, data: { pong: this.deps.now() } });
      return;
    }
    if (body.kind === 'pong') return;

    const answer = await this.serve(peer, body);
    // A share is not answered: it was not a question. It is recorded by
    // its handler, at FOREIGN, and the sender is told nothing about what
    // this device did with it.
    if (body.kind === 'ask') await this.reply(peer, body, answer);
  }

  /** Run a handler for a peer, having checked it is allowed to ask. */
  private async serve(peer: PeerRecord, body: Body): Promise<Answer> {
    const handler = this.byTopic.get(body.topic);
    if (handler === undefined) {
      return { ok: false, code: 'unknown_topic', message: `This device does not answer '${body.topic}'.` };
    }
    if (!peer.grants.includes(handler.requires)) {
      this.deps.events.append({
        type: 'policy.denied', actor: `peer:${peer.id}`, trust: 'FOREIGN',
        payload: { rule: 'mesh.grant', detail: `${peer.label} asked for '${body.topic}' without the '${handler.requires}' grant`, capabilities: [handler.requires] },
      });
      return { ok: false, code: 'not_granted', message: `${handler.requires} is not granted to this device.` };
    }

    try {
      return await handler.handle(body.payload, { peer, now: this.deps.now() });
    } catch {
      // A handler that throws must not take the link down with it, and
      // must not leak its stack to the other device.
      this.deps.log.error('mesh handler failed', { topic: body.topic, peer: peer.id });
      return { ok: false, code: 'handler_failed', message: 'That request could not be completed.' };
    }
  }

  private settle(body: Body): void {
    const request = this.pending.get(body.requestId);
    if (request === undefined) return; // late, duplicate, or never asked
    this.pending.delete(body.requestId);
    request.settle(body.kind === 'answer'
      ? { ok: true, data: body.payload }
      : asFailure(body.payload));
  }

  // ──────────────────────────────────────────────────────────── outbound

  private async reply(peer: PeerRecord, to: Body, answer: Answer): Promise<void> {
    const body: Body = answer.ok
      ? { kind: 'answer', requestId: to.requestId, topic: to.topic, sentAt: this.deps.now(), payload: answer.data }
      : { kind: 'error', requestId: to.requestId, topic: to.topic, sentAt: this.deps.now(), payload: { code: answer.code, message: answer.message } };
    try {
      await this.send(peer.id, body);
    } catch {
      // The asker will time out. There is nowhere to report this to:
      // the only party who wanted the answer is the one unreachable.
      this.deps.log.warn('could not reply to peer', { peer: peer.id, topic: to.topic });
    }
  }

  private async send(peerId: string, body: Body): Promise<void> {
    const peer = this.deps.directory.require(peerId);
    const keys = await this.deps.directory.keysFor(peer.id);
    const seq = this.deps.directory.takeSeq(peer.id);
    const frame = await sealFrame(keys.out, { from: this.deps.selfId, to: peer.id, seq }, body);
    await this.deps.link.send(encodeFrame(frame));
  }

  private denied(rule: string, error: unknown): void {
    const detail = error instanceof MeshError ? `${error.code}: ${error.message}` : 'unreadable frame';
    this.deps.log.warn('mesh frame refused', { rule, detail });
    this.deps.events.append({
      type: 'policy.denied', actor: 'mesh', trust: 'FOREIGN',
      payload: { rule, detail, capabilities: [] },
    });
  }
}

function failure(error: unknown): Answer {
  if (error instanceof MeshError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'unreachable', message: 'That device could not be reached.' };
}

function asFailure(payload: unknown): Answer {
  const shape = payload as { code?: unknown; message?: unknown } | null;
  return {
    ok: false,
    code: typeof shape?.code === 'string' ? shape.code : 'error',
    message: typeof shape?.message === 'string' ? shape.message : 'The peer refused.',
  };
}
