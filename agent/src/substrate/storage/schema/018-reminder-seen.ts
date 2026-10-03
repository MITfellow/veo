/**
 * S4: whether a fired reminder was ever actually looked at.
 *
 * S3 recorded that a reminder fired. It had no way to record that the
 * person saw it, which meant the app could not tell the difference
 * between "told you and you ignored it" and "told you while the
 * window was closed and never mentioned it again". The second is not
 * a reminder at all, and it was the common case.
 *
 * A column rather than a second table: it is one nullable timestamp
 * on a row that already exists, and a join to find out whether a
 * notification is still outstanding would be three tables deep for no
 * gain.
 */
export const SCHEMA_018 = `
ALTER TABLE reminders ADD COLUMN seen_at INTEGER;

-- The badge's query: fired, not cancelled, not yet looked at.
CREATE INDEX IF NOT EXISTS idx_reminders_unseen
  ON reminders (principal, fired_at)
  WHERE fired_at IS NOT NULL AND seen_at IS NULL AND cancelled_at IS NULL;
`;
