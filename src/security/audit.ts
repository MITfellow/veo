/**
 * Privileged-action audit (§13, §30).
 *
 * The security layer is only worth anything if its decisions are *legible*
 * afterwards. Ten years in, the questions a person actually asks are not
 * "show me the event log" — they are:
 *
 *   - which of my credentials has this thing been using, and how often?
 *   - has anything touched my bank key since March?
 *   - what has it forgotten, and who told it to?
 *   - did it ever try to do something it was not allowed to do?
 *
 * This module answers exactly those, and it answers them **from the event log
 * only** — no separate audit table. A second store would be a second source of
 * truth, could drift from the first, and would be the obvious thing for an
 * attacker to edit (invariant 1). The cost is that queries are a fold over
 * events rather than an index lookup; at the volumes a single person's agent
 * produces that is the right trade, and if it ever stops being right the fix
 * is a projection *derived* from the log, not a parallel ledger.
 *
 * Nothing here can return a secret value: the events it reads never contained
 * one. `vault.secret.read` carries `{ref, tool}` and no payload.
 */
import type { Event } from '../substrate/events/envelope.js';
import type { EventType } from '../substrate/events/types.js';
import type { EventLog } from '../substrate/events/log.js';

/** The event types that record the use of a privilege. */
export const PRIVILEGED_EVENT_TYPES = [
  'vault.secret.created',
  'vault.secret.rotated',
  'vault.secret.read',
  'vault.secret.destroyed',
  'memory.forgotten',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'approval.expired',
] as const satisfies readonly EventType[];

export type PrivilegedEventType = (typeof PRIVILEGED_EVENT_TYPES)[number];

export interface AuditQuery {
  /** Restrict to one secret name, e.g. `'openai'`. */
  secretName?: string;
  /** Restrict to one acting principal, e.g. `'user:ara'`. */
  principal?: string;
  /** Inclusive lower bound, epoch millis — the Clock port's unit, not a second time format. */
  since?: number;
  /** Inclusive upper bound, epoch millis. */
  until?: number;
  types?: readonly PrivilegedEventType[];
  limit?: number;
}

export interface SecretUsage {
  name: string;
  reads: number;
  /** Distinct tools that have read it, sorted. */
  tools: string[];
  firstUse: number | null;
  lastUse: number | null;
  rotations: number;
  destroyed: boolean;
}

export interface ForgottenItem {
  factId: string;
  keyId: string;
  reason: string;
  at: number;
  principal: string;
  eventId: string;
}

function payloadString(event: Event, key: string): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads `{ref: 'secret://name/version'}` or `{name}` — both shapes appear. */
function secretNameOf(event: Event): string | undefined {
  const direct = payloadString(event, 'name');
  if (direct !== undefined) return direct;
  const ref = payloadString(event, 'ref');
  if (ref === undefined) return undefined;
  const match = /^secret:\/\/([^/]+)\//.exec(ref);
  return match?.[1];
}

export class Audit {
  constructor(private readonly events: EventLog) {}

  /**
   * Every privileged action, oldest first.
   *
   * Returns `Event`s rather than a reshaped summary type on purpose: the
   * caller can always see the full provenance — principal, trust, causationId
   * — and nothing is quietly dropped on the way out.
   */
  privilegedActions(query: AuditQuery = {}): Event[] {
    let events = this.events.read({ types: query.types ?? PRIVILEGED_EVENT_TYPES });

    if (query.since !== undefined) events = events.filter((e) => e.ts >= query.since!);
    if (query.until !== undefined) events = events.filter((e) => e.ts <= query.until!);
    if (query.principal !== undefined) {
      events = events.filter((e) => e.principal === query.principal);
    }
    if (query.secretName !== undefined) {
      events = events.filter((e) => secretNameOf(e) === query.secretName);
    }
    if (query.limit !== undefined) events = events.slice(0, query.limit);
    return events;
  }

