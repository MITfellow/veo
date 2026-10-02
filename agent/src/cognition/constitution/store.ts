/**
 * `ConstitutionStore` — the document's mechanics (§25, L4).
 *
 * Everything that changes the constitution goes through an event, exactly as
 * memory does, and for the same reason: §25 promises that "the agent started
 * talking differently on this date, because of this" is always answerable.
 * The read side is a projection; `at(ts)` answers the historical question by
 * reading the version log rather than by keeping a second copy of the past.
 *
 * Two rules are enforced here rather than at the HTTP edge, because an
 * invariant that lives in a route handler is an invariant that the next
 * caller skips:
 *
 *   - **Entrenched articles cannot be repealed** (`EntrenchedArticleError`).
 *   - **The agent cannot ratify.** `propose()` writes a proposal and nothing
 *     else; only `amend()`/`adopt()`, which require a principal author, move
 *     the document. A system that can rewrite its own behavioural contract
 *     unsupervised does not have a contract, it has a habit.
 */
import { canonicalJson, hashing } from '../../substrate/hash.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { Clock, Ids, Storage } from '../../substrate/ports.js';
import { bodyHashOf } from '../../substrate/projections/constitution.js';
import { FOUNDING_ARTICLES, FOUNDING_VERSION } from './founding.js';
import {
  ArticleSchema,
  EntrenchedArticleError,
  conflictsWith,
  rankOf,
  type Article,
  type ArticleConflict,
  type ArticleDraft,
  type Constitution,
  type StoredArticle,
} from './types.js';

export interface ConstitutionStoreDeps {
  storage: Storage;
  events: EventLog;
  clock: Clock;
  ids: Ids;
}

interface ArticleRow {
  id: string;
  ordinal: number;
  text: string;
  origin: string;
  kind: string;
  enforcement: string;
  check_id: string | null;
  remedy: string;
  enforced_by: string;
  entrenched: number;
  subject: string;
  stance: string;
  cites: string;
  added_version: number;
  created_at: number;
  repealed_at: number | null;
}

interface VersionRow {
  version: number;
  hash: string;
  at: number;
  change: string;
  article_id: string;
  author: string;
  event_id: string;
}

interface ProposalRow {
  id: string;
  body_hash: string;
  article: string;
  rationale: string;
  derived_from: string;
  created_at: number;
  status: string;
  decided_at: number | null;
}

export interface Proposal {
  id: string;
  article: Article;
  rationale: string;
  derivedFrom: string;
  createdAt: number;
  status: 'pending' | 'ratified' | 'dismissed';
}

export interface AmendmentRecord {
  version: number;
  hash: string;
  at: number;
  change: string;
  articleId: string;
  author: string;
  eventId: string;
}

export class ConstitutionStore {
  constructor(private readonly deps: ConstitutionStoreDeps) {}

  /* ───────────────────────────── ratification ──────────────────────────── */

  /**
   * Seed the founding charter if this install has never had one.
   *
   * Idempotent, and deliberately goes through the same event path a user
   * amendment takes — there is no privileged write. Returns the document
   * either way, so the composition root can call it unconditionally at boot.
   */
  ensureFounding(principal: string): Constitution {
    const existing = this.deps.storage.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM constitution_versions',
    );
    if ((existing?.n ?? 0) > 0) return this.current();

