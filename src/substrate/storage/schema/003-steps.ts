/**
 * Migration v3 — the `steps` projection table (M2).
 *
 * A step is the unit of recovery (§26), so it needs to be queryable on its
 * own: "which step was this run on when the process died?" must be a cheap
 * index lookup, not a scan of the event log.
 *
 * `finished_at IS NULL` is therefore meaningful rather than merely absent: it
 * marks a step that started and never completed, which is exactly the state a
 * kill leaves behind. No separate status column could stay as honest, because
 * a status column has to be *written* by the thing that just died.
 */
export const SCHEMA_003 = `
CREATE TABLE steps (
  id            TEXT PRIMARY KEY,          -- the step id
  run_id        TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,                   -- NULL = interrupted, and that is the point
  outcome       TEXT,                      -- text | tools | finish | error
  duration_ms   INTEGER,
  trust         TEXT NOT NULL,
  model_tokens  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, idx)
);
CREATE INDEX steps_run      ON steps (run_id, idx);
CREATE INDEX steps_unfinished ON steps (run_id) WHERE finished_at IS NULL;
`;
