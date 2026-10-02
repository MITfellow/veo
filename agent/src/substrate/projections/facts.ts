import { canonicalJson } from '../hash.js';
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';
import type { Storage } from '../ports.js';

/**
 * The bitemporal fact projection (§11).
 *
 * Two timelines, kept strictly apart:
 *
 *   valid time       when the statement was true *of the world*
 *   transaction time when this system *believed* it
 *
 * They are not the same and conflating them loses the ability to answer the
 * question that matters after a mistake: "you told me X in March — were you
 * already wrong then, or did it change later?" Valid time explains the world;
 * transaction time explains the agent.
 *
 * Superseding never deletes. It stamps `superseded_at` on the old row and
 * inserts a new one with the same logical `fact_id`. The old belief stays
 * queryable forever, which is what makes the agent auditable rather than
 * merely confident.
 */

interface FactRowId {
  id: string;
}

export const factsProjector: Projector = {
  name: 'facts',
  version: 1,
  handles: [
    'memory.written',
    'memory.updated',
    'memory.superseded',
    'memory.corrected',
    'memory.forgotten',
    'memory.disputed',
    // M9: usage counters are derived state like everything else here.
    // They used to be written straight to the table by `markUsed()`,
    // which meant a rebuild silently reset them — a real invariant-1
    // leak, found by running `POST /backup/verify` against a database
    // that had actually been used.
    'memory.used',
  ],

  reset(storage: Storage) {
    storage.exec('DELETE FROM facts');
    storage.exec('DELETE FROM facts_fts');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'memory.written': {
        const p = e.payload as PayloadOf<'memory.written'>;
        // Row identity is the event id: one event, one belief-version. That
        // makes replay deterministic — no generated ids inside a projector.
        const rowId = e.id;
        storage.run(
          `INSERT INTO facts (
             id, fact_id, subject, predicate, object,
             valid_from, valid_to, recorded_at, superseded_at, superseded_by,
             basis, confidence, sources, derivation,
             observation_count, last_confirmed_at, last_used_at, use_count,
             stability, sensitivity, status, pinned, trust, key_id, event_seq,
             principal
           ) VALUES (?,?,?,?,?, ?,?,?,NULL,NULL, ?,?,?,NULL, 1,?,NULL,0, ?,?,?,0,?,NULL,?, ?)
           ON CONFLICT(id) DO NOTHING`,
          [
            rowId,
            p.factId,
            p.subject,
            p.predicate,
            canonicalJson(p.object),
            p.validFrom,
            p.validTo,
            e.ts,
            p.basis,
            p.confidence,
            canonicalJson(p.sources),
            e.ts,
            p.stability,
            p.sensitivity,
            p.status,
            e.trust,
            e.seq,
            e.principal,
          ],
        );
        storage.run('INSERT INTO facts_fts (fact_id, row_id, text) VALUES (?,?,?)', [
          p.factId,
          rowId,
          factText(p.subject, p.predicate, p.object),
        ]);
        break;
      }

      case 'memory.updated': {
        const p = e.payload as PayloadOf<'memory.updated'>;
        // Confidence and usage counters are *metadata about a belief*, not the
        // belief itself, so they update in place rather than superseding. A
        // new row per "I used this fact" would bury the real history.
        const sets: string[] = [];
        const params: Array<string | number> = [];
        if (p.confidence !== undefined) {
          sets.push('confidence = ?');
          params.push(p.confidence);
        }
        if (p.observationCount !== undefined) {
          sets.push('observation_count = ?', 'last_confirmed_at = ?');
          params.push(p.observationCount, e.ts);
        }
        if (p.status !== undefined) {
          sets.push('status = ?');
          params.push(p.status);
        }
        if (p.pinned !== undefined) {
          sets.push('pinned = ?');
          params.push(p.pinned ? 1 : 0);
        }
        if (sets.length === 0) break;
        params.push(p.factId);
        storage.run(
          `UPDATE facts SET ${sets.join(', ')} WHERE fact_id = ? AND superseded_at IS NULL`,
          params,
        );
        break;
      }

      case 'memory.superseded': {
        const p = e.payload as PayloadOf<'memory.superseded'>;
        // Closes *valid* time only, and deliberately leaves `superseded_at`
        // NULL.
        //
        // "Maya moved to Globex in April" does not make the Acme record false:
        // it was true, of that period, and we still believe it. Only valid time
        // ends. Stamping transaction time here would retract a record that is
        // still correct, and "where did she work in March?" would answer
        // nothing at all.
        //
        // Transaction time is closed by `memory.corrected` — the case where we
        // were wrong rather than the case where the world moved on. Keeping
        // those two apart is the entire reason for having two timelines.
        storage.run(
          `UPDATE facts SET superseded_by = ?, valid_to = ?
           WHERE fact_id = ? AND superseded_at IS NULL AND valid_to IS NULL`,
          [p.supersededBy, p.validTo, p.factId],
        );
        break;
      }

      case 'memory.used': {
        const p = e.payload as PayloadOf<'memory.used'>;
        for (const factId of p.factIds) {
          storage.run(
            `UPDATE facts SET last_used_at = ?, use_count = use_count + 1
             WHERE fact_id = ? AND superseded_at IS NULL`,
            [e.ts, factId],
          );
        }
        break;
      }

      case 'memory.disputed': {
        const p = e.payload as PayloadOf<'memory.disputed'>;
        storage.run(`UPDATE facts SET status = 'disputed' WHERE fact_id = ? AND superseded_at IS NULL`, [
          p.factId,
        ]);
        break;
      }

      case 'memory.corrected': {
        const p = e.payload as PayloadOf<'memory.corrected'>;
        // We were wrong — a retraction, not a change in the world. This is the
        // one that closes *transaction* time: from now on we no longer hold
        // this belief, but "what did you think in March?" still finds it.
        // A user correction outranks inference (invariant 12); the replacement
        // value arrives as its own memory.written so both stay visible.
        storage.run(
          `UPDATE facts SET status = 'retired', superseded_at = ? WHERE fact_id = ? AND superseded_at IS NULL`,
          [e.ts, p.factId],
        );
        break;
      }

      case 'memory.forgotten': {
        const p = e.payload as PayloadOf<'memory.forgotten'>;
        // Crypto-shredding (§13.3): the row stays so the *shape* of history is
        // intact and the chain still verifies, but the content is gone with the
        // key. Deleting the row instead would make forgetting indistinguishable
        // from never-happened, and would break the audit trail of deletions.
        const rows = storage.all<FactRowId>('SELECT id FROM facts WHERE fact_id = ?', [p.factId]);
        storage.run(
          // Unpinned too: a pin is a standing instruction to keep something
          // in every conversation, and a destroyed belief cannot be kept in
          // anything. Leaving the flag set left the inspector showing
          // "PINNED" on a memory that no longer exists.
          `UPDATE facts SET object = ?, status = 'retired', superseded_at = COALESCE(superseded_at, ?),
             key_id = ?, confidence = 0, pinned = 0 WHERE fact_id = ?`,
          [canonicalJson({ $shredded: true, keyId: p.keyId }), e.ts, p.keyId, p.factId],
        );
        for (const r of rows) {
          storage.run('DELETE FROM facts_fts WHERE row_id = ?', [r.id]);
        }
        break;
      }

      default:
        break;
    }
  },
};

