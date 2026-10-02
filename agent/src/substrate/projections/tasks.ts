/**
 * The task projection (S2).
 *
 * Three events, one table, and the same discipline as the calendar:
 * closing a task stamps a column rather than deleting the row, because
 * "what did I write down last month and what came of it" is a question
 * about the past and a `DELETE` is the one operation that cannot answer
 * it.
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
  version: 1,
  handles: ['task.added', 'task.completed', 'task.dropped'],

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