  /**
   * "Which credentials has this thing been using, and what used them?"
   *
   * One row per secret name that has ever existed — including destroyed ones,
   * because "this key was deleted in March after six months of use" is
   * precisely the kind of thing an audit must still be able to say.
   */
  secretUsage(query: Omit<AuditQuery, 'types'> = {}): SecretUsage[] {
    const byName = new Map<string, SecretUsage>();

    const touch = (name: string): SecretUsage => {
      let row = byName.get(name);
      if (row === undefined) {
        row = { name, reads: 0, tools: [], firstUse: null, lastUse: null, rotations: 0, destroyed: false };
        byName.set(name, row);
      }
      return row;
    };

    const tools = new Map<string, Set<string>>();

    for (const event of this.privilegedActions(query)) {
      const name = secretNameOf(event);
      if (name === undefined) continue;
      const row = touch(name);

      switch (event.type) {
        case 'vault.secret.read': {
          row.reads += 1;
          const tool = payloadString(event, 'tool');
          if (tool !== undefined) {
            const set = tools.get(name) ?? new Set<string>();
            set.add(tool);
            tools.set(name, set);
          }
          if (row.firstUse === null) row.firstUse = event.ts;
          row.lastUse = event.ts;
          break;
        }
        case 'vault.secret.rotated':
          row.rotations += 1;
          break;
        case 'vault.secret.destroyed':
          row.destroyed = true;
          break;
        default:
          break;
      }
    }

    for (const [name, set] of tools) {
      const row = byName.get(name);
      if (row !== undefined) row.tools = [...set].sort();
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * "What has it forgotten, and on whose instruction?"
   *
   * The content is gone (§13.3) but the record of the deletion is not, and
   * must not be: a deletion that leaves no trace is indistinguishable from a
   * deletion that never happened, and from data that silently vanished.
   */
  forgotten(query: Omit<AuditQuery, 'types' | 'secretName'> = {}): ForgottenItem[] {
    return this.privilegedActions({ ...query, types: ['memory.forgotten'] }).map((event) => ({
      factId: payloadString(event, 'factId') ?? '',
      keyId: payloadString(event, 'keyId') ?? '',
      reason: payloadString(event, 'reason') ?? '',
      at: event.ts,
      principal: event.principal,
      eventId: event.id,
    }));
  }

  /** Approvals that were asked for and never resolved — the stuck ones. */
  pendingApprovals(): Event[] {
    const resolved = new Set<string>();
    for (const event of this.events.read({
      types: ['approval.granted', 'approval.denied', 'approval.expired'],
    })) {
      const id = payloadString(event, 'requestId') ?? event.causationId;
      if (id !== undefined && id !== null) resolved.add(id);
    }
    return this.events
      .read({ types: ['approval.requested'] })
      .filter((event) => !resolved.has(payloadString(event, 'requestId') ?? event.id));
  }

  /**
   * A one-screen answer to "what has this thing been doing with its powers?".
   * Deliberately small: a summary nobody reads protects nobody.
   */
  summary(query: Omit<AuditQuery, 'types'> = {}): {
    totalPrivilegedActions: number;
    secretReads: number;
    secretsInUse: number;
    itemsForgotten: number;
    pendingApprovals: number;
    window: { from: number | null; to: number | null };
  } {
    const actions = this.privilegedActions(query);
    const usage = this.secretUsage(query);
    return {
      totalPrivilegedActions: actions.length,
      secretReads: usage.reduce((sum, row) => sum + row.reads, 0),
      secretsInUse: usage.filter((row) => row.reads > 0 && !row.destroyed).length,
      itemsForgotten: actions.filter((e) => e.type === 'memory.forgotten').length,
      pendingApprovals: this.pendingApprovals().length,
      window: {
        from: actions[0]?.ts ?? null,
        to: actions[actions.length - 1]?.ts ?? null,
      },
    };
  }
}
