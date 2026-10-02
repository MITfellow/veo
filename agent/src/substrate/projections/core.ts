import { canonicalJson } from '../hash.js';
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';

/**
 * Projections.
 *
 * Every one of these is a pure function of the log. They hold no information
 * that could not be recomputed by replaying events from seq 1, which is what
 * makes `rebuild-identity` a meaningful test rather than a tautology.
 *
 * Two rules the projectors follow:
 *  - they never read the clock; timestamps come from `event.ts`, so a replay
 *    years later produces identical rows;
 *  - they are idempotent per event, so a crash between the event insert and
 *    the projection write heals on the next rebuild.
 */

/* ───────────────────────────────── sessions ───────────────────────────────── */

export const sessionsProjector: Projector = {
  name: 'sessions',
  version: 1,
  handles: [
    'session.created',
    'session.titled',
    'session.archived',
    'session.locked',
    'message.user',
    'message.agent',
    'message.system',
  ],
  reset(storage) {
    storage.exec('DELETE FROM sessions');
  },
  apply(e, storage) {
    const sid = e.sessionId;
    if (sid === null) return;

    switch (e.type) {
      case 'session.created': {
        const p = e.payload as PayloadOf<'session.created'>;
        storage.run(
          `INSERT INTO sessions (id, title, created_at, updated_at, archived_at, locked, message_count)
           VALUES (?, ?, ?, ?, NULL, 0, 0)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
          [sid, p.title, e.ts, e.ts],
        );
        break;
      }
      case 'session.titled': {
        const p = e.payload as PayloadOf<'session.titled'>;
        storage.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [p.title, e.ts, sid]);
        break;
      }
      case 'session.archived':
        storage.run('UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?', [e.ts, e.ts, sid]);
        break;
      case 'session.locked':
        storage.run('UPDATE sessions SET locked = 1, updated_at = ? WHERE id = ?', [e.ts, sid]);
        break;
      case 'message.user':
      case 'message.agent':
      case 'message.system':
        // A session row can be created by its first message: the log is the
        // truth, and a message whose session.created was never written is
        // still a message that happened.
        storage.run(
          `INSERT INTO sessions (id, title, created_at, updated_at, archived_at, locked, message_count)
           VALUES (?, NULL, ?, ?, NULL, 0, 1)
           ON CONFLICT(id) DO UPDATE SET
             updated_at = excluded.updated_at,
             message_count = sessions.message_count + 1`,
          [sid, e.ts, e.ts],
        );
        break;
      default:
        break;
    }
  },
};

/* ───────────────────────────────── messages ───────────────────────────────── */

export const messagesProjector: Projector = {
  name: 'messages',
  version: 1,
  handles: ['message.user', 'message.agent', 'message.system'],
  reset(storage) {
    storage.exec('DELETE FROM messages');
  },
  apply(e, storage) {
    if (e.sessionId === null) return;
    const role = e.type.slice('message.'.length);
    const text = (e.payload as { text: string }).text;
    storage.run(
      `INSERT INTO messages (id, seq, session_id, run_id, role, text, ts, trust)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO NOTHING`,
      [e.id, e.seq, e.sessionId, e.runId, role, text, e.ts, e.trust],
    );
  },
};

/* ────────────────────────────────── runs ──────────────────────────────────── */

export const runsProjector: Projector = {
  name: 'runs',
  version: 1,
  handles: [
    'run.started',
    'run.finished',
    'run.failed',
    'run.cancelled',
    'run.suspended',
    'run.resumed',
    'step.finished',
    'model.responded',
  ],
  reset(storage) {
    storage.exec('DELETE FROM runs');
  },
  apply(e, storage) {
    const rid = e.runId;
    if (rid === null) return;

    switch (e.type) {
      case 'run.started': {
        const p = e.payload as PayloadOf<'run.started'>;
        storage.run(
          `INSERT INTO runs (id, session_id, trigger, state, started_at, ended_at, steps, tokens, cost_cents)
           VALUES (?,?,?,'running',?,NULL,0,0,0)
           ON CONFLICT(id) DO UPDATE SET state = 'running', started_at = excluded.started_at`,
          [rid, p.sessionId, p.trigger, e.ts],
        );
        break;
      }
      case 'run.finished': {
        const p = e.payload as PayloadOf<'run.finished'>;
        storage.run(
          `UPDATE runs SET state = 'finished', ended_at = ?, steps = ?,
             tokens = COALESCE(?, tokens), cost_cents = COALESCE(?, cost_cents) WHERE id = ?`,
          [e.ts, p.steps, p.tokens ?? null, p.costCents ?? null, rid],
        );
        break;
      }
      case 'run.failed': {
        const p = e.payload as PayloadOf<'run.failed'>;
        storage.run(
          `UPDATE runs SET state = 'failed', ended_at = ?, error_kind = ?, error_message = ? WHERE id = ?`,
          [e.ts, p.kind, p.message, rid],
        );
        break;
      }
      case 'run.cancelled':
        storage.run(`UPDATE runs SET state = 'cancelled', ended_at = ? WHERE id = ?`, [e.ts, rid]);
        break;
      case 'run.suspended':
        storage.run(`UPDATE runs SET state = 'suspended' WHERE id = ?`, [rid]);
        break;
      case 'run.resumed':
        storage.run(`UPDATE runs SET state = 'running' WHERE id = ?`, [rid]);
        break;
      case 'step.finished':
        storage.run(`UPDATE runs SET steps = steps + 1 WHERE id = ?`, [rid]);
        break;
      case 'model.responded': {
        const p = e.payload as PayloadOf<'model.responded'>;
        storage.run(`UPDATE runs SET tokens = tokens + ?, cost_cents = cost_cents + ? WHERE id = ?`, [
          p.outputTokens,
          p.costCents ?? 0,
          rid,
        ]);
        break;
      }
      default:
        break;
    }
  },
};

/* ───────────────────────────────── entities ───────────────────────────────── */

export const entitiesProjector: Projector = {
  name: 'entities',
  version: 1,
  handles: ['entity.upserted', 'entity.merged'],
  reset(storage) {
    storage.exec('DELETE FROM entities');
  },
  apply(e, storage) {
    if (e.type === 'entity.upserted') {
      const p = e.payload as PayloadOf<'entity.upserted'>;
      storage.run(
        `INSERT INTO entities (id, kind, name, aliases, merged_into, created_at, updated_at)
         VALUES (?,?,?,?,NULL,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name,
           aliases = excluded.aliases, updated_at = excluded.updated_at`,
        [p.entityId, p.kind, p.name, canonicalJson(p.aliases), e.ts, e.ts],
      );
    } else if (e.type === 'entity.merged') {
      const p = e.payload as PayloadOf<'entity.merged'>;
      // `from === into` means *unmerge* (decision 028).
      //
      // An entity merged into itself cannot mean anything else, and §22.2
      // requires merges to be reversible. The alternative was a ninth
      // memory event, which would have reopened the closed event set for a
      // case the existing payload can already express unambiguously. The
      // reason string on the event says which direction it was, so the
      // audit trail reads correctly either way.
      const into = p.from === p.into ? null : p.into;
      storage.run('UPDATE entities SET merged_into = ?, updated_at = ? WHERE id = ?', [into, e.ts, p.from]);
    }
  },
};

/* ──────────────────────────────── artifacts ───────────────────────────────── */

export const artifactsProjector: Projector = {
  name: 'artifacts',
  version: 1,
  handles: ['artifact.created'],
  reset(storage) {
    storage.exec('DELETE FROM artifacts');
  },
  apply(e, storage) {
    const p = e.payload as PayloadOf<'artifact.created'>;
    storage.run(
      `INSERT INTO artifacts (id, kind, bytes, summary, run_id, created_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      [p.artifactId, p.kind, p.bytes, p.summary, e.runId, e.ts],
    );
  },
};



/* ────────────────────────────────── steps ─────────────────────────────────── */

/**
 * One row per step (M2, §26).
 *
 * The row is inserted on `step.started` — *before* the model is called — and
 * updated on `step.finished`. A row with `finished_at IS NULL` after the
 * process comes back up is an interrupted step, and that is a fact derived
 * from the log rather than a status someone had to remember to write.
 */
export const stepsProjector: Projector = {
  name: 'steps',
  version: 1,
  handles: ['step.started', 'step.finished', 'model.responded'],
  reset(storage) {
    storage.exec('DELETE FROM steps');
  },
  apply(e, storage) {
    const stepId = e.stepId;
    if (stepId === null || e.runId === null || e.sessionId === null) return;

    switch (e.type) {
      case 'step.started': {
        const p = e.payload as PayloadOf<'step.started'>;
        storage.run(
          `INSERT INTO steps (id, run_id, session_id, idx, started_at, finished_at, outcome, duration_ms, trust)
           VALUES (?,?,?,?,?,NULL,NULL,NULL,?)
           ON CONFLICT(id) DO NOTHING`,
          [stepId, e.runId, e.sessionId, p.index, e.ts, p.effectiveTrust],
        );
        break;
      }
      case 'step.finished': {
        const p = e.payload as PayloadOf<'step.finished'>;
        storage.run(
          `UPDATE steps SET finished_at = ?, outcome = ?, duration_ms = ? WHERE id = ?`,
          [e.ts, p.outcome, p.durationMs, stepId],
        );
        break;
      }
      case 'model.responded': {
        const p = e.payload as PayloadOf<'model.responded'>;
        storage.run(`UPDATE steps SET model_tokens = model_tokens + ? WHERE id = ?`, [
          p.outputTokens,
          stepId,
        ]);
        break;
      }
      default:
        break;
    }
  },
};

export const CORE_PROJECTORS: readonly Projector[] = Object.freeze([
  sessionsProjector,
  messagesProjector,
  runsProjector,
  entitiesProjector,
  artifactsProjector,
  stepsProjector,
]);

