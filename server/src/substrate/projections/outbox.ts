import type { Storage } from '../ports.js';
import type { Projector } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';

/**
 * The outbox projection (§13).
 *
 * One row per intended external effect, carrying the state machine:
 *
 * ```
 *   intended ──commit──▶ committed ──compensate──▶ compensated
 *      │
 *      └──reconcile──▶ committed | absent | needs_attention
 * ```
 *
 * `intended` with no terminal state is **the only interesting query in the
 * system after a crash**: it is the set of things that may or may not have
 * happened in the outside world.
 *
 * Like every projector here, `apply` is a pure function of the event: no
 * clock, no ids, nothing that would make a replay produce different bytes.
 */

function payloadString(event: StoredEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === 'string' ? value : '';
}

function payloadFlag(event: StoredEvent, key: string): number {
  return event.payload[key] === true ? 1 : 0;
}

/** The intention: one row, created before the world is touched. */
function applyIntended(event: StoredEvent, storage: Storage): void {
  storage.prepare(`
    INSERT OR REPLACE INTO outbox
      (key, tool, version, run_id, step_id, input_digest, reversible, idempotent,
       status, remote_ref, summary, detail, intended_at, settled_at)
    VALUES (?,?,?,?,?,?,?,?, 'intended', NULL, ?, '', ?, NULL)
  `).run(
    payloadString(event, 'key'), payloadString(event, 'tool'), payloadString(event, 'version'),
    event.runId, payloadString(event, 'stepId'), payloadString(event, 'inputDigest'),
    payloadFlag(event, 'reversible'), payloadFlag(event, 'idempotent'),
    payloadString(event, 'summary'), event.ts,
  );
}

function applyCommitted(event: StoredEvent, storage: Storage): void {
  storage.prepare(`
    UPDATE outbox SET status = 'committed', remote_ref = ?, settled_at = ?,
      detail = CASE WHEN ? = 1 THEN 'discovered by reconciliation' ELSE detail END
     WHERE key = ?
  `).run(
    event.payload['remoteRef'] === null ? null : payloadString(event, 'remoteRef'),
    event.ts, payloadFlag(event, 'reconciled'), payloadString(event, 'key'),
  );
}

function applyReconciled(event: StoredEvent, storage: Storage): void {
  // A reconciliation that found the effect committed is recorded by a
  // separate `effect.committed`; this row only moves for the other two.
  const outcome = payloadString(event, 'outcome');
  if (outcome === 'committed') return;
  storage.prepare('UPDATE outbox SET status = ?, settled_at = ?, detail = ? WHERE key = ?')
    .run(outcome, event.ts, payloadString(event, 'detail'), payloadString(event, 'key'));
}

export function outboxProjector(): Projector {
  const tables = ['outbox'];
  return {
    name: 'outbox',
    tables,
    reset: (storage: Storage) => {
      for (const table of tables) storage.prepare(`DELETE FROM ${table}`).run();
    },
    apply(event, storage) {
      if (event.type === 'effect.intended') return applyIntended(event, storage);
      if (event.type === 'effect.committed') return applyCommitted(event, storage);
      if (event.type === 'effect.compensated') {
        storage.prepare("UPDATE outbox SET status = 'compensated', settled_at = ?, detail = ? WHERE key = ?")
          .run(event.ts, payloadString(event, 'detail'), payloadString(event, 'key'));
        return;
      }
      if (event.type === 'effect.reconciled') applyReconciled(event, storage);
    },
  };
}
