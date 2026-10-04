import type { CryptoPort, Clock, Ids, Storage } from '../ports.js';
import { GENESIS_HASH, hashEvent } from './hash.js';
import { upcast } from './migrations/index.js';
import { payloadSchema } from './registry.js';
import { createRedactor, redactPayload, type Redactor } from './redact.js';
import {
  EventError,
  type EventQuery,
  type EventType,
  isEventType,
  type NewEvent,
  type StoredEvent,
  type TrustLevel,
} from './types.js';

/** A projector reacts to an event inside the same transaction as the append. */
export interface Projector {
  readonly name: string;
  /** Tables this projector owns. `reset()` must clear exactly these. */
  readonly tables: readonly string[];
  apply(event: StoredEvent, storage: Storage): void;
  reset(storage: Storage): void;
}

export interface EventLog {
  append(event: NewEvent): StoredEvent;
  read(query?: EventQuery): StoredEvent[];
  count(): number;
  head(): { seq: number; hash: string };
  verifyChain(): ChainResult;
  register(projector: Projector): void;
  projectors(): readonly Projector[];
  rebuild(): { events: number; projectors: number };
}

export type ChainResult =
  | { ok: true; events: number }
  | { ok: false; events: number; brokenAt: number; reason: string };

interface EventRow {
  seq: number; id: string; type: string; ts: number; actor: string; trust: string;
  session_id: string | null; run_id: string | null; correlation_id: string | null;
  causation_id: string | null; schema_version: number; payload: string;
  prev_hash: string; hash: string;
}

/** Everything the module-level helpers need. Kept explicit so none of them close over hidden state. */
interface LogContext {
  storage: Storage;
  clock: Clock;
  ids: Ids;
  crypto: CryptoPort;
  redactor: Redactor;
  projectors: Projector[];
}

/** Rows replayed per page during a rebuild. Bounded memory, few round trips. */
const REBUILD_PAGE_SIZE = 1000;

