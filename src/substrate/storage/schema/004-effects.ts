/**
 * Migration v4 — the outbox (§18, M3).
 *
 * This table exists so that the question "did this effect happen?" has an
 * answer that survives a power cut mid-sentence.
 *
 * `state` is deliberately *not* a free string:
 *   intended       — we committed the intent. The effect may or may not have run.
 *   committed      — it definitely ran, and `remote_ref` says what came back.
 *   compensated    — it ran and was deliberately undone.
 *   needs_attention— we cannot tell, and no machine may decide. A human must.
 *
 * The row is inserted in the SAME transaction as the step, which is the only
 * reason the `intended` state is trustworthy: if the intent is in the log,
 * the step that caused it is too, and vice versa.
 */
export const SCHEMA_004 = `
CREATE TABLE effects (
  idempotency_key TEXT PRIMARY KEY,     -- hash(tool, version, canonicalInput, stepId)
  tool            TEXT NOT NULL,
  tool_version    TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN
                    ('intended','committed','compensated','needs_attention')),
  summary         TEXT NOT NULL,
  input_json      TEXT NOT NULL,        -- canonical, so reconciliation can re-derive the key
  remote_ref      TEXT,
  intended_at     INTEGER NOT NULL,
  settled_at      INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  note            TEXT
);
CREATE INDEX effects_unsettled ON effects (run_id) WHERE state = 'intended';
CREATE INDEX effects_attention ON effects (state) WHERE state = 'needs_attention';

-- An outbox row may advance but never disappear. Deleting one would erase the
-- evidence that an effect might have happened, which is the single piece of
-- information the whole mechanism exists to preserve.
CREATE TRIGGER effects_no_delete BEFORE DELETE ON effects
BEGIN
  SELECT RAISE(ABORT, 'outbox rows are append-only: an effect record may never be deleted');
END;

-- Nor may a settled effect be un-settled, or its key rewritten.
CREATE TRIGGER effects_no_unsettle BEFORE UPDATE ON effects
WHEN OLD.state IN ('committed','compensated') AND NEW.state = 'intended'
BEGIN
  SELECT RAISE(ABORT, 'a committed effect cannot return to intended');
END;

CREATE TRIGGER effects_immutable_key BEFORE UPDATE OF idempotency_key ON effects
BEGIN
  SELECT RAISE(ABORT, 'the idempotency key is the identity of the effect and cannot change');
END;
`;
