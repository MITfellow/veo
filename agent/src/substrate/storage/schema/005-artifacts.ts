/**
 * Migration v5 — widen `artifacts` for the real artifact store (M3).
 *
 * The M0 table was a placeholder with `id, kind, bytes, summary, run_id,
 * created_at`. Storing an artifact for real needs three more things:
 *
 *  - `step_id`   — which step produced it, so a trace can attribute it
 *  - `media_type`— how to render it without sniffing bytes
 *  - `sha256`    — content identity, for dedupe and for proving a stored
 *                  artifact has not been altered since it was written
 *
 * Added as a migration rather than by editing `001-init.ts`, because the
 * migration runner is checksum-guarded: changing an applied migration is
 * refused, which is precisely the protection you want. An edited migration
 * is the difference between "fresh database" and "upgraded database" behaving
 * differently, which is the worst class of bug to debug.
 */
export const SCHEMA_005 = `
ALTER TABLE artifacts ADD COLUMN step_id    TEXT;
ALTER TABLE artifacts ADD COLUMN media_type TEXT NOT NULL DEFAULT 'application/octet-stream';
ALTER TABLE artifacts ADD COLUMN sha256     TEXT;
CREATE INDEX artifacts_run_step ON artifacts (run_id, step_id);
CREATE INDEX artifacts_digest   ON artifacts (sha256);
`;
