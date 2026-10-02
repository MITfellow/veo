/**
 * Migration v7 — the rest of memory (§22, M6).
 *
 * M1 already shipped the hard part: the bitemporal `facts` table and its FTS5
 * index. This adds the three stores that sit around it and the two pieces of
 * machinery the write path needs.
 *
 * `episodes` — §22.1. One row per completed run: what was asked, what was
 * done, how it ended. Derived from the log and rebuildable from it, so it is
 * a projection and not a source of truth. It exists because consolidation
 * needs to read "the last forty things that happened" without replaying the
 * entire event stream, and because the outcome signal (satisfied / corrected
 * / abandoned) is the only honest feedback the agent ever gets.
 *
 * `rules` — §22.3, procedural memory. The `overridden` counter is the whole
 * point of the table. An agent that accumulates rules and never drops them
 * gets steadily more irritating; the counters are what make rules decay.
 *
 * `affect` — §22.4. One row per principal, six numbers. Small on purpose:
 * tone calibration earns its place by being derived from many episodes, and
 * a wide table invites deriving it from one. **Nothing in this table may be
 * inferred from demographics** (§22.4) — that is enforced by there being no
 * column that could hold one.
 *
 * `fact_embeddings` — the vector half of hybrid recall. Stored as a blob of
 * float32s next to the fact rather than in a vector database, because §22
 * opens by forbidding "a vector DB and hope", and because at personal scale
 * (tens of thousands of facts) a linear scan over packed floats is faster
 * than the network call you would make to avoid it.
 *
 * `memory_jobs` — the queue. §22.5 requires the write path to run *after* the
 * run completes and never on the user's critical path. A `setTimeout` would
 * lose the work on a crash, so the job is a durable row: enqueued inside the
 * same transaction that finishes the run, drained afterwards, and still there
 * on restart if the process dies in between.
 *
 * `identity_cards` — §22.7's ≤400-token summary of a person, recomputed by
 * consolidation. Cached rather than derived on read because it is read on
 * *every* turn and recomputed roughly daily.
 */
export const SCHEMA_007 = `
CREATE TABLE episodes (
  id             TEXT PRIMARY KEY,        -- ULID
  run_id         TEXT NOT NULL UNIQUE,
  session_id     TEXT,
  principal      TEXT NOT NULL,
  request        TEXT NOT NULL,           -- what the user asked, verbatim
  response       TEXT NOT NULL DEFAULT '',
  actions        TEXT NOT NULL DEFAULT '[]',  -- JSON: tool names, in order
  entities       TEXT NOT NULL DEFAULT '[]',  -- JSON: entity ids touched
  outcome        TEXT NOT NULL DEFAULT 'unknown',
  outcome_reason TEXT,
  trust          TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  consolidated_at INTEGER,                -- NULL until the sleep job has read it

  CHECK (outcome IN ('satisfied','corrected','abandoned','unknown'))
);
CREATE INDEX episodes_principal_time ON episodes(principal, ended_at DESC);
CREATE INDEX episodes_unconsolidated ON episodes(consolidated_at, ended_at);

CREATE TABLE rules (
  id              TEXT PRIMARY KEY,
  principal       TEXT NOT NULL,
  trigger_kind    TEXT NOT NULL,          -- 'always' | 'topic' | 'tool' | 'recipient'
  trigger_value   TEXT NOT NULL DEFAULT '',
  instruction     TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'global',
  source          TEXT NOT NULL,          -- JSON SourceRef[]
  basis           TEXT NOT NULL DEFAULT 'observed',
  confidence      REAL NOT NULL DEFAULT 0.5,
  applied         INTEGER NOT NULL DEFAULT 0,
  overridden      INTEGER NOT NULL DEFAULT 0,
  last_applied    INTEGER,
  last_overridden INTEGER,
  status          TEXT NOT NULL DEFAULT 'active',
  trust           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  CHECK (status IN ('active','probation','retired')),
  CHECK (scope IN ('global','context')),
  CHECK (trigger_kind IN ('always','topic','tool','recipient'))
);
CREATE INDEX rules_principal_status ON rules(principal, status);
CREATE UNIQUE INDEX rules_dedupe ON rules(principal, trigger_kind, trigger_value, instruction);

CREATE TABLE affect (
  principal        TEXT PRIMARY KEY,
  formality        REAL NOT NULL DEFAULT 0.5,
  humor            REAL NOT NULL DEFAULT 0.5,
  verbosity        REAL NOT NULL DEFAULT 0.5,
  directness       REAL NOT NULL DEFAULT 0.5,
  hedging          REAL NOT NULL DEFAULT 0.5,
  sensitive_topics TEXT NOT NULL DEFAULT '[]',
  episodes_seen    INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE fact_embeddings (
  fact_id    TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE memory_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,             -- 'observe' | 'consolidate'
  principal    TEXT NOT NULL,
  payload      TEXT NOT NULL,             -- JSON
  enqueued_at  INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,

  CHECK (kind IN ('observe','consolidate'))
);
CREATE INDEX memory_jobs_pending ON memory_jobs(finished_at, enqueued_at);

CREATE TABLE identity_cards (
  principal   TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  fact_count  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- What the agent learned recently, in words the user can read and correct
-- (§22.7). Kept as rows rather than regenerated prose so that "you learned
-- this on Tuesday and I told you it was wrong" stays true.
CREATE TABLE learning_digest (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  text       TEXT NOT NULL,
  fact_ids   TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER
);
CREATE INDEX learning_digest_principal ON learning_digest(principal, created_at DESC);
`;
