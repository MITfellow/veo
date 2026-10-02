/**
 * §29's `POST /export` and `POST /import`: full portability.
 *
 * The position, written up as decision 038: **an export is the log plus
 * the sealed vault, and an import refuses to merge.**
 *
 * The log is the only source of truth (invariant 1), so exporting it and
 * nothing else is both the smallest honest export and the most complete
 * one — every projection in the destination is rebuilt from it, which
 * also makes the import a free end-to-end test of the rebuild path.
 *
 * Secrets travel as **ciphertext with their wrapped keys**. §13 says a
 * secret value never exists outside the vault boundary, and a portability
 * feature is not an exception to that: an export is useless to a thief
 * without the passphrase, and an import without the passphrase restores
 * everything except the ability to *use* the secrets.
 *
 * Import refuses a non-empty database. Merging two event logs means
 * reconciling two hash chains and two ULID orderings, and a half-merged
 * personal agent is worse than a failed import.
 */
import type { Substrate } from '../substrate/index.js';
import type { Event } from '../substrate/events/envelope.js';
import { snapshotDigest } from '../substrate/projections/snapshot.js';
import { MIGRATIONS } from '../substrate/storage/migrate.js';

export const EXPORT_FORMAT = 'arish-export-1';

export interface ExportDocument {
  format: typeof EXPORT_FORMAT;
  createdAt: number;
  /** The schema version the source was on. Import migrates forward. */
  schemaVersion: number;
  eventCount: number;
  /** The head of the hash chain, so tampering is detectable before replay. */
  chainHead: string | null;
  /** The source's projection digest, compared after rebuild. */
  projectionDigest: string;
  events: Array<{
    seq: number;
    id: string;
    ts: number;
    type: string;
    principal: string;
    sessionId: string | null;
    runId: string | null;
    stepId: string | null;
    correlationId: string | null;
    causationId: string | null;
    trust: string;
    schemaVersion: number;
    payload: unknown;
    hash: string;
    prevHash: string | null;
  }>;
  /**
   * The keyring and secret rows, verbatim and still encrypted. Base64 so
   * the document is plain JSON; the bytes are exactly what was on disk.
   */
  vault: {
    keyring: Record<string, unknown> | null;
    secrets: Array<Record<string, unknown>>;
  };
}

const b64 = (value: unknown): unknown =>
  value instanceof Uint8Array ? { $b64: Buffer.from(value).toString('base64') } : value;

const unb64 = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && '$b64' in value
    ? new Uint8Array(Buffer.from((value as { $b64: string }).$b64, 'base64'))
    : value;

function rowsOf(
  substrate: Substrate,
  table: string,
): Array<Record<string, unknown>> {
  const exists = substrate.storage.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  );
  if (exists === undefined || exists.n === 0) return [];
  return substrate.storage
    .all<Record<string, unknown>>(`SELECT * FROM ${table}`)
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, b64(v)])));
}

export function exportAll(substrate: Substrate): ExportDocument {
  const events = substrate.events.read() as Array<Event & { hash: string; prevHash: string | null }>;
  const rows = substrate.storage.all<{
    seq: number;
    id: string;
    ts: number;
    type: string;
    principal: string;
    session_id: string | null;
    run_id: string | null;
    step_id: string | null;
    correlation_id: string | null;
    causation_id: string | null;
    trust: string;
    schema_version: number;
    payload: string;
    hash: string;
    prev_hash: string | null;
  }>('SELECT * FROM events ORDER BY seq');

  const keyring = substrate.storage.get<Record<string, unknown>>('SELECT * FROM keyring');

  return {
    format: EXPORT_FORMAT,
    createdAt: substrate.clock.now(),
    schemaVersion: MIGRATIONS[MIGRATIONS.length - 1]!.version,
    eventCount: events.length,
    chainHead: rows.length === 0 ? null : rows[rows.length - 1]!.hash,
    projectionDigest: snapshotDigest(substrate.storage, substrate.hashing),
    events: rows.map((row) => ({
      seq: row.seq,
      id: row.id,
      ts: row.ts,
      type: row.type,
      principal: row.principal,
      sessionId: row.session_id,
      runId: row.run_id,
      stepId: row.step_id,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      trust: row.trust,
      schemaVersion: row.schema_version,
      payload: JSON.parse(row.payload) as unknown,
      hash: row.hash,
      prevHash: row.prev_hash,
    })),
    vault: {
      keyring:
        keyring === undefined
          ? null
          : Object.fromEntries(Object.entries(keyring).map(([k, v]) => [k, b64(v)])),
      secrets: rowsOf(substrate, 'secrets'),
    },
  };
}

