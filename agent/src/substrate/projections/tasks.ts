/**
 * The task projection (S2).
 *
 * Three events, one table, and the same discipline as the calendar:
 * closing a task stamps a column rather than deleting the row, because
 * "what did I write down last month and what came of it" is a question
 * about the past and a `DELETE` is the one operation that cannot answer
 * it.
 *
 * Reopening clears `completed_at` again (S3). The column is the
 * current state; the log keeps the history of how it got there, which
 * is why the projection can afford to forget.
 *
 * `completed_at` and `dropped_at` are stamped separately. A task that
 * was abandoned and a task that was finished both leave the list, and
 * the log is where that difference has to survive.
 *
 * Nothing here generates an id or reads a clock.
 */
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';

export const tasksProjector: Projector = {
  name: 'tasks',
  // Version 2: `task.reopened` (S3). Bumping it re-projects existing
  // databases, which is what makes an old log replay into the new
  // shape rather than silently keeping the old one.
  version: 2,
  handles: ['task.added', 'task.completed', 'task.dropped', 'task.reopened'],

  reset(storage) {
    storage.exec('DELETE FROM tasks');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'task.added': {
        const p = e.payload as PayloadOf<'task.added'>;
        storage.run(
          `INSERT INTO tasks (
             id, principal, title, note, due_at, created_at, completed_at, dropped_at, seq
           ) VALUES (?,?,?,?,?,?,NULL,NULL,?)
           ON CONFLICT(id) DO NOTHING`,
          [p.taskId, e.principal, p.title, p.note, p.dueAt, e.ts, e.seq],
        );
        return;
      }
      case 'task.completed': {
        const p = e.payload as PayloadOf<'task.completed'>;
        // Only if still open: replaying a completion over an already
        // dropped task must not resurrect it into a different state.
        storage.run(
          'UPDATE tasks SET completed_at = ? WHERE id = ? AND completed_at IS NULL AND dropped_at IS NULL',
          [e.ts, p.taskId],
        );
        return;
      }
      case 'task.reopened': {
        const p = e.payload as PayloadOf<'task.reopened'>;
        // Only a *completed* task reopens. A dropped one stays dropped:
        // dropping says "this stopped being worth doing", and undoing
        // that is adding it again, which is a different event with a
        // different date on it.
        storage.run(
          'UPDATE tasks SET completed_at = NULL WHERE id = ? AND completed_at IS NOT NULL AND dropped_at IS NULL',
          [p.taskId],
        );
        return;
      }
      case 'task.dropped': {
        const p = e.payload as PayloadOf<'task.dropped'>;
        storage.run(
          'UPDATE tasks SET dropped_at = ? WHERE id = ? AND dropped_at IS NULL',
          [e.ts, p.taskId],
        );
        return;
      }
      default:
        return;
    }
  },
};
