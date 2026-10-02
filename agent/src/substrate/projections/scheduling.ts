/**
 * The jobs and schedules projections (§28, M8).
 *
 * Everything in `jobs`, `job_dead_letters` and `schedules` is derived from
 * `job.*` and `schedule.*` events — with two documented exceptions, both in
 * `jobs`:
 *
 *   `lease_until`, `lease_token`
 *
 * They are operational, not historical (decision 033). `reset` clears them
 * along with everything else, and a replay produces every row with a null
 * lease, which is the truth: after a restart nobody holds a claim.
 *
 * `principal` and `max_attempts` are written by `JobQueue` immediately
 * after the enqueue event, so the projector seeds them with safe defaults
 * rather than leaving the columns null.
 */
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';
import type { Storage } from '../ports.js';

export const schedulingProjector: Projector = {
  name: 'scheduling',
  version: 1,
  handles: [
    'job.enqueued',
    'job.started',
    'job.succeeded',
    'job.failed',
    'job.deadlettered',
    'schedule.created',
    'schedule.updated',
    'schedule.deleted',
    'schedule.fired',
    'schedule.missed',
  ],

  reset(storage: Storage) {
    storage.exec('DELETE FROM jobs');
    storage.exec('DELETE FROM job_dead_letters');
    storage.exec('DELETE FROM schedules');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'job.enqueued': {
        const p = e.payload as PayloadOf<'job.enqueued'>;
        storage.run(
          `INSERT INTO jobs (
             id, kind, payload, principal, status, priority, run_after, attempts,
             max_attempts, last_error, schedule_id, idempotency_key, enqueued_at,
             started_at, finished_at, seq, lease_until, lease_token
           ) VALUES (?,?,?,?,'pending',?,?,0,?,NULL,?,?,?,NULL,NULL,?,NULL,NULL)
           ON CONFLICT(id) DO NOTHING`,
          [
            p.jobId,
            p.kind,
            JSON.stringify(p.payload),
            e.principal,
            p.priority,
            p.runAfter,
            5,
            p.scheduleId,
            p.idempotencyKey,
            e.ts,
            e.seq,
          ],
        );
        return;
      }

      case 'job.started': {
        const p = e.payload as PayloadOf<'job.started'>;
        storage.run(
          `UPDATE jobs SET status = 'leased', attempts = ?, started_at = ? WHERE id = ?`,
          [p.attempt, e.ts, p.jobId],
        );
        return;
      }

      case 'job.succeeded': {
        const p = e.payload as PayloadOf<'job.succeeded'>;
        storage.run(
          `UPDATE jobs SET status = 'done', finished_at = ?, lease_until = NULL, lease_token = NULL
            WHERE id = ?`,
          [e.ts, p.jobId],
        );
        return;
      }

      case 'job.failed': {
        const p = e.payload as PayloadOf<'job.failed'>;
        // A retryable failure goes back to `pending` with a later
        // `run_after`; an exhausted one waits for `job.deadlettered`,
        // which arrives in the same breath.
        if (p.retryAt === null) {
          storage.run(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`, [
            p.error,
            p.jobId,
          ]);
        } else {
          storage.run(
            `UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?,
                             lease_until = NULL, lease_token = NULL
              WHERE id = ?`,
            [p.error, p.retryAt, p.jobId],
          );
        }
        return;
      }

      case 'job.deadlettered': {
        const p = e.payload as PayloadOf<'job.deadlettered'>;
        const row = storage.get<{
          kind: string;
          payload: string;
          principal: string;
          schedule_id: string | null;
        }>('SELECT kind, payload, principal, schedule_id FROM jobs WHERE id = ?', [p.jobId]);
        storage.run(`UPDATE jobs SET status = 'dead', finished_at = ? WHERE id = ?`, [e.ts, p.jobId]);
        if (row === undefined) return;
        storage.run(
          `INSERT INTO job_dead_letters (id, kind, payload, principal, attempts, error, schedule_id, died_at, replayed_at)
           VALUES (?,?,?,?,?,?,?,?,NULL)
           ON CONFLICT(id) DO NOTHING`,
          [p.jobId, row.kind, row.payload, row.principal, p.attempts, p.error, row.schedule_id, e.ts],
        );
        return;
      }

      case 'schedule.created': {
        const p = e.payload as PayloadOf<'schedule.created'>;
        storage.run(
          `INSERT INTO schedules (
             id, name, kind, spec, timezone, payload, principal, catch_up, enabled,
             created_at, last_fired_at, next_fire_at, fire_count, missed_count
           ) VALUES (?,?,?,?,?,?,?,?,1,?,NULL,?,0,0)
           ON CONFLICT(id) DO NOTHING`,
          [
            p.scheduleId,
            p.name,
            p.kind,
            p.spec,
            p.timezone,
            JSON.stringify(p.payload),
            e.principal,
            p.catchUp,
            e.ts,
            p.nextFireAt,
          ],
        );
        return;
      }

      case 'schedule.updated': {
        const p = e.payload as PayloadOf<'schedule.updated'>;
        storage.run(
          `UPDATE schedules SET spec = ?, timezone = ?, catch_up = ?, enabled = ?, next_fire_at = ?
            WHERE id = ?`,
          [p.spec, p.timezone, p.catchUp, p.enabled ? 1 : 0, p.nextFireAt, p.scheduleId],
        );
        return;
      }

      case 'schedule.deleted': {
        const p = e.payload as PayloadOf<'schedule.deleted'>;
        storage.run('DELETE FROM schedules WHERE id = ?', [p.scheduleId]);
        return;
      }

      case 'schedule.fired': {
        const p = e.payload as PayloadOf<'schedule.fired'>;
        storage.run(
          `UPDATE schedules SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`,
          [p.scheduledFor, p.scheduleId],
        );
        return;
      }

      case 'schedule.missed': {
        const p = e.payload as PayloadOf<'schedule.missed'>;
        storage.run(
          `UPDATE schedules SET missed_count = missed_count + 1,
                                last_fired_at = MAX(COALESCE(last_fired_at, 0), ?)
            WHERE id = ?`,
          [p.scheduledFor, p.scheduleId],
        );
        return;
      }

      default:
        return;
    }
  },
};