const INSERT = `
  INSERT INTO events (id, type, ts, actor, trust, session_id, run_id, correlation_id,
                      causation_id, schema_version, payload, prev_hash, hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

function head(ctx: LogContext): { seq: number; hash: string } {
  const row = ctx.storage
    .prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1')
    .get<{ seq: number; hash: string }>();
  return row ?? { seq: 0, hash: GENESIS_HASH };
}

function validate(event: NewEvent): Record<string, unknown> {
  const schema = payloadSchema(event.type);
  if (!schema) {
    throw new EventError(
      'unregistered_event_type',
      `No payload schema registered for '${event.type}'. Register one in events/registry.ts ` +
        'as part of the milestone that emits it (decision 003).',
      { type: event.type },
    );
  }
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) {
    throw new EventError('invalid_payload', `Invalid payload for '${event.type}': ${parsed.error.message}`, {
      type: event.type,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function draftFrom(event: NewEvent, seq: number, prevHash: string, ts: number, id: string, payload: Record<string, unknown>): Omit<StoredEvent, 'hash'> {
  return {
    seq, id, ts, payload, prevHash,
    type: event.type,
    actor: event.actor,
    trust: event.trust,
    sessionId: event.sessionId ?? null,
    runId: event.runId ?? null,
    correlationId: event.correlationId ?? null,
    causationId: event.causationId ?? null,
    schemaVersion: event.schemaVersion ?? 1,
  };
}

function appendEvent(ctx: LogContext, event: NewEvent): StoredEvent {
  // Validate, then redact, then hash — in that order. Redacting first would
  // mean validating bytes that were never stored; hashing first would mean
  // the chain covers content the database does not hold.
  const payload = redactPayload(validate(event), ctx.redactor);
  const ts = ctx.clock.now();
  const id = ctx.ids.ulid();

  return ctx.storage.transaction(() => {
    const prev = head(ctx);
    const draft = draftFrom(event, prev.seq + 1, prev.hash, ts, id, payload);
    const hash = hashEvent(ctx.crypto, draft);

    const result = ctx.storage.prepare(INSERT).run(
      draft.id, draft.type, draft.ts, draft.actor, draft.trust, draft.sessionId,
      draft.runId, draft.correlationId, draft.causationId, draft.schemaVersion,
      JSON.stringify(draft.payload), draft.prevHash, hash,
    );

    // AUTOINCREMENT assigns the real seq; trust it over the optimistic read
    // so a concurrent writer cannot make the stored row disagree with the chain.
    const seq = Number(result.lastInsertRowid);
    if (seq !== draft.seq) {
      throw new EventError('chain_broken', `Concurrent append: expected seq ${draft.seq}, got ${seq}.`, { seq });
    }

    // Projection happens inside the transaction (§15): a projector that throws
    // rolls the event back, so the log never holds an event its projections
    // could not absorb.
    const stored: StoredEvent = { ...draft, seq, hash };
    for (const projector of ctx.projectors) projector.apply(stored, ctx.storage);
    return stored;
  });
}

function hydrate(row: EventRow): StoredEvent {
  if (!isEventType(row.type)) {
    throw new EventError('unknown_schema_version', `Stored event ${row.seq} has unknown type '${row.type}'.`, {
      seq: row.seq, type: row.type,
    });
  }
  const raw = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    seq: row.seq, id: row.id, type: row.type, ts: row.ts, actor: row.actor,
    trust: row.trust as TrustLevel,
    sessionId: row.session_id, runId: row.run_id,
    correlationId: row.correlation_id, causationId: row.causation_id,
    schemaVersion: row.schema_version,
    payload: upcast(row.type, row.schema_version, raw),
    prevHash: row.prev_hash, hash: row.hash,
  };
}

/** Build the WHERE clause for a query. All filters are conjunctive. */
function whereFor(query: EventQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    if (value === undefined) return;
    where.push(sql);
    params.push(value);
  };
  add('seq >= ?', query.fromSeq);
  add('seq <= ?', query.toSeq);
  add('session_id = ?', query.sessionId);
  add('run_id = ?', query.runId);
  add('correlation_id = ?', query.correlationId);
  add('trust = ?', query.trust);
  if (query.types && query.types.length > 0) {
    where.push(`type IN (${query.types.map(() => '?').join(',')})`);
    params.push(...query.types);
  }
  return { clause: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '', params };
}

function readEvents(ctx: LogContext, query: EventQuery): StoredEvent[] {
  const { clause, params } = whereFor(query);
  const limit = query.limit === undefined ? '' : ` LIMIT ${Math.max(0, Math.trunc(query.limit))}`;
  // Total order, always (§16): a digest over an unordered query is not a digest.
  const sql = `SELECT * FROM events${clause} ORDER BY seq ASC${limit}`;
  return ctx.storage.prepare(sql).all<EventRow>(...params).map(hydrate);
}

/** Re-derive one row's hash and compare. Returns a reason, or null when sound. */
function checkRow(ctx: LogContext, row: EventRow, expectedSeq: number, expectedPrev: string): string | null {
  if (row.seq !== expectedSeq) return `gap: expected seq ${expectedSeq}`;
  if (row.prev_hash !== expectedPrev) return 'prevHash does not match the preceding event';
  // Re-hash the *stored* payload, not the upcast one: upcasting is a read
  // transformation and must not change what the chain commits to.
  const stored = JSON.parse(row.payload) as Record<string, unknown>;
  const recomputed = hashEvent(ctx.crypto, { ...hydrate(row), payload: stored });
  return recomputed === row.hash ? null : 'content does not match its hash';
}

function verifyChain(ctx: LogContext): ChainResult {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  let seen = 0;
  for (const row of ctx.storage.prepare('SELECT * FROM events ORDER BY seq ASC').iterate<EventRow>()) {
    seen++;
    const problem = checkRow(ctx, row, expectedSeq, expectedPrev);
    if (problem !== null) return { ok: false, events: seen, brokenAt: row.seq, reason: problem };
    expectedPrev = row.hash;
    expectedSeq++;
  }
  return { ok: true, events: seen };
}

function rebuildAll(ctx: LogContext): { events: number; projectors: number } {
  return ctx.storage.transaction(() => {
    for (const projector of ctx.projectors) projector.reset(ctx.storage);
    let events = 0;
    // Paged, not iterated. SQLite will not accept writes on a connection with
    // an open cursor, and projectors write by definition — so a live iterator
    // throws "database connection is busy" the moment the first one fires.
    // Paging by seq keeps memory bounded (a real log is far larger than
    // §16's ten thousand) without holding a cursor open.
    const page = ctx.storage.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?');
    let cursor = 0;
    for (;;) {
      const rows = page.all<EventRow>(cursor, REBUILD_PAGE_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = hydrate(row);
        for (const projector of ctx.projectors) projector.apply(event, ctx.storage);
        events++;
        cursor = row.seq;
      }
    }
    return { events, projectors: ctx.projectors.length };
  });
}

export function createEventLog(deps: {
  storage: Storage;
  clock: Clock;
  ids: Ids;
  crypto: CryptoPort;
  redactor?: Redactor;
}): EventLog {
  const ctx: LogContext = {
    storage: deps.storage,
    clock: deps.clock,
    ids: deps.ids,
    crypto: deps.crypto,
    redactor: deps.redactor ?? createRedactor(),
    projectors: [],
  };

  return {
    append: (event) => appendEvent(ctx, event),
    read: (query = {}) => readEvents(ctx, query),
    count: () => ctx.storage.prepare('SELECT COUNT(*) AS n FROM events').get<{ n: number }>()?.n ?? 0,
    head: () => head(ctx),
    verifyChain: () => verifyChain(ctx),
    register: (projector) => void ctx.projectors.push(projector),
    projectors: () => ctx.projectors,
    rebuild: () => rebuildAll(ctx),
  };
}

export type { EventType, StoredEvent };
