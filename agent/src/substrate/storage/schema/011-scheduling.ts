/**
 * §28: the queue, the dead-letter table and the scheduler.
 *
 * Two columns in `jobs` are **not** projections of the log and are reset on
 * rebuild: `lease_until` and `lease_token` (decision 033). Everything else
 * here is derived from `job.*` and `schedule.*` events.
 *
 * `idempotency_key` has a partial unique index rather than a plain one: the
 * same key may be enqueued again *after* the first job is done, which is
 * what makes "one briefing per morning" expressible, but never while one is
 * still outstanding.
 */
export const SCHEMA_011 = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  principal       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','leased','done','failed','dead')),
  priority        INTEGER NOT NULL DEFAULT 0,
  run_after       INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  last_error      TEXT,
  schedule_id     TEXT,
  idempotency_key TEXT,
  enqueued_at     INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  seq             INTEGER NOT NULL,
  lease_until     INTEGER,
  lease_token     TEXT
);

CREATE INDEX IF NOT EXISTS jobs_claimable
  ON jobs (status, priority DESC, run_after ASC, seq ASC);
CREATE INDEX IF NOT EXISTS jobs_by_schedule ON jobs (schedule_id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency
  ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('pending','leased');

CREATE TABLE IF NOT EXISTS job_dead_letters (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  principal   TEXT NOT NULL,
  attempts    INTEGER NOT NULL,
  error       TEXT NOT NULL,
  schedule_id TEXT,
  died_at     INTEGER NOT NULL,
  replayed_at INTEGER
);

CREATE TABLE IF NOT EXISTS schedules (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('cron','once')),
  spec           TEXT NOT NULL,
  timezone       TEXT NOT NULL,
  payload        TEXT NOT NULL,
  principal      TEXT NOT NULL,
  catch_up       TEXT NOT NULL CHECK (catch_up IN ('fire-all','fire-once','skip')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  last_fired_at  INTEGER,
  next_fire_at   INTEGER,
  fire_count     INTEGER NOT NULL DEFAULT 0,
  missed_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS schedules_due ON schedules (enabled, next_fire_at);
`;
