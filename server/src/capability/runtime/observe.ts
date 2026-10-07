import type { MemoryStore } from '../memory/store.js';
import { encodeBasis } from '../world/claims.js';
import type { Scope } from '../world/contracts.js';
import type { ListEventsOutput } from './gcal.js';
import type { Provenance } from './invoke.js';

/**
 * Turning a connector's answer into memory.
 *
 * Kept out of the runtime and out of the invoker on purpose: *what is
 * worth remembering* is a policy question, and the thing that spoke to
 * Google should not be the thing that decides what the user's history
 * now contains.
 *
 * Three rules, all of them §20:
 *
 *   1. The source trust is the connector's, always FOREIGN here. A
 *      calendar entry is not made more trustworthy by having parsed.
 *   2. The basis is `OBSERVATION`, never `VERIFIED`. We saw the provider
 *      say it; we did not witness the meeting.
 *   3. Confidence is high but not 1. The read succeeded; the calendar
 *      itself can still be wrong, and a value of 1 would outrank a
 *      correction the user later makes by hand.
 */

export const OBSERVED_CONFIDENCE = 0.9;

export interface ObservationContext {
  scope: Scope;
  runId?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Record a calendar listing as facts, one per event.
 *
 * Valid time is the event's own span, not the moment of the read — which
 * is the entire point of having bitemporality in M0 (§M2). "What was on
 * my calendar for last Tuesday, as I believed it last Monday" is then a
 * query rather than a rewrite.
 */
export function recordCalendar(
  memory: MemoryStore,
  listing: ListEventsOutput,
  provenance: Provenance,
  ctx: ObservationContext,
): string[] {
  const source = `${provenance.connectorId}:${provenance.operation}`;
  const basis = encodeBasis('OBSERVATION', ctx.scope, source);
  const ids: string[] = [];

  for (const event of listing.events) {
    if (event.status === 'cancelled') continue;
    const from = Date.parse(event.start);
    const to = Date.parse(event.end);

    ids.push(memory.assert({
      subject: `event:${provenance.connectorId}:${event.id}`,
      predicate: 'summary',
      object: event.summary,
      ...(Number.isNaN(from) ? {} : { validFrom: from }),
      ...(Number.isNaN(to) ? {} : { validTo: to }),
      basis,
      confidence: OBSERVED_CONFIDENCE,
      // A calendar entry changes: it is not a fact about the world that
      // settles. `volatile` is what makes it decay instead of lingering.
      stability: 'volatile',
      sensitivity: 'sensitive',
      sourceTrust: provenance.trust,
      actor: 'agent',
      ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
      ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    }));
  }

  return ids;
}
