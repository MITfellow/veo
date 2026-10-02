/**
 * The constitution projection (§25, M7).
 *
 * The document is derived, never authored in place. Ratification seeds the
 * articles; amendments add, edit, repeal and reorder them; proposals and
 * enforcement verdicts accumulate alongside. Drop every table here, replay
 * the log, and the same document comes back byte-identical — which is the
 * property §34.2 asks for and the reason §25's "every change is an event"
 * is worth the extra plumbing.
 *
 * One rule carried over from the facts projector: **no generated ids inside
 * a projector**. Row identity comes from the event (its id, or an id carried
 * in the payload), so a replay produces the same rows rather than merely
 * equivalent ones.
 */
import { canonicalJson } from '../hash.js';
import type { Projector } from '../events/log.js';
import type { PayloadOf } from '../events/types.js';
import type { Storage } from '../ports.js';

interface OrdinalRow {
  n: number | null;
}

export const constitutionProjector: Projector = {
  name: 'constitution',
  version: 1,
  handles: [
    'constitution.ratified',
    'constitution.amended',
    'constitution.proposed',
    'constitution.dismissed',
    'constitution.enforced',
  ],

  reset(storage: Storage) {
    storage.exec('DELETE FROM constitution_articles');
    storage.exec('DELETE FROM constitution_versions');
    storage.exec('DELETE FROM constitution_proposals');
    storage.exec('DELETE FROM constitution_enforcements');
  },

  apply(e, storage) {
    switch (e.type) {
      case 'constitution.ratified': {
        const p = e.payload as PayloadOf<'constitution.ratified'>;
        p.articles.forEach((a, index) => {
          storage.run(
            `INSERT INTO constitution_articles (
               id, ordinal, text, origin, kind, enforcement, check_id, remedy,
               enforced_by, entrenched, subject, stance, cites, added_version, created_at, repealed_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
             ON CONFLICT(id) DO NOTHING`,
            [
              a.id,
              index + 1,
              a.text,
              a.origin,
              a.kind,
              a.enforcement,
              a.check,
              a.remedy,
              a.enforcedBy,
              a.entrenched ? 1 : 0,
              a.subject,
              a.stance,
              a.cites,
              p.version,
              e.ts,
            ],
          );
        });
        storage.run(
          `INSERT INTO constitution_versions (version, hash, at, change, article_id, author, event_id)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(version) DO NOTHING`,
          [p.version, p.hash, e.ts, 'ratified', '', e.principal, e.id],
        );
        return;
      }

      case 'constitution.amended': {
        const p = e.payload as PayloadOf<'constitution.amended'>;
        if (p.change === 'repealed') {
          storage.run('UPDATE constitution_articles SET repealed_at = ? WHERE id = ?', [
            e.ts,
            p.articleId,
          ]);
        } else if (p.after !== null) {
          const a = p.after;
          const existing = storage.get<OrdinalRow>(
            'SELECT ordinal AS n FROM constitution_articles WHERE id = ?',
            [p.articleId],
          );
          if (existing) {
            storage.run(
              `UPDATE constitution_articles
                 SET text = ?, origin = ?, kind = ?, enforcement = ?, check_id = ?,
                     remedy = ?, enforced_by = ?, entrenched = ?, subject = ?, stance = ?,
                     cites = ?, repealed_at = NULL
               WHERE id = ?`,
              [
                a.text,
                a.origin,
                a.kind,
                a.enforcement,
                a.check,
                a.remedy,
                a.enforcedBy,
                a.entrenched ? 1 : 0,
                a.subject,
                a.stance,
                a.cites,
                p.articleId,
              ],
            );
          } else {
            // New articles land at the end. Precedence is computed from
            // origin and entrenchment at render time, so insertion order
            // only decides ties — which keeps "add an article" from
            // silently reordering the document.
            const max = storage.get<OrdinalRow>(
              'SELECT MAX(ordinal) AS n FROM constitution_articles',
            );
            storage.run(
              `INSERT INTO constitution_articles (
                 id, ordinal, text, origin, kind, enforcement, check_id, remedy,
                 enforced_by, entrenched, subject, stance, cites, added_version, created_at, repealed_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
              [
                a.id,
                (max?.n ?? 0) + 1,
                a.text,
                a.origin,
                a.kind,
                a.enforcement,
                a.check,
                a.remedy,
                a.enforcedBy,
                a.entrenched ? 1 : 0,
                a.subject,
                a.stance,
                a.cites,
                p.version,
                e.ts,
              ],
            );
          }
        }
        storage.run(
          `INSERT INTO constitution_versions (version, hash, at, change, article_id, author, event_id)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(version) DO NOTHING`,
          [p.version, p.hash, e.ts, p.change, p.articleId, p.author, e.id],
        );
        return;
      }

      case 'constitution.proposed': {
        const p = e.payload as PayloadOf<'constitution.proposed'>;
        storage.run(
          `INSERT INTO constitution_proposals (
             id, body_hash, article, rationale, derived_from, created_at, status
           ) VALUES (?,?,?,?,?,?, 'pending')
           ON CONFLICT(id) DO NOTHING`,
          [
            p.proposalId,
            bodyHashOf(p.article.text),
            canonicalJson(p.article),
            p.rationale,
            p.derivedFrom,
            e.ts,
          ],
        );
        return;
      }

      case 'constitution.dismissed': {
        const p = e.payload as PayloadOf<'constitution.dismissed'>;
        storage.run(
          `UPDATE constitution_proposals SET status = 'dismissed', decided_at = ? WHERE id = ?`,
          [e.ts, p.proposalId],
        );
        return;
      }

      case 'constitution.enforced': {
        const p = e.payload as PayloadOf<'constitution.enforced'>;
        for (const v of p.verdicts) {
          storage.run(
            `INSERT INTO constitution_enforcements (
               id, run_id, step_id, version, hash, article_id, check_id, verdict, detail, remedy, at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id, article_id) DO NOTHING`,
            [
              e.id,
              p.runId,
              p.stepId,
              p.version,
              p.hash,
              v.articleId,
              v.check,
              v.verdict,
              v.detail,
              p.remedy,
              e.ts,
            ],
          );
        }
        return;
      }

      default:
        return;
    }
  },
};

/**
 * The identity of a proposal's *body*, used to make a dismissal stick.
 *
 * Deliberately crude — lowercased, whitespace-collapsed, punctuation
 * stripped — because the failure it guards against is the agent re-proposing
 * "Always answer in bullet points." as "always answer in bullet points"
 * tomorrow night. It is not meant to catch a genuine rewrite, and a genuine
 * rewrite *should* be allowed back.
 */
export function bodyHashOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
