import { useCallback, useEffect, useState } from 'react';
import {
  agent,
  AgentUnavailableError,
  type Compliance,
  type ConstitutionArticle,
  type ConstitutionDoc,
} from '../lib/agent';

/**
 * The constitution: the terms the agent works under, and the record of
 * whether it kept them.
 *
 * ARISH §25 asks for "a short, user-editable behavioural contract that
 * outranks learned behavior". This screen is the contract made legible, and
 * three things about it are deliberate.
 *
 * - **Every article says how it is kept.** `Enforced in code` means another
 *   module physically prevents it. `Checked` means the output is screened
 *   after generation by a named check, and that check's blind spots are
 *   printed next to it. `Stated` means it is told to the model and nothing
 *   more. Presenting those three as the same kind of promise would be the
 *   same lie as an uncalibrated confidence number — so they are labelled
 *   and coloured differently, and the honest one is the plainest.
 * - **Four articles cannot be deleted, and say why.** They describe
 *   behaviour the harness enforces whether the document mentions it or not;
 *   removing them would not change the agent, only make the page wrong.
 * - **Your articles sit above the agent's.** When one of yours conflicts
 *   with one of its own, its own is struck through and marked overridden
 *   rather than quietly dropped.
 */

const ENFORCEMENT_LABEL: Record<ConstitutionArticle['enforcement'], string> = {
  structural: 'Enforced in code',
  checked: 'Checked after every answer',
  advisory: 'Stated, not checked',
};

type Tab = 'articles' | 'compliance' | 'history';

