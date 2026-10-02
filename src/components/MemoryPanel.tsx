import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  agent,
  AgentUnavailableError,
  type MemoryCounts,
  type MemoryExplanation,
  type MemoryFact,
} from '../lib/agent';

/**
 * What the agent knows about you — and the controls to change or destroy it.
 *
 * ARISH §22.8 is the only part of the memory spec marked *mandatory*, and
 * its reasoning is the reason this screen exists at all: "a person only lets
 * an agent this deep into their life if they can see and rip out what it
 * knows."
 *
 * Three deliberate choices:
 *
 * - **Every row shows its epistemics.** Where it came from, how sure, how
 *   many times observed. A memory presented as a bare sentence invites the
 *   reader to treat a 42%-confidence guess exactly like something they said
 *   out loud, which is how people end up arguing with a machine about their
 *   own life.
 * - **Quarantined memories are shown, not hidden.** They never reach a
 *   conversation, but "here is what a web page tried to make me believe
 *   about you" is precisely the thing someone wants to see.
 * - **Forget is immediate and says it is permanent.** No trash can, no
 *   thirty-day grace period. The content is shredded with its key; a UI
 *   that implied otherwise would be lying.
 */

const BASIS_LABEL: Record<MemoryFact['basis'], string> = {
  asserted_by_user: 'you told me',
  observed: 'observed',
  inferred: 'inferred',
  imported: 'imported',
};

type Tab = 'active' | 'pinned' | 'quarantined' | 'all';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'active', label: 'Known' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'quarantined', label: 'Quarantined' },
  { id: 'all', label: 'Everything' },
];