function factText(subject: string, predicate: string, object: unknown): string {
  const obj = typeof object === 'string' ? object : canonicalJson(object);
  return `${subject} ${predicate.replaceAll('_', ' ')} ${obj}`;
}

/* ───────────────────────────── bitemporal queries ─────────────────────────── */

export interface FactRow {
  id: string;
  fact_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
  recorded_at: number;
  superseded_at: number | null;
  basis: string;
  confidence: number;
  sources: string;
  status: string;
  trust: string;
}

const SELECT = `SELECT id, fact_id, subject, predicate, object, valid_from, valid_to,
  recorded_at, superseded_at, basis, confidence, sources, status, trust FROM facts`;

/** What is true now, as far as we currently believe. */
export function currentFacts(storage: Storage, subject: string, predicate?: string): FactRow[] {
  const extra = predicate !== undefined ? ' AND predicate = ?' : '';
  const params: Array<string | number> = predicate !== undefined ? [subject, predicate] : [subject];
  return storage.all<FactRow>(
    `${SELECT} WHERE subject = ?${extra} AND superseded_at IS NULL AND valid_to IS NULL
     AND status IN ('active','disputed') ORDER BY confidence DESC, recorded_at DESC`,
    params,
  );
}

/** What was true of the world at `at`, as far as we believe *now*. */
export function factsAsOfValidTime(
  storage: Storage,
  subject: string,
  at: number,
  predicate?: string,
): FactRow[] {
  const extra = predicate !== undefined ? ' AND predicate = ?' : '';
  const params: Array<string | number> =
    predicate !== undefined ? [subject, at, at, predicate] : [subject, at, at];
  return storage.all<FactRow>(
    `${SELECT} WHERE subject = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)${extra}
     AND superseded_at IS NULL ORDER BY confidence DESC`,
    params,
  );
}

/** What we *believed* at `at`, right or wrong. The honesty query. */
export function factsAsOfTransactionTime(
  storage: Storage,
  subject: string,
  at: number,
  predicate?: string,
): FactRow[] {
  const extra = predicate !== undefined ? ' AND predicate = ?' : '';
  const params: Array<string | number> =
    predicate !== undefined ? [subject, at, at, predicate] : [subject, at, at];
  return storage.all<FactRow>(
    `${SELECT} WHERE subject = ? AND recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)${extra}
     ORDER BY confidence DESC`,
    params,
  );
}

/** Both axes at once: "on date R, what did we think was true on date V?" */
export function factsBitemporal(
  storage: Storage,
  subject: string,
  validAt: number,
  recordedAt: number,
): FactRow[] {
  return storage.all<FactRow>(
    `${SELECT} WHERE subject = ?
       AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       AND recorded_at <= ? AND (superseded_at IS NULL OR superseded_at > ?)
     ORDER BY confidence DESC`,
    [subject, validAt, validAt, recordedAt, recordedAt],
  );
}

/** Every version of one logical fact, oldest belief first. */
export function factHistory(storage: Storage, factId: string): FactRow[] {
  return storage.all<FactRow>(`${SELECT} WHERE fact_id = ? ORDER BY recorded_at ASC, id ASC`, [factId]);
}