    const articles = FOUNDING_ARTICLES;
    this.deps.events.append({
      type: 'constitution.ratified',
      principal,
      trust: 'SYSTEM',
      payload: {
        version: FOUNDING_VERSION,
        hash: hashArticles(articles),
        articles: articles.map(toRecord),
        reason: 'founding charter',
      },
    });
    return this.current();
  }

  /* ──────────────────────────────── reads ──────────────────────────────── */

  current(): Constitution {
    const rows = this.deps.storage.all<ArticleRow>(
      'SELECT * FROM constitution_articles ORDER BY ordinal',
    );
    const latest = this.deps.storage.get<VersionRow>(
      'SELECT * FROM constitution_versions ORDER BY version DESC LIMIT 1',
    );
    return assemble(
      rows.map(fromRow),
      latest?.version ?? 0,
      latest?.at ?? 0,
    );
  }

  /**
   * The document as it stood at a moment.
   *
   * Replays the amendment log up to `ts` rather than reading the current
   * table, so "which rule was in force when it said that in March" has an
   * answer that does not depend on nothing having changed since.
   */
  at(ts: number): Constitution {
    const events = this.deps.events.read({ types: ['constitution.ratified', 'constitution.amended'] });
    const byId = new Map<string, StoredArticle>();
    let version = 0;
    let ratifiedAt = 0;
    let ordinal = 0;

    for (const e of events) {
      if (e.ts > ts) break;
      if (e.type === 'constitution.ratified') {
        const p = e.payload as {
          version: number;
          articles: Article[];
        };
        for (const a of p.articles) {
          ordinal += 1;
          byId.set(a.id, {
            ...ArticleSchema.parse(a),
            ordinal,
            addedVersion: p.version,
            createdAt: e.ts,
            repealedAt: null,
          });
        }
        version = p.version;
        ratifiedAt = e.ts;
      } else {
        const p = e.payload as {
          version: number;
          change: string;
          articleId: string;
          after: Article | null;
        };
        version = p.version;
        if (p.change === 'repealed') {
          const prev = byId.get(p.articleId);
          if (prev) byId.set(p.articleId, { ...prev, repealedAt: e.ts });
        } else if (p.after) {
          const prev = byId.get(p.articleId);
          ordinal = prev?.ordinal ?? ordinal + 1;
          byId.set(p.articleId, {
            ...ArticleSchema.parse(p.after),
            ordinal,
            addedVersion: prev?.addedVersion ?? p.version,
            createdAt: prev?.createdAt ?? e.ts,
            repealedAt: null,
          });
        }
      }
    }

    return assemble([...byId.values()].sort((a, b) => a.ordinal - b.ordinal), version, ratifiedAt);
  }

  history(limit = 100): AmendmentRecord[] {
    return this.deps.storage
      .all<VersionRow>('SELECT * FROM constitution_versions ORDER BY version DESC LIMIT ?', [limit])
      .map((r) => ({
        version: r.version,
        hash: r.hash,
        at: r.at,
        change: r.change,
        articleId: r.article_id,
        author: r.author,
        eventId: r.event_id,
      }));
  }

  article(id: string): StoredArticle | undefined {
    const row = this.deps.storage.get<ArticleRow>(
      'SELECT * FROM constitution_articles WHERE id = ?',
      [id],
    );
    return row ? fromRow(row) : undefined;
  }

  /* ─────────────────────────────── writes ──────────────────────────────── */

  /** Add or replace a user article. Requires a principal: the agent cannot call this. */
  adopt(principal: string, input: ArticleDraft): Constitution {
    const parsed = ArticleSchema.parse({
      ...input,
      id: input.id ?? `U-${this.deps.ids.ulid()}`,
      origin: input.origin === 'founding' ? 'founding' : 'user',
    });
    const existing = this.article(parsed.id);
    if (existing?.entrenched && !sameSubstance(existing, parsed)) {
      throw new EntrenchedArticleError(parsed.id, existing.cites);
    }
    this.appendAmendment(principal, existing ? 'edited' : 'added', parsed.id, existing ?? null, parsed);
    return this.current();
  }

  repeal(principal: string, articleId: string): Constitution {
    const existing = this.article(articleId);
    if (!existing) throw new Error(`no such article: ${articleId}`);
    if (existing.entrenched) throw new EntrenchedArticleError(articleId, existing.cites);
    if (existing.repealedAt !== null) return this.current();
    this.appendAmendment(principal, 'repealed', articleId, existing, null);
    return this.current();
  }

  /**
   * Replace the whole set of user articles in one amendment batch.
   *
   * `PUT /constitution` needs this, and doing it as N separate amendments
   * would produce N versions for one user action — making the history read
   * like a stutter instead of like an edit.
   */
  replaceUserArticles(principal: string, inputs: readonly ArticleDraft[]): Constitution {
    const keep = new Set<string>();
    for (const input of inputs) {
      const article = this.adoptQuiet(principal, input);
      keep.add(article.id);
    }
    for (const a of this.current().articles) {
      if (a.origin === 'user' && a.repealedAt === null && !keep.has(a.id)) {
        this.appendAmendment(principal, 'repealed', a.id, a, null);
      }
    }
    return this.current();
  }

  private adoptQuiet(principal: string, input: ArticleDraft): Article {
    const parsed = ArticleSchema.parse({
      ...input,
      id: input.id ?? `U-${this.deps.ids.ulid()}`,
      origin: 'user',
    });
    const existing = this.article(parsed.id);
    if (existing && sameSubstance(existing, parsed) && existing.repealedAt === null) return parsed;
    this.appendAmendment(principal, existing ? 'edited' : 'added', parsed.id, existing ?? null, parsed);
    return parsed;
  }

  /* ────────────────────────────── proposals ────────────────────────────── */

  /**
   * The agent's one move. Writes a proposal and changes nothing.
   *
   * Returns `null` when the same body has already been dismissed — §24.2's
   * rule about declined probes, applied to the document: no is an answer,
   * and re-asking it in new words is how an assistant becomes a nag.
   */
  propose(
    principal: string,
    input: ArticleDraft,
    rationale: string,
    derivedFrom = '',
  ): Proposal | null {
    const article = ArticleSchema.parse({
      ...input,
      id: input.id ?? `P-${this.deps.ids.ulid()}`,
      origin: 'proposed',
    });
    const hash = bodyHashOf(article.text);
    const prior = this.deps.storage.get<ProposalRow>(
      'SELECT * FROM constitution_proposals WHERE body_hash = ? AND status = ? LIMIT 1',
      [hash, 'dismissed'],
    );
    if (prior) return null;

    this.deps.events.append({
      type: 'constitution.proposed',
      principal,
      trust: 'DERIVED',
      payload: {
        proposalId: article.id,
        article: toRecord(article),
        rationale,
        derivedFrom,
      },
    });
    return {
      id: article.id,
      article,
      rationale,
      derivedFrom,
      createdAt: this.deps.clock.now(),
      status: 'pending',
    };
  }

  proposals(status: 'pending' | 'dismissed' | 'ratified' | 'all' = 'pending'): Proposal[] {
    const rows =
      status === 'all'
        ? this.deps.storage.all<ProposalRow>(
            'SELECT * FROM constitution_proposals ORDER BY created_at DESC',
          )
        : this.deps.storage.all<ProposalRow>(
            'SELECT * FROM constitution_proposals WHERE status = ? ORDER BY created_at DESC',
            [status],
          );
    return rows.map((r) => ({
      id: r.id,
      article: ArticleSchema.parse(JSON.parse(r.article) as unknown),
      rationale: r.rationale,
      derivedFrom: r.derived_from,
      createdAt: r.created_at,
      status: r.status as Proposal['status'],
    }));
  }

  dismiss(principal: string, proposalId: string, reason = 'dismissed by principal'): void {
    const row = this.deps.storage.get<ProposalRow>(
      'SELECT * FROM constitution_proposals WHERE id = ?',
      [proposalId],
    );
    if (!row) throw new Error(`no such proposal: ${proposalId}`);
    this.deps.events.append({
      type: 'constitution.dismissed',
      principal,
      trust: 'USER',
      payload: { proposalId, bodyHash: row.body_hash, reason },
    });
  }

  /** Ratify a pending proposal. Principal-authored by construction. */
  ratifyProposal(principal: string, proposalId: string): Constitution {
    const row = this.deps.storage.get<ProposalRow>(
      'SELECT * FROM constitution_proposals WHERE id = ? AND status = ?',
      [proposalId, 'pending'],
    );
    if (!row) throw new Error(`no pending proposal: ${proposalId}`);
    const article = ArticleSchema.parse(JSON.parse(row.article) as unknown);
    const adopted = this.adopt(principal, { ...article, id: `U-${this.deps.ids.ulid()}` });
    this.deps.storage.run(
      `UPDATE constitution_proposals SET status = 'ratified', decided_at = ? WHERE id = ?`,
      [this.deps.clock.now(), proposalId],
    );
    return adopted;
  }

  /* ─────────────────────────────── internals ───────────────────────────── */

  private appendAmendment(
    author: string,
    change: 'added' | 'edited' | 'repealed' | 'reordered',
    articleId: string,
    before: Article | null,
    after: Article | null,
  ): void {
    const next = this.nextVersion();
    // The hash must describe the document *after* the change, so it is
    // computed from a simulated apply rather than read back afterwards —
    // the projector runs inside the append transaction and we need the
    // value to put *in* the payload.
    const projected = projectOnto(this.current().articles, change, articleId, after);
    this.deps.events.append({
      type: 'constitution.amended',
      principal: author,
      trust: 'USER',
      payload: {
        version: next,
        hash: hashArticles(projected),
        change,
        articleId,
        before: before ? toRecord(before) : null,
        after: after ? toRecord(after) : null,
        author,
      },
    });
  }

  private nextVersion(): number {
    const row = this.deps.storage.get<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM constitution_versions',
    );
    return (row?.v ?? 0) + 1;
  }
}

