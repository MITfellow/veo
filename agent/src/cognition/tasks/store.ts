/**
 * The task list (S2).
 *
 * Same construction as the calendar: every write is an append to the
 * event log and every read is a query against a projection, so a
 * rebuild reproduces the list rather than emptying it, and an export
 * contains it.
 *
 * Scoped by principal on every single read and write — including the
 * internal `get` that `complete` and `drop` are built on. The calendar
 * shipped with an unscoped `get` and the S1 tests caught it; this one
 * starts out right.
 */
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { TrustLevel } from '../../substrate/events/types.js';

export interface Task {
  id: string;
  title: string;
  note: string | null;
  dueAt: number | null;
  createdAt: number;
  completedAt: number | null;
  droppedAt: number | null;
}

export interface AddTaskInput {
  title: string;
  note?: string | null;
  dueAt?: number | null;
}

export interface ListOptions {
  /** Finished and abandoned ones too. Off by default: a list is the open items. */
  includeClosed?: boolean;
  limit?: number;
}

interface Row {
  id: string;
  title: string;
  note: string | null;
  due_at: number | null;
  created_at: number;
  completed_at: number | null;
  dropped_at: number | null;
}

const toTask = (row: Row): Task => ({
  id: row.id,
  title: row.title,
  note: row.note,
  dueAt: row.due_at,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  droppedAt: row.dropped_at,
});

const MAX_LIMIT = 200;

export class TaskStore {
  constructor(
    private readonly deps: { storage: Storage; events: EventLog; clock: Clock; ids: Ids },
  ) {}

  add(principal: string, input: AddTaskInput, trust: TrustLevel = 'USER'): Task {
    const title = input.title.trim();
    if (title === '') throw new Error('a task needs a title');
    if (title.length > 200) throw new Error('a task title that long is a note, not a task');

    const taskId = `T-${this.deps.ids.ulid()}`;
    this.deps.events.append({
      type: 'task.added',
      principal,
      trust,
      payload: {
        taskId,
        title,
        note: input.note ?? null,
        dueAt: input.dueAt ?? null,
      },
    });

    const stored = this.get(principal, taskId);
    if (stored === undefined) throw new Error('the task did not project');
    return stored;
  }

  /** Mark it done. Returns false if there is no such open task. */
  complete(principal: string, taskId: string, trust: TrustLevel = 'USER'): boolean {
    const existing = this.get(principal, taskId);
    if (existing === undefined) return false;
    // Already closed: the caller got the outcome they wanted, so this
    // is a success — but it must not append a second event.
    if (existing.completedAt !== null || existing.droppedAt !== null) return true;

    this.deps.events.append({
      type: 'task.completed',
      principal,
      trust,
      payload: { taskId },
    });
    return true;
  }

  /**
   * Put a finished task back on the list.
   *
   * Returns false when there is no such task, and — unlike `complete`
   * — also when the task is open already or was dropped. Those are not
   * the caller getting what they wanted by another route: reopening an
   * open task is a no-op the caller should know about, and a dropped
   * task is not reopenable at all (adding it again is the honest
   * operation, with today's date on it).
   */
  reopen(principal: string, taskId: string, trust: TrustLevel = 'USER'): boolean {
    const existing = this.get(principal, taskId);
    if (existing === undefined) return false;
    if (existing.droppedAt !== null) return false;
    if (existing.completedAt === null) return false;

    this.deps.events.append({
      type: 'task.reopened',
      principal,
      trust,
      payload: { taskId },
    });
    return true;
  }

  /**
   * Take it off the list without claiming it was done.
   *
   * A separate event from `complete`, not a flag on it: see the schema
   * comment. This is the one a model may not call on its own.
   */
  drop(principal: string, taskId: string, trust: TrustLevel = 'USER'): boolean {
    const existing = this.get(principal, taskId);
    if (existing === undefined) return false;
    if (existing.droppedAt !== null) return true;

    this.deps.events.append({
      type: 'task.dropped',
      principal,
      trust,
      payload: { taskId },
    });
    return true;
  }

  get(principal: string, taskId: string): Task | undefined {
    const row = this.deps.storage.get<Row>('SELECT * FROM tasks WHERE id = ? AND principal = ?', [
      taskId,
      principal,
    ]);
    return row === undefined ? undefined : toTask(row);
  }

  /**
   * Open tasks, soonest due first, undated last.
   *
   * The ordering is the whole value of the list. `due_at IS NULL` sorts
   * *after* every date rather than before it, which is what SQLite does
   * not do by default — a NULL sorts first, so without the explicit key
   * every undated task would sit above today's deadline.
   */
  list(principal: string, options: ListOptions = {}): Task[] {
    const where = ['principal = ?'];
    if (options.includeClosed !== true) {
      where.push('completed_at IS NULL AND dropped_at IS NULL');
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_LIMIT);
    return this.deps.storage
      .all<Row>(
        `SELECT * FROM tasks
          WHERE ${where.join(' AND ')}
          ORDER BY (due_at IS NULL) ASC, due_at ASC, created_at ASC
          LIMIT ${limit}`,
        [principal],
      )
      .map(toTask);
  }

  /** Open tasks whose due date has passed. */
  overdue(principal: string, asOf: number): Task[] {
    return this.list(principal).filter((task) => task.dueAt !== null && task.dueAt < asOf);
  }
}
