/**
 * S3's reminders — the link between "a thing I wrote down" and "tell me
 * about it at a particular moment".
 *
 * This table holds no timer. The firing is a one-shot schedule in
 * §28's scheduler, and `schedule_id` points at it. That is the whole
 * design decision: a second timing mechanism would mean two things to
 * keep running, two catch-up policies after a restart, and two places
 * to look when a reminder does not arrive. §28 already solved all of
 * that, including the hard part — what to do about the ones that were
 * due while the process was down.
 *
 * So a reminder is a *link*: owner (a task or a calendar event) on one
 * side, schedule on the other, plus the text to say. Which means the
 * rules fall out for free — a task that is completed or dropped takes
 * its reminders with it, because the owner is a column rather than a
 * convention.
 *
 * `cancelled_at` and `fired_at` are stamped, never deleted, like
 * everywhere else here: "I was reminded and ignored it" is a fact
 * about the past, and it is the one you want when you ask why
 * something slipped.
 */
export const SCHEMA_017 = `
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  -- 'task' or 'event'. Checked here rather than only in zod: the
  -- projection is rebuilt from the log by code that does not run the
  -- boundary schemas.
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('task', 'event')),
  owner_id      TEXT NOT NULL,
  schedule_id   TEXT NOT NULL,
  remind_at     INTEGER NOT NULL,
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  cancelled_at  INTEGER,
  fired_at      INTEGER,
  seq           INTEGER NOT NULL
);

-- "What is still coming", the only read the panel makes.
CREATE INDEX IF NOT EXISTS idx_reminders_pending
  ON reminders (principal, remind_at)
  WHERE cancelled_at IS NULL AND fired_at IS NULL;

-- "Does this task have a reminder on it", and the cascade when it
-- closes. Both go through the owner.
CREATE INDEX IF NOT EXISTS idx_reminders_owner
  ON reminders (owner_kind, owner_id);
`;