export default function ConstitutionPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('articles');
  const [doc, setDoc] = useState<ConstitutionDoc | null>(null);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [history, setHistory] = useState<{ version: number; at: number; change: string; articleId: string }[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [current, counts, log] = await Promise.all([
      agent.constitution(),
      agent.compliance(),
      agent.constitutionHistory(),
    ]);
    return { current, counts, log };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    setDoc(result.current);
    setCompliance(result.counts);
    setHistory(result.log.history);
    setError(null);
  }, []);

  const fail = useCallback((caught: unknown) => {
    setError(
      caught instanceof AgentUnavailableError
        ? caught.message
        : caught instanceof Error
          ? caught.message
          : 'could not read the constitution',
    );
  }, []);

  const refresh = useCallback(() => load().then(apply, fail), [load, apply, fail]);

  useEffect(() => {
    let live = true;
    load().then(
      (result) => {
        if (live) apply(result);
      },
      (caught: unknown) => {
        if (live) fail(caught);
      },
    );
    return () => {
      live = false;
    };
  }, [load, apply, fail]);

  const act = async (what: () => Promise<unknown>, notice: string) => {
    try {
      await what();
      onNotice(notice);
      await refresh();
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : 'that did not work');
    }
  };

  if (error !== null) {
    return (
      <>
        <div className="panel-label" style={{ marginTop: 6 }}>
          The agent&apos;s constitution
        </div>
        <div className="con-empty">{error}</div>
      </>
    );
  }

  const mine = doc?.articles.filter((a) => a.origin === 'user') ?? [];
  const theirs = doc?.articles.filter((a) => a.origin === 'founding') ?? [];

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        The agent&apos;s constitution
      </div>

      <div className="con-head">
        <div>
          Version {doc?.version ?? '—'} · {doc?.articles.length ?? 0} articles
        </div>
        <div className="con-hash">sha {doc?.hash ?? '—'}</div>
      </div>
      <div className="con-note">
        Every answer is generated with this document in front of the model, and no answer can be
        generated without it. Your articles outrank the agent&apos;s own.
      </div>

      <div className="con-tabs" role="tablist" aria-label="Constitution view">
        {(
          [
            { id: 'articles' as const, label: 'Articles' },
            { id: 'compliance' as const, label: 'Kept?' },
            { id: 'history' as const, label: 'Changes' },
          ]
        ).map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`con-tab${tab === item.id ? ' is-on' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'articles' && (
        <>
          <div className="con-section">Your articles</div>
          {mine.length === 0 && (
            <div className="con-empty">
              You have not written any yet. Anything you add here outranks everything the agent has
              learned or inferred about you.
            </div>
          )}
          <div className="con-list">
            {mine.map((article) => (
              <Article
                key={article.id}
                article={article}
                onRepeal={() =>
                  act(() => agent.repealArticle(article.id), `${article.id} repealed`)
                }
              />
            ))}
          </div>

          <div className="con-add">
            <input
              className="con-input"
              value={draft}
              placeholder="Add an article — “always tell me when you disagree”"
              aria-label="New article"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              className="con-btn"
              disabled={draft.trim() === ''}
              onClick={() =>
                act(async () => {
                  await agent.addArticle(draft.trim());
                  setDraft('');
                }, 'article added')
              }
            >
              Add
            </button>
          </div>

          {(doc?.proposals.length ?? 0) > 0 && (
            <>
              <div className="con-section">The agent has suggested</div>
              {doc?.proposals.map((proposal) => (
                <div key={proposal.id} className="con-proposal">
                  <div className="con-text">{proposal.article.text}</div>
                  <div className="con-why">{proposal.rationale}</div>
                  <div className="con-actions">
                    <button
                      className="con-btn"
                      onClick={() => act(() => agent.ratifyProposal(proposal.id), 'adopted')}
                    >
                      Adopt
                    </button>
                    <button
                      className="con-btn"
                      onClick={() => act(() => agent.dismissProposal(proposal.id), 'dismissed')}
                    >
                      No
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="con-section">The agent&apos;s own charter</div>
          <div className="con-list">
            {theirs.map((article) => (
              <Article
                key={article.id}
                article={article}
                onRepeal={
                  article.entrenched
                    ? undefined
                    : () => act(() => agent.repealArticle(article.id), `${article.id} repealed`)
                }
              />
            ))}
          </div>
        </>
      )}

      {tab === 'compliance' && (
        <>
          <div className="con-note">
            Counted from the checks that run on every answer. “Couldn&apos;t tell” is shown as its
            own number rather than counted as a pass — a compliance figure that quietly swallows
            the cases it cannot see goes up as the system gets worse.
          </div>
          <div className="con-list">
            {(compliance?.articles ?? []).map((row) => (
              <div key={row.articleId} className="con-row">
                <div className="con-row-head">
                  <span className="con-id">{row.articleId}</span>
                  <span className="con-check">{row.check}</span>
                </div>
                <div className="con-counts">
                  <span className="con-ok">{row.upheld} kept</span>
                  <span className={row.violated > 0 ? 'con-bad' : 'con-dim'}>
                    {row.violated} broken
                  </span>
                  <span className="con-dim">{row.unverifiable} couldn&apos;t tell</span>
                </div>
              </div>
            ))}
            {(compliance?.articles.length ?? 0) === 0 && (
              <div className="con-empty">Nothing judged yet — talk to the agent first.</div>
            )}
          </div>
          {(compliance?.recentViolations.length ?? 0) > 0 && (
            <>
              <div className="con-section">Recently broken</div>
              {compliance?.recentViolations.map((violation, index) => (
                <div key={index} className="con-violation">
                  <span className="con-id">{violation.article_id}</span> {violation.detail}
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tab === 'history' && (
        <div className="con-list">
          {history.map((entry) => (
            <div key={entry.version} className="con-row">
              <div className="con-row-head">
                <span className="con-id">v{entry.version}</span>
                <span className="con-check">
                  {entry.change}
                  {entry.articleId === '' ? '' : ` ${entry.articleId}`}
                </span>
              </div>
              <div className="con-why">{new Date(entry.at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Article({
  article,
  onRepeal,
}: {
  article: ConstitutionArticle;
  onRepeal?: () => void;
}) {
  const overridden = article.supersededBy !== null;
  return (
    <div className={`con-row${overridden ? ' is-overridden' : ''}`}>
      <div className="con-row-head">
        <span className="con-id">{article.id}</span>
        <span className={`con-mode con-mode-${article.enforcement}`}>
          {ENFORCEMENT_LABEL[article.enforcement]}
        </span>
        {article.entrenched && <span className="con-lock">cannot be removed</span>}
      </div>
      <div className="con-text">{article.text}</div>
      {article.enforcement === 'structural' && article.enforcedBy !== '' && (
        <div className="con-why">Enforced by {article.enforcedBy}</div>
      )}
      {article.enforcement === 'checked' && article.checkMisses !== null && (
        <div className="con-why">
          Checked by “{article.check}”. It does not catch: {article.checkMisses}.
        </div>
      )}
      {overridden && (
        <div className="con-why">Overridden by your article {article.supersededBy}.</div>
      )}
      {article.cites !== '' && <div className="con-cites">{article.cites}</div>}
      {onRepeal !== undefined && (
        <div className="con-actions">
          <button className="con-btn" onClick={onRepeal}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
