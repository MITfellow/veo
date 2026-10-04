/**
 * Schema migrations.
 *
 * Migrations are **frozen once shipped**. A mistake in a released migration is
 * corrected by a new migration, never by editing an old one, because an
 * existing database has already run the old one and will never run it again.
 *
 * The split between "log" and "projection" tables is the central fact of this
 * file and is marked on every table:
 *
 *   * `events` is the log. It is append-only and is never rebuilt.
 *   * Everything else is a projection. `rebuild()` drops the contents of all
 *     of them and replays the log, and §16 requires the result to be
 *     byte-identical.
 *
 * `facts` carries both timelines from the first migration (§17). Nothing
 * writes a fact until M5, but adding a second timeline to a populated table
 * is a rewrite, so the shape ships now.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'event-log',
    sql: `
      -- THE LOG. Append-only, never rebuilt, the source of all other tables.
      CREATE TABLE events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT    NOT NULL UNIQUE,
        type          TEXT    NOT NULL,
        ts            INTEGER NOT NULL,
        actor         TEXT    NOT NULL,
        trust         TEXT    NOT NULL,
        session_id    TEXT,
        run_id        TEXT,
        correlation_id TEXT,
        causation_id  TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        payload       TEXT    NOT NULL,
        prev_hash     TEXT    NOT NULL,
        hash          TEXT    NOT NULL
      );
      CREATE INDEX events_type_seq    ON events(type, seq);
      CREATE INDEX events_session_seq ON events(session_id, seq);
      CREATE INDEX events_run_seq     ON events(run_id, seq);
      CREATE INDEX events_corr_seq    ON events(correlation_id, seq);
      CREATE INDEX events_ts          ON events(ts);
    `,
  },
  {
    version: 2,
    name: 'core-projections',
    sql: `
      -- PROJECTION. Conversation threads.
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        channel     TEXT    NOT NULL,
        title       TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_last_activity ON sessions(last_activity_at DESC, id);

      -- PROJECTION. One row per utterance, in either direction.
      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        trust      TEXT NOT NULL,
        ts         INTEGER NOT NULL
      );
      CREATE INDEX messages_session_seq ON messages(session_id, seq);

      -- PROJECTION. One row per agent run (§22 plan-then-execute).
      CREATE TABLE runs (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        status     TEXT NOT NULL,
        goal       TEXT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        step_count INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT
      );
      CREATE INDEX runs_session_started ON runs(session_id, started_at DESC, id);
      CREATE INDEX runs_status ON runs(status, id);
    `,
  },
  {
    version: 3,
    name: 'bitemporal-facts',
    sql: `
      -- PROJECTION. §17: two independent timelines, present from day one.
      --
      --   valid_from / valid_to       when the statement was true of the world
      --   recorded_at / retracted_at  when the system believed it
      --
      -- A correction closes transaction time and leaves valid time alone; a
      -- change in the world closes valid time and opens a new row. Neither
      -- ever deletes, which is what makes "what did you believe in March"
      -- answerable.
      CREATE TABLE facts (
        id            TEXT PRIMARY KEY,
        subject       TEXT NOT NULL,
        predicate     TEXT NOT NULL,
        object        TEXT NOT NULL,
        valid_from    INTEGER NOT NULL,
        valid_to      INTEGER,
        recorded_at   INTEGER NOT NULL,
        retracted_at  INTEGER,
        superseded_by TEXT,
        basis         TEXT NOT NULL,
        confidence    REAL NOT NULL,
        stability     TEXT NOT NULL,
        sensitivity   TEXT NOT NULL,
        status        TEXT NOT NULL,
        pinned        INTEGER NOT NULL DEFAULT 0,
        trust         TEXT NOT NULL,
        source_event  TEXT NOT NULL
      );
      CREATE INDEX facts_subject_pred ON facts(subject, predicate, valid_from DESC, id);
      CREATE INDEX facts_valid        ON facts(valid_to, id);
      CREATE INDEX facts_recorded     ON facts(recorded_at, id);
      CREATE INDEX facts_live         ON facts(status, retracted_at, id);

      -- PROJECTION. Things facts are about. Resolution arrives in M5.
      CREATE TABLE entities (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        canonical_id TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX entities_kind_name ON entities(kind, name, id);
    `,
  },
  {
    version: 4,
    name: 'captures',
    sql: `
      -- PROJECTION. §21: untrusted content lands here first and is never
      -- read as instruction. The quarantine path proper arrives with M4;
      -- the landing table is M0 because the capture event is M0.
      CREATE TABLE captures (
        id         TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        trust      TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        session_id TEXT
      );
      CREATE INDEX captures_captured_at ON captures(captured_at DESC, id);
    `,
  },
  {
    version: 5,
    name: 'vault',
    sql: `
      -- NOT A PROJECTION. Decision 006: wrapped keys and secret ciphertext
      -- are high-entropy bytes from a CSPRNG. No replay reconstructs them,
      -- they must never enter the log, and \`rebuild\` must not drop them.
      -- They are excluded from PROJECTION_TABLES for exactly that reason.
      CREATE TABLE keyring (
        id                 TEXT PRIMARY KEY,
        salt_passphrase    BLOB NOT NULL,
        salt_recovery      BLOB NOT NULL,
        wrapped_passphrase BLOB,          -- NULL after panic
        wrapped_recovery   BLOB,          -- NULL after panic
        argon_mem_mib      INTEGER NOT NULL,
        argon_iterations   INTEGER NOT NULL,
        argon_parallelism  INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        destroyed_at       INTEGER         -- the tombstone outlives the keys
      );

      -- NOT A PROJECTION. Values are sealed under the MDK, bound by AAD to
      -- their own name and version so a swapped row will not open.
      CREATE TABLE secrets (
        name       TEXT    NOT NULL,
        version    INTEGER NOT NULL,
        sealed     BLOB    NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (name, version)
      );

      -- NOT A PROJECTION. One random key per shreddable item, wrapped under
      -- the MDK. Deleting a row is the shred (invariant 10).
      CREATE TABLE item_keys (
        key_id     TEXT PRIMARY KEY,
        wrapped    BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- NOT A PROJECTION. The quarantine's side table (§21). The privileged
      -- path has no handle to it; only the quarantine reads it, and only
      -- when presented with a FOREIGN-trust context.
      CREATE TABLE quarantined_content (
        ref_id     TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

/** The schema version a fresh database lands on. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;
