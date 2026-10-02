/**
 * Migration v6 — approvals and suspended runs (§19, M4).
 *
 * Two tables, because they answer two different questions and have different
 * lifetimes.
 *
 * `approvals` is the question put to the human: what is being asked, what
 * would it do, who asked, and what did they say. One row per request. It is
 * append-mostly — a row is answered once and never re-opened, because an
 * approval that can be edited after the fact is not an audit record.
 *
 * `suspensions` is the run's parking space. §19 requires that a suspended run
 * "release all resources" and resume "at that step" across a full process
 * restart. That is only true if the entire resumable state is here, in rows,
 * rather than in a closure some process is holding. A killed process must
 * lose *nothing*, which means it must be holding nothing.
 *
 * Deliberately NOT stored: a serialized continuation. That would be a second
 * source of truth about where the run was (invariant 1), and it would rot the
 * first time the code around it changed. The resume path replays from the
 * event log, which M2's run-reconstruction tests already prove sufficient.
 */
export const SCHEMA_006 = `
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,         -- ULID
  run_id        TEXT NOT NULL,
  step_id       TEXT NOT NULL,
  session_id    TEXT,
  principal     TEXT NOT NULL,
  tool          TEXT NOT NULL,
  tool_version  TEXT NOT NULL,
  -- The exact call being approved. Canonical JSON so the shape matcher and
  -- the resumed invocation agree on what "the same call" means.
  input_json    TEXT NOT NULL,
  -- What the user is shown. From the tool's dryRun(): approving something
  -- you cannot see is not consent.
  preview       TEXT NOT NULL,
  risk          TEXT NOT NULL CHECK (risk IN ('safe','caution','dangerous')),
  requested_trust TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending','granted','denied','expired')),
  scope         TEXT CHECK (scope IN ('once','session','shape','always')),
  -- For scope='shape': the canonical pattern a future call must match.
  shape_json    TEXT,
  decided_by    TEXT,
  decided_at    INTEGER,
  reason        TEXT,
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX approvals_pending ON approvals (state, expires_at) WHERE state = 'pending';
CREATE INDEX approvals_run     ON approvals (run_id);
CREATE INDEX approvals_standing ON approvals (tool, state) WHERE scope IN ('session','shape','always');

CREATE TABLE suspensions (
  run_id        TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  principal     TEXT NOT NULL,
  step_id       TEXT NOT NULL,            -- resume HERE, not at the beginning
  step_index    INTEGER NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('approval','ask_user','schedule')),
  resume_on     TEXT NOT NULL,            -- approval id, or a schedule key
  -- Spend so far, so the resumed run continues under the same budget rather
  -- than getting a fresh one. A run that suspends is not a run that reset.
  spend_json    TEXT NOT NULL,
  suspended_at  INTEGER NOT NULL,
  resumed_at    INTEGER
);
CREATE INDEX suspensions_waiting ON suspensions (resume_on) WHERE resumed_at IS NULL;

-- An answered approval is a record of what a person decided. Re-deciding it
-- would rewrite history; a changed mind is a NEW request.
CREATE TRIGGER approvals_decide_once BEFORE UPDATE ON approvals
WHEN OLD.state <> 'pending' AND NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'this approval has already been answered; a change of mind is a new request');
END;

CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are an audit record and cannot be deleted');
END;
`;
