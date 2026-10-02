/**
 * §29's persona: how the agent sounds (decision 036).
 *
 * One row, keyed by principal, projected from `persona.updated` events —
 * the same shape as every other projection here, so dropping the table and
 * rebuilding gives the same voice back.
 */
export const SCHEMA_012 = `
CREATE TABLE IF NOT EXISTS personas (
  principal     TEXT PRIMARY KEY,
  agent_name    TEXT NOT NULL,
  address_user  TEXT NOT NULL,
  formality     TEXT NOT NULL CHECK (formality IN ('plain','warm','formal')),
  length        TEXT NOT NULL CHECK (length IN ('brief','normal','thorough')),
  emoji         INTEGER NOT NULL CHECK (emoji IN (0,1)),
  language      TEXT NOT NULL,
  notes         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  seq           INTEGER NOT NULL
);
`;
