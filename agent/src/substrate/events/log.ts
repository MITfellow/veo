import { canonicalJson } from '../hash.js';
import type { Clock, Hashing, Ids, Logger, Storage } from '../ports.js';
import { type Event, GENESIS_HASH, computeHash } from './envelope.js';
import { upcast } from './migrations/index.js';
import type { Redactor } from './redact.js';
import {
  EVENT_SCHEMAS,
  type EventType,
  type PayloadInput,
  type PayloadOf,
  type TrustLevel,
  currentVersionOf,
  isEventType,
} from './types.js';

/**
 * The event log: the only source of truth (invariant 1).
 *
 * Everything else in the system is a cache of this table. The three guarantees
 * it makes, and where each is enforced:
 *
 *   ordering     `seq` is assigned inside an IMMEDIATE transaction, so two
 *                writers cannot interleave into the same number.
 *   immutability triggers in the schema reject UPDATE and DELETE outright.
 *   integrity    each row hashes its predecessor's hash, so any edit, reorder
 *                or deletion breaks the chain at a detectable point.
 *
 * Append is the only write path, and it does four things in one transaction:
 * validate the payload, redact it, hash it, and run the projectors. If a
 * projector throws, the event is rolled back too — a projection that exists
 * without its cause would be a lie.
 */

export interface AppendInput<T extends EventType> {
  type: T;
  payload: PayloadInput<T>;
  principal: string;
  trust: TrustLevel;
  correlationId?: string;
  causationId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  stepId?: string | null;
}

export interface Projector {
  name: string;
  /** Bump to force a rebuild of just this projection. */
  version: number;
  /** Which types it reacts to; `'*'` for everything. */
  handles: readonly EventType[] | '*';
  apply(event: Event, storage: Storage): void;
  /** Tables it owns, dropped and recreated on rebuild. */
  reset(storage: Storage): void;
}

export interface ReadQuery {
  fromSeq?: number;
  toSeq?: number;
  /** Wall-clock window. Metrics ask by time; replay asks by seq. */
  fromTs?: number;
  toTs?: number;
  sessionId?: string;
  runId?: string;
  correlationId?: string;
  types?: readonly EventType[];
  minTrust?: TrustLevel;
  limit?: number;
  /** Newest first. Defaults to oldest first — replay order. */
  reverse?: boolean;
}

interface EventRow {
  seq: number;
  id: string;
  ts: number;
  principal: string;
  session_id: string | null;
  run_id: string | null;
  step_id: string | null;
  type: string;
  payload: string;
  trust: string;
  causation_id: string | null;
  correlation_id: string;
  schema_version: number;
  prev_hash: string;
  hash: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  problems: Array<{ seq: number; id: string; problem: string }>;
}

export class EventLog {
  private readonly projectors: Projector[] = [];

  constructor(
    private readonly storage: Storage,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly hashing: Hashing,
    private readonly redactor: Redactor,
    private readonly logger?: Logger,
  ) {}

  register(projector: Projector): void {
    if (this.projectors.some((p) => p.name === projector.name)) {
      throw new Error(`projector ${projector.name} already registered`);
    }
    this.projectors.push(projector);
    this.storage.run(
      `INSERT INTO projection_state (name, last_seq, version, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
      [projector.name, projector.version, this.clock.now()],
    );
  }

  /* ─────────────────────────────── append ─────────────────────────────── */

  append<T extends EventType>(input: AppendInput<T>): Event<T> {
    if (!isEventType(input.type)) {
      throw new Error(`unknown event type: ${String(input.type)}`);
    }

    // 1. Validate against the type's own schema. Before any write, so a bad
    //    payload is a caller error rather than a corrupt row.
    const schema = EVENT_SCHEMAS[input.type];
    const parsed = schema.safeParse(input.payload);
    if (!parsed.success) {
      throw new Error(
        `invalid payload for ${input.type}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'} ${i.message}`)
          .join('; ')}`,
      );
    }

    // 2. Redact here, in the one place every event must pass through, so no
    //    call site can forget (invariant 7).
    const payload = this.redactor.redact(parsed.data as unknown);

    return this.storage.transaction(() => {
      const prev = this.storage.get<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1',
      );
      const seq = (prev?.seq ?? 0) + 1;
      const prevHash = prev?.hash ?? GENESIS_HASH;

      const withoutHash: Omit<Event<T>, 'hash'> = {
        id: this.ids.ulid(),
        seq,
        ts: this.clock.now(),
        principal: input.principal,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        stepId: input.stepId ?? null,
        type: input.type,
        payload,
        trust: input.trust,
        causationId: input.causationId ?? null,
        // Default to the event's own id so every event belongs to some
        // correlation; an unattributable event is an unanswerable "why".
        correlationId: '',
        schemaVersion: currentVersionOf(input.type),
        prevHash,
      };
      withoutHash.correlationId = input.correlationId ?? withoutHash.id;

      const event: Event<T> = {
        ...withoutHash,
        hash: computeHash(this.hashing, withoutHash),
      };

      this.storage.run(
        `INSERT INTO events (
           seq, id, ts, principal, session_id, run_id, step_id, type, payload,
           trust, causation_id, correlation_id, schema_version, prev_hash, hash
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          event.seq,
          event.id,
          event.ts,
          event.principal,
          event.sessionId,
          event.runId,
          event.stepId,
          event.type,
          canonicalJson(event.payload),
          event.trust,
          event.causationId,
          event.correlationId,
          event.schemaVersion,
          event.prevHash,
          event.hash,
        ],
      );

