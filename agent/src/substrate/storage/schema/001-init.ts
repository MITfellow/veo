/**
 * Schema 001 — the event log, the bitemporal fact store, and the projections.
 *
 * Notes that matter more than the DDL:
 *
 *  - `events` is append-only and *enforced* to be, by triggers. A comment
 *    saying "don't update this" is not a guarantee; a trigger is (invariant 2).
 *  - Projections live in their own tables and carry no data that is not
 *    derivable from the log. `rebuild-identity` is only meaningful if dropping
 *    them loses nothing.
 *  - `facts` is bitemporal from day one: valid time (when it was true in the
 *    world) and transaction time (when we believed it). Retrofitting that is a
 *    rewrite, so it goes in before there is any data to migrate (§11).
 */
export const SCHEMA_001 = `
-- ─────────────────────────────── event log ─────────────────────────────────

CREATE TABLE events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT    NOT NULL UNIQUE,
  ts              INTEGER NOT NULL,
  principal       TEXT    NOT NULL,
  session_id      TEXT,
  run_id          TEXT,
  step_id         TEXT,
  type            TEXT    NOT NULL,
  payload         TEXT    NOT NULL,          -- canonical JSON, post-redaction
  trust           TEXT    NOT NULL,
  causation_id    TEXT,
  correlation_id  TEXT    NOT NULL,
  schema_version  INTEGER NOT NULL,
  prev_hash       TEXT    NOT NULL,
  hash            TEXT    NOT NULL,
  CHECK (trust IN ('SYSTEM','USER','DERIVED','TOOL','FOREIGN')),
  CHECK (length(hash) = 64 AND length(prev_hash) = 64)
);

CREATE INDEX events_session_seq ON events(session_id, seq);
CREATE INDEX events_run_seq     ON events(run_id, seq);
CREATE INDEX events_type_seq    ON events(type, seq);
CREATE INDEX events_corr_seq    ON events(correlation_id, seq);
CREATE INDEX events_ts          ON events(ts);
CREATE INDEX events_causation   ON events(causation_id);

-- History is not editable. Not by a bug, not by a future maintainer in a hurry.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only: UPDATE is forbidden');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only: DELETE is forbidden');
END;

-- ──────────────────────── projection bookkeeping ───────────────────────────

CREATE TABLE projection_state (
  name        TEXT PRIMARY KEY,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────── projections (derived) ─────────────────────────

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  locked       INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_updated ON sessions(updated_at DESC);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,          -- the event id
  seq         INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  run_id      TEXT,
  role        TEXT NOT NULL,             -- user | agent | system
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  trust       TEXT NOT NULL
);
CREATE INDEX messages_session_seq ON messages(session_id, seq);
CREATE INDEX messages_ts ON messages(ts);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  state         TEXT NOT NULL,           -- running|finished|failed|cancelled|suspended
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  steps         INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  cost_cents    REAL NOT NULL DEFAULT 0,
  error_kind    TEXT,
  error_message TEXT
);
CREATE INDEX runs_session ON runs(session_id, started_at DESC);
CREATE INDEX runs_state ON runs(state);

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  merged_into TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX entities_kind_name ON entities(kind, name);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  run_id     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX artifacts_run ON artifacts(run_id);

-- ───────────────────────── bitemporal fact store ───────────────────────────
--
-- Two independent timelines:
--   valid_from / valid_to       when the statement was true of the world
--   recorded_at / superseded_at when this system believed it
--
-- Superseding writes 'superseded_at' on the old row and inserts a new one. The
-- old row is never deleted — "what did you believe in March, and were you
-- wrong?" has to stay answerable.

CREATE TABLE facts (
  id              TEXT PRIMARY KEY,       -- row identity (one belief-version)
  fact_id         TEXT NOT NULL,          -- logical identity across versions
  subject         TEXT NOT NULL,
  predicate       TEXT NOT NULL,
  object          TEXT NOT NULL,          -- canonical JSON

  valid_from      INTEGER NOT NULL,
  valid_to        INTEGER,                -- NULL = still true
  recorded_at     INTEGER NOT NULL,
  superseded_at   INTEGER,                -- NULL = still believed
  superseded_by   TEXT,

  basis           TEXT NOT NULL,          -- observed|inferred|asserted_by_user|imported
  confidence      REAL NOT NULL,
  sources         TEXT NOT NULL,          -- JSON array, MUST be non-empty
  derivation      TEXT,

  observation_count INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at INTEGER,
  last_used_at      INTEGER,
  use_count         INTEGER NOT NULL DEFAULT 0,

  stability       TEXT NOT NULL DEFAULT 'slow',
  sensitivity     TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'active',
  pinned          INTEGER NOT NULL DEFAULT 0,

  trust           TEXT NOT NULL,
  key_id          TEXT,                   -- per-item key, for crypto-shredding
  event_seq       INTEGER NOT NULL,       -- the event that produced this row

  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (json_array_length(sources) >= 1),   -- invariant 5, enforced in the DB
  CHECK (basis IN ('observed','inferred','asserted_by_user','imported')),
  CHECK (status IN ('active','disputed','quarantined','retired')),
  CHECK (stability IN ('volatile','slow','stable')),
  CHECK (sensitivity IN ('normal','private','secret')),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX facts_logical    ON facts(fact_id, recorded_at);
CREATE INDEX facts_sp         ON facts(subject, predicate);
CREATE INDEX facts_current    ON facts(subject, predicate, superseded_at, valid_to);
CREATE INDEX facts_valid      ON facts(valid_from, valid_to);
CREATE INDEX facts_recorded   ON facts(recorded_at, superseded_at);
CREATE INDEX facts_status     ON facts(status);

-- Full-text over the human-readable projection of a fact. Lexical recall is
-- half of hybrid search (§22.4); the vector half arrives at M6.
CREATE VIRTUAL TABLE facts_fts USING fts5(
  fact_id UNINDEXED,
  row_id  UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`;
