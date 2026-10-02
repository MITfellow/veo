/**
 * S2's task list — the things with no time attached.
 *
 * Deliberately thin. There is no priority, no tags, no subtasks and no
 * project: those are the columns that turn a list into a system that
 * has to be maintained, and a list nobody maintains is a list nobody
 * trusts. Title, an optional due date, an optional note, done or not.
 *
 * `completed_at` and `dropped_at` are separate columns because they
 * mean different things. "I did it" and "this is no longer worth
 * doing" are both reasons a task leaves the list, and collapsing them
 * into one `closed_at` would destroy the only interesting question you
 * can ask of an old list — how much of what you wrote down actually got
 * done.
 *
 * Projected from `task.added` / `task.completed` / `task.dropped`, so
 * dropping this table and replaying the log gives the list back.
 */
export const SCHEMA_016 = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  title         TEXT NOT NULL,
  note          TEXT,
  due_at        INTEGER,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  dropped_at    INTEGER,
  seq           INTEGER NOT NULL
);

-- The query every read makes: one principal's open tasks.
CREATE INDEX IF NOT EXISTS idx_tasks_open
  ON tasks (principal, due_at)
  WHERE completed_at IS NULL AND dropped_at IS NULL;
`;