      // 3. Projections commit with the event or not at all.
      this.project(event);

      return event;
    });
  }

  private project(event: Event): void {
    for (const p of this.projectors) {
      if (p.handles !== '*' && !p.handles.includes(event.type)) continue;
      p.apply(event, this.storage);
      this.storage.run(
        'UPDATE projection_state SET last_seq = ?, updated_at = ? WHERE name = ?',
        [event.seq, event.ts, p.name],
      );
    }
  }

  /* ──────────────────────────────── read ──────────────────────────────── */

  read(query: ReadQuery = {}): Event[] {
    const { clause, params } = this.filter(query);

    const sql =
      `SELECT * FROM events` +
      clause +
      ` ORDER BY seq ${query.reverse === true ? 'DESC' : 'ASC'}` +
      (query.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : '');

    return this.storage.all<EventRow>(sql, params).map((r) => rowToEvent(r));
  }

  /** The WHERE shared by `read` and `count`, built once so they cannot drift. */
  private filter(query: ReadQuery): { clause: string; params: Array<string | number> } {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.fromSeq !== undefined) {
      where.push('seq >= ?');
      params.push(query.fromSeq);
    }
    if (query.toSeq !== undefined) {
      where.push('seq <= ?');
      params.push(query.toSeq);
    }
    if (query.fromTs !== undefined) {
      where.push('ts >= ?');
      params.push(query.fromTs);
    }
    if (query.toTs !== undefined) {
      where.push('ts <= ?');
      params.push(query.toTs);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (query.runId !== undefined) {
      where.push('run_id = ?');
      params.push(query.runId);
    }
    if (query.correlationId !== undefined) {
      where.push('correlation_id = ?');
      params.push(query.correlationId);
    }
    if (query.types && query.types.length > 0) {
      where.push(`type IN (${query.types.map(() => '?').join(',')})`);
      params.push(...query.types);
    }
    if (query.minTrust !== undefined) {
      const allowed = TRUST_AT_LEAST[query.minTrust];
      where.push(`trust IN (${allowed.map(() => '?').join(',')})`);
      params.push(...allowed);
    }

    return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  }

  byId(id: string): Event | undefined {
    const row = this.storage.get<EventRow>('SELECT * FROM events WHERE id = ?', [id]);
    return row ? rowToEvent(row) : undefined;
  }

  bySeq(seq: number): Event | undefined {
    const row = this.storage.get<EventRow>('SELECT * FROM events WHERE seq = ?', [seq]);
    return row ? rowToEvent(row) : undefined;
  }

  /** Typed accessor: the payload comes back upcast to the current version. */
  payloadOf<T extends EventType>(event: Event, type: T): PayloadOf<T> {
    if (event.type !== type) throw new Error(`event ${event.id} is ${event.type}, not ${type}`);
    return event.payload as PayloadOf<T>;
  }

  head(): { seq: number; hash: string } {
    const row = this.storage.get<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1',
    );
    return row ?? { seq: 0, hash: GENESIS_HASH };
  }

  /**
   * How many events match, ignoring `limit` and `reverse`. No argument
   * means the whole log, which is what every existing caller wants.
   *
   * Paging needs a denominator, and the honest way to get one is to ask
   * the database rather than to read every matching row and measure the
   * array — which is what `GET /events` was doing, at 150k events, on
   * every change of a filter.
   */
  count(query: ReadQuery = {}): number {
    const { clause, params } = this.filter(query);
    return (
      this.storage.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events${clause}`, params)?.n ?? 0
    );
  }

  /**
   * Walk back through `causationId` and return the minimum trust on the path.
   * This is how "trust never increases along a causal chain" is computed when
   * a step needs to know what it is actually allowed to do (§12).
   */
  causalClosure(eventId: string, maxDepth = 256): Event[] {
    const chain: Event[] = [];
    const seen = new Set<string>();
    let current = this.byId(eventId);
    let depth = 0;
    while (current && depth++ < maxDepth) {
      if (seen.has(current.id)) break; // cycles cannot happen, but a corrupt log is a thing
      seen.add(current.id);
      chain.push(current);
      current = current.causationId ? this.byId(current.causationId) : undefined;
    }
    return chain;
  }

  /* ─────────────────────────────── verify ─────────────────────────────── */

  /**
   * Recompute the whole chain. Catches: an edited payload, a forged hash, a
   * deleted row (gap in `seq`), and a reordered row (prev_hash mismatch).
   * Streams in pages so a million-event log does not need a million events in
   * memory.
   */
  verifyChain(pageSize = 2000): ChainVerification {
    const problems: ChainVerification['problems'] = [];
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;

    for (;;) {
      const rows = this.storage.all<EventRow>(
        'SELECT * FROM events WHERE seq >= ? ORDER BY seq ASC LIMIT ?',
        [expectedSeq === 1 ? 0 : expectedSeq, pageSize],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const event = rowToEvent(row);
        checked++;

        if (event.seq !== expectedSeq) {
          problems.push({
            seq: event.seq,
            id: event.id,
            problem: `sequence gap: expected seq ${expectedSeq}, found ${event.seq}`,
          });
          expectedSeq = event.seq;
        }
        if (event.prevHash !== expectedPrev) {
          problems.push({
            seq: event.seq,
            id: event.id,
            problem: `broken link: prev_hash ${event.prevHash.slice(0, 12)}… does not match predecessor ${expectedPrev.slice(0, 12)}…`,
          });
        }
        // Hash the payload *as stored*, not as upcast. An event written at
        // schema v1 and read through an upcaster has a different in-memory
        // payload than the bytes that were hashed; verifying the upcast form
        // would report every migrated event as tampered.
        if (!verifyRowHash(this.hashing, row)) {
          problems.push({ seq: event.seq, id: event.id, problem: 'hash mismatch: content was altered' });
        }

        expectedPrev = event.hash;
        expectedSeq = event.seq + 1;
      }

      if (rows.length < pageSize) break;
    }

    return { ok: problems.length === 0, checked, problems };
  }

  /* ────────────────────────────── rebuild ─────────────────────────────── */

  /**
   * Drop every projection and replay the log.
   *
   * This is the test of invariant 1 and also the real recovery path: a corrupt
   * projection, a changed projector, a new projection added years later — all
   * the same operation. If this cannot reproduce current state exactly, the
   * system has state that lives nowhere durable, which is the failure the
   * whole architecture exists to prevent.
   */
  rebuild(options: { pageSize?: number; onProgress?: (seq: number) => void } = {}): number {
    const pageSize = options.pageSize ?? 1000;

    return this.storage.transaction(() => {
      for (const p of this.projectors) {
        p.reset(this.storage);
        this.storage.run('UPDATE projection_state SET last_seq = 0 WHERE name = ?', [p.name]);
      }

      let fromSeq = 0;
      let replayed = 0;
      for (;;) {
        const rows = this.storage.all<EventRow>(
          'SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
          [fromSeq, pageSize],
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          const event = rowToEvent(row);
          this.project(event);
          fromSeq = event.seq;
          replayed++;
        }
        options.onProgress?.(fromSeq);
        if (rows.length < pageSize) break;
      }

      this.logger?.info('projections rebuilt', { replayed });
      return replayed;
    });
  }
}

/* ───────────────────────────────── helpers ──────────────────────────────── */

const TRUST_AT_LEAST: Record<TrustLevel, TrustLevel[]> = {
  FOREIGN: ['FOREIGN', 'TOOL', 'DERIVED', 'USER', 'SYSTEM'],
  TOOL: ['TOOL', 'DERIVED', 'USER', 'SYSTEM'],
  DERIVED: ['DERIVED', 'USER', 'SYSTEM'],
  USER: ['USER', 'SYSTEM'],
  SYSTEM: ['SYSTEM'],
};

/**
 * Verify a row against the bytes that were actually hashed at write time.
 * Deliberately bypasses the upcasters — see the call site in `verifyChain`.
 */
function verifyRowHash(hashing: Hashing, row: EventRow): boolean {
  if (!isEventType(row.type)) return false;
  const storedPayload: unknown = JSON.parse(row.payload);
  const recomputed = computeHash(hashing, {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    principal: row.principal,
    sessionId: row.session_id,
    runId: row.run_id,
    stepId: row.step_id,
    type: row.type,
    payload: storedPayload,
    trust: row.trust as TrustLevel,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    schemaVersion: row.schema_version,
    prevHash: row.prev_hash,
  });
  return recomputed === row.hash;
}

function rowToEvent(row: EventRow): Event {
  if (!isEventType(row.type)) {
    // A type this build does not know. Refuse rather than guess — silently
    // dropping it would mean a rebuild produces a different world than the log.
    throw new Error(
      `event ${row.id} has type "${row.type}" which this build does not know — ` +
        `the log was written by a newer version`,
    );
  }
  const stored: unknown = JSON.parse(row.payload);
  const { payload } = upcast(row.type, row.schema_version, stored);

  return {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    principal: row.principal,
    sessionId: row.session_id,
    runId: row.run_id,
    stepId: row.step_id,
    type: row.type,
    payload,
    trust: row.trust as TrustLevel,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    schemaVersion: row.schema_version,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export { rowToEvent, verifyRowHash };