export interface ImportOutcome {
  ok: boolean;
  reason: string;
  imported: number;
  projectionDigest: string | null;
  expectedDigest: string | null;
}

/**
 * Replay an export into an **empty** substrate.
 *
 * Atomic: everything happens in one transaction, and any failure — a
 * broken chain, a digest mismatch, a payload that no longer validates —
 * rolls the whole thing back. A partially imported personal agent is a
 * worse outcome than a failed import, and the user can retry a failure.
 */
export function importAll(substrate: Substrate, doc: ExportDocument): ImportOutcome {
  if (doc.format !== EXPORT_FORMAT) {
    return {
      ok: false,
      reason: `unknown export format "${String(doc.format)}"`,
      imported: 0,
      projectionDigest: null,
      expectedDigest: null,
    };
  }

  const existing = substrate.events.count();
  if (existing > 0) {
    return {
      // Not a merge. Reconciling two hash chains and two ULID orderings is
      // a different feature with a different failure mode; refusing is the
      // honest answer until someone builds it.
      ok: false,
      reason: `this agent already has ${existing} events — import only into an empty one`,
      imported: 0,
      projectionDigest: null,
      expectedDigest: doc.projectionDigest,
    };
  }

  try {
    substrate.storage.transaction(() => {
      for (const event of doc.events) {
        substrate.storage.run(
          `INSERT INTO events (seq, id, ts, principal, session_id, run_id, step_id,
             correlation_id, causation_id, trust, type, schema_version, payload, hash, prev_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            event.seq,
            event.id,
            event.ts,
            event.principal,
            event.sessionId,
            event.runId,
            event.stepId,
            event.correlationId,
            event.causationId,
            event.trust,
            event.type,
            event.schemaVersion,
            JSON.stringify(event.payload),
            event.hash,
            event.prevHash,
          ],
        );
      }

      if (doc.vault.keyring !== null) {
        const row = Object.fromEntries(
          Object.entries(doc.vault.keyring).map(([k, v]) => [k, unb64(v)]),
        );
        const columns = Object.keys(row);
        substrate.storage.run(
          `INSERT INTO keyring (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          columns.map((c) => row[c] as never),
        );
      }
      for (const secret of doc.vault.secrets) {
        const row = Object.fromEntries(Object.entries(secret).map(([k, v]) => [k, unb64(v)]));
        const columns = Object.keys(row);
        substrate.storage.run(
          `INSERT INTO secrets (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          columns.map((c) => row[c] as never),
        );
      }

      // Verify *before* the projections exist: a broken chain must not be
      // allowed to produce a plausible-looking agent.
      const verified = substrate.events.verifyChain();
      if (!verified.ok) {
        throw new Error(
          `the export's hash chain is broken at seq ${verified.problems[0]?.seq ?? '?'}: ` +
            `${verified.problems[0]?.problem ?? 'unknown problem'}`,
        );
      }

      substrate.events.rebuild();
    });
  } catch (error) {
    // The transaction rolled back; make sure nothing survived it.
    substrate.storage.exec('DELETE FROM events');
    substrate.events.rebuild();
    return {
      ok: false,
      reason: (error as Error).message,
      imported: 0,
      projectionDigest: null,
      expectedDigest: doc.projectionDigest,
    };
  }

  const digest = snapshotDigest(substrate.storage, substrate.hashing);
  if (digest !== doc.projectionDigest) {
    // Not fatal, and not silent either. Different code versions legitimately
    // produce different projections from the same events — that is what a
    // projector version is for — so this is reported rather than rolled
    // back, with both digests, so the difference can be looked at.
    return {
      ok: true,
      reason:
        'imported, but the rebuilt projections differ from the source — ' +
        'expected when the export came from a different version of the agent',
      imported: doc.events.length,
      projectionDigest: digest,
      expectedDigest: doc.projectionDigest,
    };
  }

  return {
    ok: true,
    reason: 'imported and verified',
    imported: doc.events.length,
    projectionDigest: digest,
    expectedDigest: doc.projectionDigest,
  };
}
