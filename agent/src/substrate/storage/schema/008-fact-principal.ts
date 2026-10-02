/**
 * Migration 008 — facts belong to someone.
 *
 * M1's `facts` table has no `principal` column, so every query that takes a
 * principal argument has been ignoring it. With one user that is invisible;
 * the moment there are two it is a cross-tenant data leak, and it is the
 * kind of bug that is found in production rather than in review because
 * every signature already *looks* right.
 *
 * Found while writing the M6 adversarial test for exactly this (test 43):
 * the test passed against two separate databases, which proved nothing.
 * §15 is explicit that the principal is never hardcoded, and a store that
 * cannot filter by it cannot honour that.
 *
 * Backfilled from the writing event, which has carried the principal all
 * along — so no belief loses its owner in the upgrade.
 */
export const SCHEMA_008 = `
ALTER TABLE facts ADD COLUMN principal TEXT NOT NULL DEFAULT '';

UPDATE facts
   SET principal = COALESCE((SELECT e.principal FROM events e WHERE e.id = facts.id), '');

CREATE INDEX facts_principal ON facts(principal, status, valid_to);
`;
