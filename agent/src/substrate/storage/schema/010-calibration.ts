/**
 * Migration v10 — calibration (§24, M7).
 *
 * `calibration_probes` — the ask budget's ledger. §24.2 is a list of
 * refusals ("never the same question twice", "a declined probe is recorded
 * and respected", "unanswered twice → drop it permanently"), and every one
 * of them needs state that outlives the session. `question_hash` is how
 * "the same question" is recognised across rewordings of the same fact, and
 * `attempts` is what makes "twice" countable.
 *
 * `calibration_resolutions` — the Brier ledger. One row per prediction that
 * actually got resolved: what the agent believed (`predicted`, 0..1) and
 * what turned out to be the case (`outcome`, 0 or 1). §24.1 asks for a
 * number that means something, and a number computed over *unresolved*
 * beliefs would be the opposite — so unresolved predictions are simply
 * absent here and counted separately at read time.
 *
 * `bias_audits` — one row per consolidation pass, so §24.3's metrics have a
 * rolling window to be rolling over. Cheap, append-only, and the reason the
 * compliance panel can say "agreement rate has climbed for three days"
 * rather than only "agreement rate is 0.71 right now".
 */
export const SCHEMA_010 = `
CREATE TABLE calibration_probes (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  fact_id       TEXT,
  question      TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  predicted     REAL NOT NULL DEFAULT 0.5,
  value         REAL NOT NULL DEFAULT 0,   -- information value x cost of being wrong
  session_id    TEXT,
  asked_at      INTEGER,
  answered_at   INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',

  CHECK (status IN ('pending','asked','confirmed','corrected','declined','unresolvable'))
);

CREATE INDEX idx_probes_principal ON calibration_probes(principal, status);
CREATE UNIQUE INDEX idx_probes_question ON calibration_probes(principal, question_hash);

CREATE TABLE calibration_resolutions (
  id          TEXT PRIMARY KEY,
  principal   TEXT NOT NULL,
  fact_id     TEXT,
  predicted   REAL NOT NULL,
  outcome     INTEGER NOT NULL,
  source      TEXT NOT NULL,              -- 'probe' | 'correction' | 'tool'
  resolved_at INTEGER NOT NULL,

  CHECK (outcome IN (0,1)),
  CHECK (predicted >= 0 AND predicted <= 1)
);

CREATE INDEX idx_resolutions_principal ON calibration_resolutions(principal, resolved_at);

CREATE TABLE bias_audits (
  id                 TEXT PRIMARY KEY,
  principal          TEXT NOT NULL,
  at                 INTEGER NOT NULL,
  agreement_rate     REAL NOT NULL,
  position_flip_rate REAL NOT NULL,
  source_diversity   REAL NOT NULL,
  staleness          REAL NOT NULL,
  protected_hits     TEXT NOT NULL DEFAULT '[]',
  regressions        TEXT NOT NULL DEFAULT '[]',
  turns              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_bias_audits_at ON bias_audits(principal, at);
`;
