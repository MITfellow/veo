/**
 * An expression index on the subject id (M9).
 *
 * Found by the 100k/50k performance pass: `bySubject()` — the hottest
 * query in the memory layer, run on every turn — took **530ms** at 50k
 * facts. The subject is stored as canonical JSON (a known weak point
 * carried since M6), so `json_extract(subject, '$.id') = ?` could not
 * use `facts_sp`, which indexes the whole JSON blob. Every row was
 * scanned and parsed.
 *
 * SQLite indexes expressions, so the fix is an index on exactly the
 * expression the query uses. No column change, no rewrite of the subject
 * representation, no migration of existing rows — and the json-blob weak
 * point stays written down rather than being quietly worked around.
 */
/*
 * The expression is guarded with `json_valid`. A plain-string subject is
 * legal in the event payload — several tests and the earliest migrations
 * write one — and an unguarded `json_extract` raises "malformed JSON"
 * *at insert time*, which would turn a reporting convenience into a
 * write-path failure. Found immediately by the bitemporal suite, which
 * is exactly the kind of thing an index is not allowed to break.
 */
export const SCHEMA_013 = `
CREATE INDEX IF NOT EXISTS facts_subject_id
  ON facts (
    CASE WHEN json_valid(subject) THEN json_extract(subject, '$.id') ELSE subject END,
    superseded_at,
    status
  );
`;
