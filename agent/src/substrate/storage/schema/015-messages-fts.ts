/**
 * S2: full text over the agent's own messages.
 *
 * Until now `facts_fts` was the only FTS table in the system, which
 * meant the agent could search what it had *concluded* but not what was
 * actually said. Everything older than the context window was in the
 * log and unreachable.
 *
 * Maintained by the messages projector, not by a SQLite trigger. A
 * trigger would be less code and would break `rebuild()`: it fires on
 * the projector's own INSERT, so a replay would double-insert unless
 * the reset path cleared this table too — at which point there are two
 * mechanisms that have to agree about the same invariant. Keeping it in
 * the projector keeps one rule: the log is the truth, the projection is
 * derived, and `reset()` clears everything the projector owns.
 *
 * `row_id` is the message id, so a result can be joined back to the
 * `messages` row for its session, timestamp and trust — none of which
 * belong in the index itself.
 */
export const SCHEMA_015 = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  row_id     UNINDEXED,
  session_id UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`;
