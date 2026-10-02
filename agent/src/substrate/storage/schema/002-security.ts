/**
 * Schema 002 — the security core's tables.
 *
 * Note what is *not* here: no table stores a key. The Root Key lives only in
 * memory, the MDK exists on disk solely as two wrapped blobs, and per-item
 * keys are derived on demand (D-011). A grep for a key column should find
 * nothing, and the test `keyring > the Root Key is never persisted` asserts
 * exactly that over every table.
 */
export const SCHEMA_002 = `
CREATE TABLE keyring (
  id              TEXT PRIMARY KEY,
  passphrase_salt BLOB NOT NULL,
  passphrase_wrap BLOB,          -- NULL after panic: the MDK is gone forever
  recovery_salt   BLOB NOT NULL,
  recovery_wrap   BLOB,          -- NULL after panic
  created_at      INTEGER NOT NULL,
  rotated_at      INTEGER,
  panicked_at     INTEGER
);

CREATE TABLE secrets (
  name         TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  ciphertext   BLOB    NOT NULL,   -- zero-length once destroyed
  label        TEXT    NOT NULL,   -- what redaction placeholders are named
  created_at   INTEGER NOT NULL,
  destroyed_at INTEGER,
  last_read_at INTEGER,
  read_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, version)
);
CREATE INDEX secrets_name ON secrets(name);

-- Crypto-shred tombstones. Append-only like the log: a tombstone that could be
-- removed would make forgetting reversible, which is the opposite of the
-- guarantee in invariant 8.
CREATE TABLE shred_tombstones (
  item_id     TEXT PRIMARY KEY,
  shredded_at INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  event_id    TEXT NOT NULL
);

CREATE TRIGGER shred_tombstones_no_delete BEFORE DELETE ON shred_tombstones
BEGIN
  SELECT RAISE(ABORT, 'a shred tombstone cannot be removed: forgetting is permanent');
END;

CREATE TRIGGER shred_tombstones_no_update BEFORE UPDATE ON shred_tombstones
BEGIN
  SELECT RAISE(ABORT, 'a shred tombstone cannot be altered');
END;
`;
