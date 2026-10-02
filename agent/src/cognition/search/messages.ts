/**
 * Search over the agent's own messages (S2).
 *
 * This is a **recall path**, not a database query, and §22's rules apply
 * to it. The cheap version — "it is just SQL, return the rows" — would
 * be a hole straight through the trust model, because the easiest way
 * to get a fenced web page into the agent's reasoning is to let it
 * search for one and read the result back as if the user had said it.
 *
 * So: FOREIGN messages are excluded in the query itself rather than
 * filtered afterwards, and the caller is told the highest trust level
 * present in what came back.
 */
import type { Storage } from '../../substrate/ports.js';
import type { TrustLevel } from '../../substrate/events/types.js';

export interface MessageHit {
  id: string;
  sessionId: string;
  role: string;
  text: string;
  ts: number;
  trust: TrustLevel;
  /** The message immediately before this one, for context. */
  before: { role: string; text: string } | null;
  /** And the one immediately after — usually the answer to the hit. */
  after: { role: string; text: string } | null;
}

export interface SearchOptions {
  sessionId?: string;
  limit?: number;
  /** Characters of each neighbouring turn to keep. */
  context?: number;
}

const MAX_LIMIT = 25;
const DEFAULT_CONTEXT = 160;

/**
 * FTS5 treats a bare apostrophe or quote as syntax, so a query like
 * `don't` is a parse error rather than a search. Quoting each term and
 * joining them turns the whole thing into a phrase-ish AND query, which
 * is what a person typing words into a box means anyway.
 */
function toMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"`).join(' AND ');
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

export class MessageSearch {
  constructor(private readonly deps: { storage: Storage }) {}

  search(query: string, options: SearchOptions = {}): MessageHit[] {
    const match = toMatchQuery(query);
    if (match === '') return [];

    const limit = Math.min(Math.max(options.limit ?? 10, 1), MAX_LIMIT);
    const context = options.context ?? DEFAULT_CONTEXT;

    const params: Array<string | number> = [match];
    let sessionFilter = '';
    if (options.sessionId !== undefined) {
      sessionFilter = 'AND m.session_id = ?';
      params.push(options.sessionId);
    }

    // §22: foreign content is never recallable. Excluded in the query
    // rather than filtered after, so a future caller that forgets to
    // filter cannot reintroduce it.
    const rows = this.deps.storage.all<{
      id: string;
      session_id: string;
      role: string;
      text: string;
      ts: number;
      trust: TrustLevel;
      seq: number;
    }>(
      `SELECT m.id, m.session_id, m.role, m.text, m.ts, m.trust, m.seq
         FROM messages_fts f
         JOIN messages m ON m.id = f.row_id
        WHERE messages_fts MATCH ?
          AND m.trust != 'FOREIGN'
          ${sessionFilter}
        ORDER BY rank, m.ts DESC
        LIMIT ${limit}`,
      params,
    );

    return rows.map((row) => {
      const before = this.deps.storage.get<{ role: string; text: string }>(
        `SELECT role, text FROM messages
          WHERE session_id = ? AND seq < ? AND trust != 'FOREIGN'
          ORDER BY seq DESC LIMIT 1`,
        [row.session_id, row.seq],
      );
      const after = this.deps.storage.get<{ role: string; text: string }>(
        `SELECT role, text FROM messages
          WHERE session_id = ? AND seq > ? AND trust != 'FOREIGN'
          ORDER BY seq ASC LIMIT 1`,
        [row.session_id, row.seq],
      );
      return {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        text: row.text,
        ts: row.ts,
        trust: row.trust,
        before:
          before === undefined ? null : { role: before.role, text: clip(before.text, context) },
        after: after === undefined ? null : { role: after.role, text: clip(after.text, context) },
      };
    });
  }
}

/**
 * The trust of a result set is the trust of its **least** trusted
 * member.
 *
 * The S2 design note said "max", and the design note was wrong — said
 * out loud here rather than quietly implemented, per §36. A search
 * result is one blob of text containing several messages. If one of
 * them is TOOL-trust content and the result is labelled USER, that
 * content has just been laundered into the user's own voice, which is
 * exactly the move the trust model exists to prevent. Taking the
 * minimum means a result can never be more trusted than the weakest
 * thing inside it, which is the same rule §19 applies to a run.
 *
 * An empty result set contains nothing to taint, so it is USER.
 */
export function trustOf(hits: readonly MessageHit[]): TrustLevel {
  const order: TrustLevel[] = ['FOREIGN', 'TOOL', 'DERIVED', 'USER', 'SYSTEM'];
  if (hits.length === 0) return 'USER';
  let weakest = order.length - 1;
  for (const hit of hits) {
    const rank = order.indexOf(hit.trust);
    if (rank >= 0) weakest = Math.min(weakest, rank);
  }
  return order[weakest] ?? 'DERIVED';
}