/* ───────────────────────────── pure helpers ──────────────────────────────── */

function fromRow(r: ArticleRow): StoredArticle {
  return {
    ...ArticleSchema.parse({
      id: r.id,
      text: r.text,
      origin: r.origin,
      kind: r.kind,
      enforcement: r.enforcement,
      check: r.check_id,
      remedy: r.remedy,
      entrenched: r.entrenched === 1,
      subject: r.subject,
      stance: r.stance,
      cites: r.cites,
      enforcedBy: r.enforced_by,
    }),
    ordinal: r.ordinal,
    addedVersion: r.added_version,
    createdAt: r.created_at,
    repealedAt: r.repealed_at,
  };
}

function toRecord(a: Article): {
  id: string;
  text: string;
  origin: Article['origin'];
  kind: Article['kind'];
  enforcement: Article['enforcement'];
  check: string | null;
  remedy: Article['remedy'];
  enforcedBy: string;
  entrenched: boolean;
  subject: string;
  stance: Article['stance'];
  cites: string;
} {
  return {
    id: a.id,
    text: a.text,
    origin: a.origin,
    kind: a.kind,
    enforcement: a.enforcement,
    check: a.check,
    remedy: a.remedy,
    enforcedBy: a.enforcedBy,
    entrenched: a.entrenched,
    subject: a.subject,
    stance: a.stance,
    cites: a.cites,
  };
}

