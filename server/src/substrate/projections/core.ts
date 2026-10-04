import type { Storage } from '../ports.js';
import type { Projector } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';

/**
 * Core projections: sessions, messages, runs, captures.
 *
 * Every projector here obeys two rules that §16 depends on:
 *
 *   * **`reset()` clears exactly the tables in `tables`** — no more, so two
 *     projectors never fight, and no less, so a rebuild cannot inherit a
 *     stale row that the log would not have produced.
 *   * **`apply()` is a pure function of the event and prior rows.** Nothing
 *     reads a clock or generates an id; every value comes off the event.
 *     A projector that minted an id would produce different bytes on replay
 *     and the identity test would fail — which is the point of the test.
 */

function clear(storage: Storage, tables: readonly string[]): void {
  for (const table of tables) storage.prepare(`DELETE FROM ${table}`).run();
}

function payloadString(event: StoredEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === 'string' ? value : '';
}

export function sessionsProjector(): Projector {
  const tables = ['sessions'];
  return {
    name: 'sessions',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      switch (event.type) {
        case 'session.started':
          storage.prepare(
            `INSERT OR REPLACE INTO sessions
               (id, started_at, ended_at, channel, title, message_count, last_activity_at)
             VALUES (?,?,NULL,?,?,0,?)`,
          ).run(
            event.sessionId ?? event.id,
            event.ts,
            payloadString(event, 'channel'),
            event.payload['title'] ?? null,
            event.ts,
          );
          return;
        case 'session.ended':
          storage.prepare('UPDATE sessions SET ended_at = ?, last_activity_at = ? WHERE id = ?')
            .run(event.ts, event.ts, event.sessionId);
          return;
        case 'session.titled':
          storage.prepare('UPDATE sessions SET title = ?, last_activity_at = ? WHERE id = ?')
            .run(payloadString(event, 'title'), event.ts, event.sessionId);
          return;
        case 'message.received':
        case 'message.sent':
          storage.prepare(
            'UPDATE sessions SET message_count = message_count + 1, last_activity_at = ? WHERE id = ?',
          ).run(event.ts, event.sessionId);
          return;
        default:
          return;
      }
    },
  };
}

export function messagesProjector(): Projector {
  const tables = ['messages'];
  return {
    name: 'messages',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      if (event.type !== 'message.received' && event.type !== 'message.sent') return;
      storage.prepare(
        `INSERT OR REPLACE INTO messages (id, session_id, seq, role, content, trust, ts)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        payloadString(event, 'messageId'),
        event.sessionId,
        // The event's own seq is the message order. A per-session counter
        // would have to be read back, and would drift under concurrency.
        event.seq,
        payloadString(event, 'role'),
        payloadString(event, 'content'),
        event.trust,
        event.ts,
      );
    },
  };
}

export function runsProjector(): Projector {
  const tables = ['runs'];
  return {
    name: 'runs',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      switch (event.type) {
        case 'run.started':
          storage.prepare(
            `INSERT OR REPLACE INTO runs (id, session_id, status, goal, started_at, ended_at, step_count, stop_reason)
             VALUES (?,?,'running',?,?,NULL,0,NULL)`,
          ).run(event.runId ?? event.id, event.sessionId, event.payload['goal'] ?? null, event.ts);
          return;
        case 'run.step.finished':
          storage.prepare('UPDATE runs SET step_count = step_count + 1 WHERE id = ?').run(event.runId);
          return;
        case 'run.finished': {
          const steps = event.payload['steps'];
          storage.prepare(
            `UPDATE runs SET status = 'finished', ended_at = ?, stop_reason = ?, step_count = ? WHERE id = ?`,
          ).run(event.ts, payloadString(event, 'stopReason'), typeof steps === 'number' ? steps : 0, event.runId);
          return;
        }
        case 'run.failed':
        case 'run.cancelled':
          storage.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?')
            .run(event.type === 'run.failed' ? 'failed' : 'cancelled', event.ts, event.runId);
          return;
        default:
          return;
      }
    },
  };
}

export function capturesProjector(): Projector {
  const tables = ['captures'];
  return {
    name: 'captures',
    tables,
    reset: (storage) => clear(storage, tables),
    apply(event, storage) {
      if (event.type !== 'capture.received') return;
      storage.prepare(
        `INSERT OR REPLACE INTO captures (id, source, kind, content, trust, captured_at, session_id)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        payloadString(event, 'captureId'),
        payloadString(event, 'source'),
        payloadString(event, 'kind'),
        payloadString(event, 'content'),
        // §21: captured content is FOREIGN whatever the envelope claims.
        'FOREIGN',
        event.ts,
        event.sessionId,
      );
    },
  };
}
