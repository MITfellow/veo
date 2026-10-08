import { z } from 'zod';
import type { MemoryStore } from '../memory/store.js';
import { recall } from '../memory/recall.js';
import { encodeBasis } from '../world/claims.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { Answer, TopicHandler } from './types.js';

/**
 * What one agent will answer another.
 *
 * Each handler answers the **least** that satisfies the question. The
 * availability handler is the example to read: asked whether its owner
 * is free, it returns busy *intervals* — start and end, nothing else.
 * Not titles, not attendees, not locations. The asking device learns
 * that Thursday afternoon is blocked and does not learn that it is
 * blocked by an interview.
 *
 * That is not politeness. Two devices owned by the same person still
 * have different exposure: the laptop in the office is not the phone in
 * a pocket, and a link that copies everything to both halves the value
 * of having two machines.
 */

const MAX_RESULTS = 20;

/** "Is anyone home?" The cheapest possible question. */
export function presenceHandler(deps: { label: string; now: () => number }): TopicHandler {
  return {
    topic: 'presence',
    requires: 'presence',
    describes: 'Whether this device is awake, and what it is called.',
    handle: (): Promise<Answer> => Promise.resolve({
      ok: true,
      data: { label: deps.label, awake: true, at: deps.now() },
    }),
  };
}

const availabilityAsk = z.object({
  from: z.number().int(),
  to: z.number().int(),
}).strict();

/**
 * Busy intervals in a window. No titles, ever.
 *
 * The facts it reads are calendar observations recorded by `observe.ts`;
 * their valid time *is* the event's span, which is why this can answer
 * with a bitemporal query rather than a special-purpose index.
 */
export function availabilityHandler(deps: { memory: MemoryStore }): TopicHandler {
  return {
    topic: 'availability',
    requires: 'availability',
    describes: 'Which times are already taken, as intervals with no detail.',
    handle: (payload): Promise<Answer> => {
      const parsed = availabilityAsk.safeParse(payload);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, code: 'malformed', message: 'Ask with a from and a to, in epoch milliseconds.' });
      }
      const { from, to } = parsed.data;
      if (to <= from) {
        return Promise.resolve({ ok: false, code: 'malformed', message: 'The window ends before it starts.' });
      }

      const busy = deps.memory
        .during(from, to, { predicate: 'summary' })
        .filter((f) => f.subject.startsWith('event:'))
        .map((f) => ({ start: f.validFrom, end: f.validTo ?? f.validFrom }));

      return Promise.resolve({ ok: true, data: { from, to, busy: dedupe(busy) } });
    },
  };
}

const recallAsk = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
}).strict();

/**
 * Let a peer search this device's memory.
 *
 * The most dangerous grant, and so the most restricted: normal
 * sensitivity only, a hard result cap, and the trust of every fact
 * returned travels with it. A peer asking does not raise what it may
 * see — `maxSensitivity: 'normal'` is not configurable from the wire.
 */
export function recallHandler(deps: { memory: MemoryStore; now: () => number }): TopicHandler {
  return {
    topic: 'memory.recall',
    requires: 'recall',
    describes: 'Search this device\'s memory. Only non-sensitive facts are returned.',
    handle: (payload): Promise<Answer> => {
      const parsed = recallAsk.safeParse(payload);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, code: 'malformed', message: 'Ask with a query string.' });
      }
      const results = recall(deps.memory, deps.now(), {
        query: parsed.data.query,
        limit: parsed.data.limit,
        maxSensitivity: 'normal',
        record: false,
      });
      return Promise.resolve({
        ok: true,
        data: {
          facts: results.map((r) => ({
            subject: r.fact.subject,
            predicate: r.fact.predicate,
            object: r.fact.object,
            confidence: r.fact.confidence,
            // The peer is told how trusted this was *here*, so it cannot
            // be laundered into something better over there.
            trust: r.fact.trust,
          })),
        },
      });
    },
  };
}

const shareOffer = z.object({
  subject: z.string().min(1).max(200),
  predicate: z.string().min(1).max(100),
  object: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();

/**
 * Accept something a peer offers.
 *
 * Written at **FOREIGN**, basis `OBSERVATION`, scope `UNKNOWN`, with the
 * peer named in the basis — and with the peer's own confidence halved,
 * because a claim that has crossed a device boundary has been through a
 * system whose state we cannot see. The event log records a
 * `capture.received` from `peer:<id>`, so the provenance of anything a
 * peer put here is a query, not a reconstruction.
 *
 * Nothing a peer shares can supersede, retract or correct an existing
 * fact. It can only be added, and `winner()` already prefers a
 * USER_ASSERTION over an OBSERVATION whatever the timestamps say.
 */
export function shareHandler(deps: {
  memory: MemoryStore; events: EventLog; now: () => number; newId: () => string;
}): TopicHandler {
  return {
    topic: 'fact.share',
    requires: 'share',
    describes: 'Accept a fact from this peer. It is stored as FOREIGN and cannot overwrite anything.',
    handle: (payload, ctx): Promise<Answer> => {
      const parsed = shareOffer.safeParse(payload);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, code: 'malformed', message: 'A shared fact needs a subject, predicate and object.' });
      }
      const offer = parsed.data;
      const captureId = deps.newId();

      deps.events.append({
        type: 'capture.received',
        actor: `peer:${ctx.peer.id}`,
        trust: 'FOREIGN',
        payload: {
          captureId,
          source: `peer:${ctx.peer.id}`,
          kind: 'text',
          content: `${offer.subject} ${offer.predicate} ${offer.object}`,
        },
      });

      const factId = deps.memory.assert({
        subject: offer.subject,
        predicate: offer.predicate,
        object: offer.object,
        basis: encodeBasis('OBSERVATION', 'UNKNOWN', `peer:${ctx.peer.id}`),
        confidence: offer.confidence * PEER_CONFIDENCE_SCALE,
        stability: 'slow',
        sensitivity: 'normal',
        sourceTrust: 'FOREIGN',
        actor: `peer:${ctx.peer.id}`,
      });

      return Promise.resolve({ ok: true, data: { accepted: true, factId, as: 'FOREIGN' } });
    },
  };
}

/**
 * A peer's confidence is halved on arrival.
 *
 * The same scaling FOREIGN content already gets in M2, applied for the
 * same reason: the number came from a system we cannot inspect, and
 * taking it at face value lets a confident peer outrank a hesitant
 * owner.
 */
export const PEER_CONFIDENCE_SCALE = 0.5;

function dedupe(spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const seen = new Set<string>();
  const out: Array<{ start: number; end: number }> = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span);
  }
  return out;
}