function sameSubstance(a: Article, b: Article): boolean {
  return canonicalJson(toRecord(a)) === canonicalJson(toRecord(b));
}

/** Hash of the live document, in precedence order. Travels in the sentinel. */
export function hashArticles(articles: readonly Article[]): string {
  const live = articles.filter((a) => !('repealedAt' in a) || (a as StoredArticle).repealedAt === null);
  const ordered = [...live].sort(compareForPrecedence);
  return hashing.sha256Hex(canonicalJson(ordered.map(toRecord))).slice(0, 16);
}

function compareForPrecedence(a: Article, b: Article): number {
  const byRank = rankOf(a) - rankOf(b);
  if (byRank !== 0) return byRank;
  const ao = (a as StoredArticle).ordinal ?? 0;
  const bo = (b as StoredArticle).ordinal ?? 0;
  if (ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}

function projectOnto(
  articles: readonly StoredArticle[],
  change: string,
  articleId: string,
  after: Article | null,
): StoredArticle[] {
  const next = articles.filter((a) => a.repealedAt === null);
  if (change === 'repealed') return next.filter((a) => a.id !== articleId);
  if (!after) return next;
  const base: StoredArticle = {
    ...after,
    ordinal: next.find((a) => a.id === articleId)?.ordinal ?? next.length + 1,
    addedVersion: 0,
    createdAt: 0,
    repealedAt: null,
  };
  const without = next.filter((a) => a.id !== articleId);
  return [...without, base];
}

/**
 * Build the document view: precedence order, live set, detected conflicts.
 *
 * Conflicts do not remove anything. The loser is marked `supersededBy` and
 * still renders, with a note — a default that silently vanishes is harder
 * for both the model and the user to reason about than one that is visibly
 * overridden (design note §2.2).
 */
function assemble(
  articles: readonly StoredArticle[],
  version: number,
  ratifiedAt: number,
): Constitution {
  const live = [...articles.filter((a) => a.repealedAt === null)].sort(compareForPrecedence);
  const conflicts: ArticleConflict[] = [];
  const annotated = live.map((a) => ({ ...a }));

  for (let i = 0; i < annotated.length; i += 1) {
    for (let j = i + 1; j < annotated.length; j += 1) {
      const winner = annotated[i];
      const loser = annotated[j];
      if (!winner || !loser) continue;
      if (!conflictsWith(winner, loser)) continue;
      if (rankOf(winner) === rankOf(loser)) {
        // Two articles from the same tier. The system does not arbitrate
        // between the user and themself: both render, and the conflict is
        // reported back to the caller who wrote them.
        conflicts.push({
          winner: winner.id,
          loser: loser.id,
          subject: winner.subject,
          reason: 'same precedence tier — both are rendered, you will need to pick one',
        });
        continue;
      }
      loser.supersededBy = winner.id;
      conflicts.push({
        winner: winner.id,
        loser: loser.id,
        subject: winner.subject,
        reason: `${winner.id} (${winner.origin}) outranks ${loser.id} (${loser.origin}) on '${winner.subject}'`,
      });
    }
  }

  return {
    version,
    hash: hashArticles(annotated),
    ratifiedAt,
    articles,
    live: annotated,
    conflicts,
  };
}