export default function MemoryPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>('active');
  const [query, setQuery] = useState('');
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [counts, setCounts] = useState<MemoryCounts | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  /** How much of §22's identity budget the card is using. */
  const [identityBudget, setIdentityBudget] = useState<{ tokens: number; max: number } | null>(
    null,
  );
  const [digest, setDigest] = useState<string | null>(null);
  const [open, setOpen] = useState<MemoryExplanation | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Fetching and applying are kept apart deliberately: the effect below
   * subscribes to a promise rather than calling a function that sets state
   * synchronously, which is both the honest description of what happens and
   * what keeps the React compiler able to optimise this component.
   */
  const load = useCallback(async () => {
    const filter =
      tab === 'pinned'
        ? { pinned: true, status: 'all', q: query }
        : tab === 'quarantined'
          ? { status: 'quarantined', q: query }
          : tab === 'all'
            ? { status: 'all', q: query }
            : { status: 'active', q: query };
    const [list, extras, card] = await Promise.all([
      agent.memory(filter),
      agent.memoryDigest(),
      agent.identityCard(),
    ]);
    return { list, extras, card };
  }, [tab, query]);

  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    setFacts(result.list.facts);
    setCounts(result.list.counts);
    setIdentity(result.extras.identity?.text ?? null);
    setIdentityBudget(
      result.card.card === null
        ? null
        : { tokens: result.card.card.tokens, max: result.card.maxTokens },
    );
    setDigest(result.extras.entries[0]?.text ?? null);
    setError(null);
    setLoading(false);
  }, []);

  const fail = useCallback((caught: unknown) => {
    setError(
      caught instanceof AgentUnavailableError
        ? caught.message
        : caught instanceof Error
          ? caught.message
          : 'could not read the memory store',
    );
    setLoading(false);
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
    // A tab switched twice quickly must not let the slower response win.
    return () => {
      live = false;
    };
  }, [load, apply, fail]);

  const total = useMemo(
    () => (counts === null ? 0 : counts.active + counts.disputed),
    [counts],
  );

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
          What the agent knows
        </div>
        <div className="mem-empty">{error}</div>
      </>
    );
  }

  return (
    <>
      <div className="panel-label" style={{ marginTop: 6 }}>
        What the agent knows about you
      </div>

      {identity !== null && (
        <div className="mem-identity">
          <div className="mem-identity-head">
            How it would introduce you in a new conversation
            {identityBudget !== null ? (
              <span className="mem-identity-budget">
                {' '}
                · {identityBudget.tokens} of {identityBudget.max} tokens
              </span>
            ) : null}
          </div>
          {identity.split('\n').map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}

      {digest !== null && (
        <div className="mem-digest">
          {digest.split('\n').map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}

      <div className="mem-tabs" role="tablist" aria-label="Memory filter">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`mem-tab${tab === item.id ? ' is-on' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {counts !== null && item.id === 'quarantined' && counts.quarantined > 0 && (
              <span className="mem-badge">{counts.quarantined}</span>
            )}
            {counts !== null && item.id === 'pinned' && counts.pinned > 0 && (
              <span className="mem-badge">{counts.pinned}</span>
            )}
          </button>
        ))}
      </div>

      <input
        className="mem-search"
        type="search"
        value={query}
        placeholder="Search what it remembers…"
        aria-label="Search memories"
        onChange={(event) => setQuery(event.target.value)}
      />

      {tab === 'quarantined' && (
        <div className="mem-note">
          These came from untrusted content — a web page or a tool, not from you. They are kept
          only so you can see what was claimed. The agent never uses them.
        </div>
      )}

      {loading ? (
        <div className="mem-empty">Reading…</div>
      ) : facts.length === 0 ? (
        <div className="mem-empty">
          {query === ''
            ? 'Nothing here yet. The agent learns from what you tell it, and shows you all of it.'
            : `Nothing matching “${query}”.`}
        </div>
      ) : (
        <ul className="mem-list">
          {facts.map((fact) => (
            <li key={fact.id} className={`mem-row is-${fact.status}`}>
              <div className="mem-main">
                <div className="mem-text">
                  {fact.text}
                  {fact.pinned && <span className="mem-pin" title="Always in context">PINNED</span>}
                </div>
                <div className="mem-meta">
                  <span>{BASIS_LABEL[fact.basis]}</span>
                  <span>·</span>
                  <span>{Math.round(fact.confidence * 100)}% sure</span>
                  <span>·</span>
                  <span>
                    {fact.sourceCount} source{fact.sourceCount === 1 ? '' : 's'}
                  </span>
                  {fact.observationCount > 1 && <span>· seen {fact.observationCount}×</span>}
                  {fact.status === 'disputed' && <span className="mem-flag">· conflicting</span>}
                  {fact.status === 'quarantined' && <span className="mem-flag">· quarantined</span>}
                  {fact.status === 'retired' && <span className="mem-flag">· forgotten</span>}
                </div>
              </div>

              <div className="mem-actions">
                <button
                  className="mem-btn"
                  onClick={async () => {
                    setOpen(open?.fact.id === fact.id ? null : await agent.explainMemory(fact.id));
                  }}
                >
                  Why?
                </button>
                {fact.status !== 'retired' && (
                  <>
                    <button
                      className="mem-btn"
                      onClick={() =>
                        void act(
                          () => agent.pinMemory(fact.id, !fact.pinned),
                          fact.pinned ? 'Unpinned.' : 'Pinned — it will be in every conversation.',
                        )
                      }
                    >
                      {fact.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button
                      className="mem-btn"
                      onClick={() => {
                        setEditing(editing === fact.id ? null : fact.id);
                        setDraft('');
                      }}
                    >
                      Correct
                    </button>
                    <button
                      className="mem-btn is-danger"
                      onClick={() =>
                        void act(() => agent.forgetMemory(fact.id), 'Forgotten, permanently.')
                      }
                    >
                      Forget
                    </button>
                  </>
                )}
              </div>

              {editing === fact.id && (
                <form
                  className="mem-correct"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.trim() === '') return;
                    setEditing(null);
                    void act(
                      () => agent.correctMemory(fact.id, draft.trim()),
                      'Corrected — the old version stays on record as a mistake.',
                    );
                  }}
                >
                  <input
                    autoFocus
                    value={draft}
                    aria-label="What is actually true"
                    placeholder="What is actually true?"
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <button className="btn" type="submit">
                    Save
                  </button>
                </form>
              )}

              {open?.fact.id === fact.id && (
                <div className="mem-why">
                  {open.explanation.map((line, index) => (
                    <div key={index}>{line}</div>
                  ))}
                  {open.history.length > 1 && (
                    <div className="mem-history">
                      <div className="mem-history-head">Earlier versions of this belief</div>
                      {open.history.map((version, index) => (
                        <div key={index}>
                          {new Date(version.recordedAt).toLocaleDateString()} — {version.text}{' '}
                          <span className="muted">({version.status})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {counts !== null && (
        <div className="mem-footer">
          <span className="muted">
            {total} in use{counts.quarantined > 0 && `, ${counts.quarantined} quarantined`}
            {counts.retired > 0 && `, ${counts.retired} forgotten`}
          </span>
          <div className="mem-footer-actions">
            <button
              className="btn"
              onClick={async () => {
                const data = await agent.exportMemory();
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                  type: 'application/json',
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'veo-memory.json';
                link.click();
                URL.revokeObjectURL(url);
                onNotice('Exported everything it knows, including what it refused to learn.');
              }}
            >
              Export
            </button>
            <button
              className="btn is-danger"
              onClick={() => {
                // Deliberately a confirm, and deliberately blunt about what
                // it does: this is the one irreversible button in the app.
                const ok = window.confirm(
                  'Permanently destroy everything the agent knows about you?\n\n' +
                    'This shreds the encryption keys. It cannot be undone, and the agent will ' +
                    'start again from knowing nothing.',
                );
                if (!ok) return;
                void act(
                  () => agent.forgetEverything('self'),
                  'Everything about you has been destroyed.',
                );
              }}
            >
              Forget everything
            </button>
          </div>
        </div>
      )}
    </>
  );
}
