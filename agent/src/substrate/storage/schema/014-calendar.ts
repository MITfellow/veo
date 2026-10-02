/**
 * S1's calendar — the agent's own, not a mirror of someone else's.
 *
 * Projected from `calendar.added` and `calendar.cancelled`, so dropping
 * the table and replaying the log gives the same calendar back. That is
 * why `cancelled_at` is a column rather than a `DELETE`: the log keeps
 * every event that was ever added, and "what did my week look like
 * before I cancelled half of it" stays answerable.
 *
 * Times are epoch milliseconds, UTC, with the timezone the event was
 * created in kept alongside. An all-day event stores midnight in that
 * zone and sets `all_day`, because "the 3rd" is a different instant in
 * Lisbon and Auckland and only the flag records which one was meant.
 */
export const SCHEMA_014 = `
CREATE TABLE IF NOT EXISTS calendar_events (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  title         TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER NOT NULL,
  all_day       INTEGER NOT NULL CHECK (all_day IN (0,1)),
  timezone      TEXT NOT NULL,
  location      TEXT,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  cancelled_at  INTEGER,
  seq           INTEGER NOT NULL,
  CHECK (ends_at >= starts_at)
);

-- The query every read makes: a principal's live events in a window.
CREATE INDEX IF NOT EXISTS idx_calendar_window
  ON calendar_events (principal, starts_at)
  WHERE cancelled_at IS NULL;
`;
