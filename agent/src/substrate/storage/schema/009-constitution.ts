/**
 * Migration v9 — the constitution (§25, M7).
 *
 * Four tables, and none of them is the source of truth: every row here is a
 * projection of `constitution.*` events, because §25's whole demand is that
 * "the agent started talking differently on this date, because of this" is
 * answerable. An UPDATEd row cannot answer it; a replayable log can.
 *
 * `constitution_articles` — one row per article, *not* one row per version of
 * an article. Versioning lives in the event log and in
 * `constitution_versions`; this table is the current document, rebuilt from
 * scratch whenever the projection is dropped. `repealed_at` is kept rather
 * than deleting the row so the rendered document can say "this default was
 * overridden on purpose" and so history queries do not have to replay.
 *
 * `constitution_versions` — the amendment log in queryable form: one row per
 * document version with the hash and the change that produced it. `at(ts)`
 * reads this to find which version was in force at a moment, then replays.
 *
 * `constitution_proposals` — articles the *agent* has suggested. They are
 * inert: a proposal has no effect on the rendered document until a principal
 * ratifies it. `body_hash` is what makes a dismissal stick; a system that
 * can re-ask a dismissed question every night does not take no for an
 * answer (the same rule §24.2 applies to probes).
 *
 * `constitution_enforcements` — one row per checked article per model
 * response, including the `unverifiable` ones. Storing the unverifiable
 * verdicts is the difference between a compliance number that means
 * something and one that silently counts "could not tell" as "fine".
 */
export const SCHEMA_009 = `
CREATE TABLE constitution_articles (
  id            TEXT PRIMARY KEY,
  ordinal       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  origin        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  enforcement   TEXT NOT NULL,
  check_id      TEXT,
  remedy        TEXT NOT NULL DEFAULT 'none',
  enforced_by   TEXT NOT NULL DEFAULT '',
  entrenched    INTEGER NOT NULL DEFAULT 0,
  subject       TEXT NOT NULL DEFAULT 'general',
  stance        TEXT NOT NULL DEFAULT 'require',
  cites         TEXT NOT NULL DEFAULT '',
  added_version INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  repealed_at   INTEGER,

  CHECK (origin IN ('founding','user','proposed')),
  CHECK (kind IN ('directive','prohibition','disclosure','style')),
  CHECK (enforcement IN ('advisory','checked','structural')),
  CHECK (remedy IN ('annotate','revise','block','none')),
  CHECK (stance IN ('require','forbid','prefer'))
);

CREATE INDEX idx_articles_live ON constitution_articles(repealed_at, ordinal);

CREATE TABLE constitution_versions (
  version    INTEGER PRIMARY KEY,
  hash       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  change     TEXT NOT NULL,
  article_id TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL,
  event_id   TEXT NOT NULL
);

CREATE INDEX idx_constitution_versions_at ON constitution_versions(at);

CREATE TABLE constitution_proposals (
  id           TEXT PRIMARY KEY,
  body_hash    TEXT NOT NULL,
  article      TEXT NOT NULL,          -- JSON, the proposed article
  rationale    TEXT NOT NULL DEFAULT '',
  derived_from TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  decided_at   INTEGER,

  CHECK (status IN ('pending','ratified','dismissed'))
);

CREATE INDEX idx_proposals_hash ON constitution_proposals(body_hash);

CREATE TABLE constitution_enforcements (
  id         TEXT NOT NULL,            -- the event id
  run_id     TEXT NOT NULL,
  step_id    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  article_id TEXT NOT NULL,
  check_id   TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  remedy     TEXT NOT NULL DEFAULT 'none',
  at         INTEGER NOT NULL,

  PRIMARY KEY (id, article_id),
  CHECK (verdict IN ('upheld','violated','unverifiable'))
);

CREATE INDEX idx_enforcements_article ON constitution_enforcements(article_id, at);
CREATE INDEX idx_enforcements_run ON constitution_enforcements(run_id);
`;
