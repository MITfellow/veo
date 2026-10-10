/*
 * The outbox, for a person.
 *
 * Read-only by design. The single question this page answers is "is there
 * anything the agent did, or might have done, that nobody can account
 * for?" — and if the answer is yes, it must be impossible to miss.
 */

const $ = (id) => document.getElementById(id);

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
};

const ago = (ts) => {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
};

const LABEL = {
  intended: 'intended',
  committed: 'committed',
  compensated: 'undone',
  needs_attention: 'needs you',
  absent: 'never ran',
};

function tally(data) {
  const tiles = [
    { n: data.needsAttention, label: 'need a decision from you', warn: data.needsAttention > 0 },
    { n: data.pending, label: 'intended, not yet settled', warn: false },
    { n: data.committed, label: 'confirmed done', warn: false },
  ];
  $('fx-tally').replaceChildren(
    ...tiles.map((t) =>
      el('div', { class: `fx-tile${t.warn ? ' warn' : ''}` }, [
        el('b', { text: String(t.n) }),
        el('span', { text: t.label }),
      ]),
    ),
  );
}

function list(effects) {
  if (effects.length === 0) {
    $('fx-list').replaceChildren(
      el('p', { class: 'fx-empty', text: 'No external effects yet. Nothing has been attempted outside this machine.' }),
    );
    return;
  }
  $('fx-list').replaceChildren(
    ...effects.map((e) =>
      el('div', { class: 'fx-row' }, [
        el('span', { class: `fx-state ${e.status}`, text: LABEL[e.status] ?? e.status }),
        el('span', { text: e.tool }),
        el('span', {}, [
          el('div', { text: e.summary || '(no description recorded)' }),
          e.detail ? el('div', { class: 'fx-detail', text: e.detail }) : null,
          e.remoteRef ? el('div', { class: 'fx-detail', text: `provider reference ${e.remoteRef}` }) : null,
        ]),
        el('span', { class: 'fx-detail', text: ago(e.intendedAt) }),
      ]),
    ),
  );
}

(async function boot() {
  const data = await (await fetch('/api/effects')).json();
  const waiting = data.needsAttention;

  $('fx-heading').textContent =
    waiting > 0
      ? `${waiting} thing${waiting === 1 ? '' : 's'} nobody can account for`
      : 'Everything is accounted for';
  $('fx-lede').textContent = data.explain;

  tally(data);
  list(data.effects);
})();
