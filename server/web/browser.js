/*
 * The browser surface.
 *
 * Plain DOM, no framework, no innerHTML anywhere — the `<name>` bug in the
 * Get Started flow was enough of a lesson. Everything rendered here comes
 * from the API, and the whole point of the page is that you can watch the
 * difference between what the planner is given and what you are given.
 */

const $ = (id) => document.getElementById(id);

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
};

const api = async (path, options) => {
  const res = await fetch(path, {
    ...options,
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
  });
  return res.json();
};

const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

const state = {
  catalogue: null,
  session: null,
  tab: 'pages',
  foreign: null,
  draft: {
    goal: 'Read the deployment guide and tell me how to roll back',
    kinds: new Set(['navigate', 'read', 'click']),
    maxSteps: 8,
    origins: '',
    carriesPrivateData: false,
    autonomy: 2,
  },
};

/* ------------------------------------------------------------------ plan */

function renderPlan() {
  const host = $('plan-form');
  clear(host);
  const d = state.draft;
  const committed = state.session?.active === true;

  host.append(
    field('Goal', el('input', {
      type: 'text', value: d.goal, disabled: committed,
      oninput: (e) => { d.goal = e.target.value; },
    })),
  );

  const kinds = el('div', { class: 'kinds' });
  for (const a of state.catalogue.actions) {
    const on = d.kinds.has(a.kind);
    const chip = el('label', { class: `kind${on ? ' on' : ''}${a.tier === 'effect' ? ' effect' : ''}` }, [
      el('input', {
        type: 'checkbox', checked: on, disabled: committed,
        onchange: () => { toggle(d.kinds, a.kind); renderPlan(); },
      }),
      el('span', { text: a.kind }),
      el('span', { class: 'tier', text: a.tier }),
    ]);
    kinds.append(chip);
  }
  host.append(field('Actions this plan may take', kinds, 'An action outside this set is refused, whatever the page says.'));

  host.append(field('Step budget', el('input', {
    type: 'number', min: 1, max: 100, value: d.maxSteps, disabled: committed,
    oninput: (e) => { d.maxSteps = Number(e.target.value); },
  })));

  const originSel = el('select', {
    disabled: committed,
    onchange: (e) => { d.origins = e.target.value; },
  }, [
    el('option', { value: '', text: 'Only where I start' }),
    ...state.catalogue.origins.map((o) => el('option', { value: o, text: o, selected: d.origins === o })),
    el('option', { value: state.catalogue.origins.join(','), text: 'All demo origins' }),
  ]);
  host.append(field('Origins it may reach', originSel));

  host.append(field('Autonomy', el('select', {
    disabled: committed,
    onchange: (e) => { d.autonomy = Number(e.target.value); },
  }, [0, 1, 2, 3, 4].map((n) => el('option', {
    value: n, selected: d.autonomy === n,
    text: `L${n} — ${['ask about everything', 'may observe', 'may interact', 'may interact freely', 'may cause effects'][n]}`,
  })))));

  const priv = el('label', { class: `kind${d.carriesPrivateData ? ' on effect' : ''}` }, [
    el('input', {
      type: 'checkbox', checked: d.carriesPrivateData, disabled: committed,
      onchange: () => { d.carriesPrivateData = !d.carriesPrivateData; renderPlan(); },
    }),
    el('span', { text: 'This session carries private data' }),
  ]);
  host.append(field('Rule of Two', priv,
    'Private data + untrusted content + an outbound effect is the combination that needs you.'));

  if (committed) {
    const p = state.session.plan;
    host.append(el('div', { class: 'seal' }, [
      el('div', { text: `Sealed at step 0. ${state.session.stepsTaken} of ${p.maxSteps} steps used.` }),
      el('code', { text: `seal ${p.seal}` }),
    ]));
    host.append(el('div', { style: 'margin-top:12px' }, [
      el('button', { class: 'btn ghost small', text: 'Discard and re-plan', onclick: reset }),
    ]));
  } else {
    host.append(el('button', {
      class: 'btn', style: 'margin-top:8px',
      text: 'Commit and seal', disabled: d.kinds.size === 0 || d.goal.trim() === '',
      onclick: commit,
    }));
  }
}

const toggle = (set, value) => { if (set.has(value)) set.delete(value); else set.add(value); };

function field(label, control, hint) {
  return el('div', { class: 'bfield' }, [
    el('label', { text: label }),
    control,
    hint ? el('p', { class: 'bsub', style: 'margin:5px 0 0', text: hint }) : null,
  ]);
}

async function commit() {
  const d = state.draft;
  const body = {
    plan: {
      goal: d.goal,
      allowedKinds: [...d.kinds],
      maxSteps: d.maxSteps,
      allowedOrigins: d.origins === '' ? [] : d.origins.split(','),
      carriesPrivateData: d.carriesPrivateData,
    },
    autonomy: d.autonomy,
  };
  const res = await api('/api/browser/plan', { method: 'POST', body: JSON.stringify(body) });
  if (res.error) return flash(res.error);
  await refresh();
  state.tab = 'pages';
  render();
}

async function reset() {
  await api('/api/browser/reset', { method: 'POST', body: '{}' });
  state.foreign = null;
  state.tab = 'pages';
  await refresh();
  render();
}

/* ------------------------------------------------------- the page column */

function renderTabs() {
  const host = $('btabs');
  clear(host);
  const tabs = [
    ['pages', 'Open a page'],
    ['view', 'What the planner sees'],
    ['text', 'What you see'],
  ];
  for (const [id, label] of tabs) {
    host.append(el('button', {
      class: `btab${state.tab === id ? ' on' : ''}`, text: label,
      // Awaited, not fired and forgotten: the first version called
      // loadForeign() without awaiting and rendered the empty state, which
      // then never updated. A promise you do not await is a bug you do not
      // see until you click the tab.
      onclick: async () => { state.tab = id; if (id === 'text') await loadForeign(); render(); },
    }));
  }
}

function renderMain() {
  const host = $('main-pane');
  clear(host);
  if (state.tab === 'pages') return renderPages(host);
  if (state.tab === 'view') return renderView(host);
  return renderForeign(host);
}

function renderPages(host) {
  host.append(el('p', { class: 'bsub', text: state.catalogue.driver.note }));
  for (const page of state.catalogue.pages) {
    host.append(el('button', {
      class: `page-row${page.hostile ? ' hostile' : ''}`,
      onclick: () => act({ kind: 'navigate', url: page.url }),
    }, [
      el('div', {}, [
        el('b', { text: page.title }),
        el('small', { text: page.note }),
        el('code', { text: page.url }),
      ]),
    ]));
  }
  if (state.session?.active !== true) {
    host.append(el('p', { class: 'empty', text: 'Commit a plan first. Reading a page before the plan is sealed is exactly the order this design forbids.' }));
  }
}

function renderView(host) {
  const view = state.session?.view;
  if (!view) return host.append(el('p', { class: 'empty', text: 'Nothing open yet.' }));

  host.append(el('h2', { text: view.title || '(untitled)' }));
  host.append(el('p', { class: 'bsub', text: `${view.url} · ${view.visibleTextChars} characters of body text, none of which the planner receives` }));

  const sig = view.signals;
  const sigs = el('div', { class: 'signals' }, [
    stat(view.affordances.length, 'affordances'),
    stat(sig.hiddenTextChars, 'hidden chars', sig.hiddenTextChars > 0),
    stat(sig.commentChars, 'comment chars', sig.commentChars > 0),
    stat(sig.credentialFields, 'credential fields', sig.credentialFields > 0),
    stat(sig.foreignOrigins.length, 'other origins', sig.foreignOrigins.length > 0),
  ]);
  host.append(sigs);
  if (sig.foreignOrigins.length > 0) {
    host.append(el('p', { class: 'bsub', text: `Also references: ${sig.foreignOrigins.join(', ')}` }));
  }

  const rows = view.affordances.map((a) => el('tr', { class: a.disabled ? 'off' : '' }, [
    el('td', { class: 'ref', text: a.ref }),
    el('td', { text: a.kind }),
    el('td', { class: 'lbl' }, [
      el('span', { text: a.label || '(no label)' }),
      a.truncated ? el('span', { class: 'tag', text: 'truncated' }) : null,
    ]),
    el('td', { class: a.sameOrigin ? '' : 'foreign', text: a.origin ?? '—' }),
    el('td', { text: [a.disabled && 'disabled', a.required && 'required', a.hasValue && 'has value'].filter(Boolean).join(', ') || '—' }),
  ]));

  host.append(el('table', { class: 'aff' }, [
    el('thead', {}, [el('tr', {}, ['ref', 'kind', 'label', 'origin', 'state'].map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows),
  ]));

  host.append(renderActionBar(view));
}

function stat(n, label, alarm) {
  return el('div', { class: `sig${alarm ? ' alarm' : ''}` }, [el('b', { text: String(n) }), el('span', { text: label })]);
}

function renderActionBar(view) {
  const allowed = new Set(state.session.plan.allowedKinds);
  const refs = view.affordances.filter((a) => !a.disabled).map((a) => a.ref);
  const kindSel = el('select', {}, [...allowed].map((k) => el('option', { value: k, text: k })));
  const refSel = el('select', {}, refs.map((r) => el('option', { value: r, text: r })));
  const value = el('input', { type: 'text', placeholder: 'text / option / url', size: 22 });
  // The approval control shows its own state. The first version hid the
  // checkbox (the chip style does) and never reflected it, so you could
  // not tell whether you had approved — an approval you cannot see is not
  // an approval.
  const approveBox = el('input', {
    type: 'checkbox',
    onchange: (e) => approve.classList.toggle('on', e.target.checked),
  });
  const approve = el('label', { class: 'kind effect', title: 'Required for an effect action while private data is held' }, [
    approveBox,
    el('span', { text: 'I approve this' }),
  ]);

  const run = () => {
    const kind = kindSel.value;
    const ref = refSel.value;
    const v = value.value;
    const approved = approveBox.checked;
    const action =
      kind === 'navigate' ? { kind, url: v || view.url }
      : kind === 'read' ? { kind }
      : kind === 'type' ? { kind, ref, text: v }
      : kind === 'select' ? { kind, ref, option: v }
      : kind === 'check' ? { kind, ref, checked: true }
      : kind === 'submit' ? { kind, formIndex: 0 }
      : { kind, ref };
    act(action, approved);
  };

  return el('div', { class: 'actbar' }, [
    kindSel, refSel, value, approve,
    el('button', { class: 'btn small', text: 'Run', onclick: run }),
  ]);
}

function renderForeign(host) {
  const f = state.foreign;
  if (!f) return host.append(el('p', { class: 'empty', text: 'Nothing open yet.' }));
  if (f.error) return host.append(el('p', { class: 'empty', text: f.error }));
  host.append(el('div', { class: 'foreign-head' }, [
    el('strong', { text: `trust: ${f.trust}` }),
    el('span', { text: ' — ' + f.warning }),
  ]));
  host.append(el('pre', { class: 'foreign-text', text: f.text }));
}

/* -------------------------------------------------------------- the log */

function renderLog() {
  const host = $('log-pane');
  clear(host);
  const log = state.session?.log ?? [];
  if (log.length === 0) {
    return host.append(el('p', { class: 'empty', text: 'Nothing has happened yet.' }));
  }
  for (const e of log) {
    host.append(el('div', { class: `entry ${e.outcome}` }, [
      el('div', { class: 'dotcol' }, [el('span', { class: 'bul' })]),
      el('div', {}, [
        el('b', { text: e.kind }),
        e.code ? el('span', { class: 'code', text: ' ' + e.code }) : null,
        el('p', { text: e.detail }),
      ]),
    ]));
  }
}

function renderHud() {
  const host = $('hud');
  clear(host);
  const s = state.session;
  const chips = s?.active
    ? [`L${s.autonomy}`, `${s.stepsTaken}/${s.plan.maxSteps} steps`, `${s.visited.length} page(s)`]
    : ['no plan committed'];
  for (const c of chips) host.append(el('span', { class: 'hud-chip', text: c }));
}

/* ------------------------------------------------------------- plumbing */

async function act(action, approved = false) {
  if (state.session?.active !== true) return flash('Commit a plan first.');
  const res = await api('/api/browser/act', { method: 'POST', body: JSON.stringify({ action, approved }) });
  if (res.error) return flash(res.error);
  if (res.ok === false) flash(res.refused.reason);
  await refresh();
  if (res.ok !== false && state.tab === 'pages') state.tab = 'view';
  if (state.tab === 'text') await loadForeign();
  render();
}

async function loadForeign() {
  state.foreign = await api('/api/browser/page');
}

async function refresh() {
  state.session = await api('/api/browser');
}

function flash(message) {
  const note = el('div', {
    class: 'note warn',
    text: message,
    style: 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);max-width:620px;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.12)',
  });
  document.body.append(note);
  setTimeout(() => note.remove(), 6000);
}

function render() {
  renderPlan();
  renderTabs();
  renderMain();
  renderLog();
  renderHud();
}

(async () => {
  state.catalogue = await api('/api/browser/catalogue');
  await refresh();
  if (state.session?.active) state.tab = 'view';
  render();
})();

$('reset').addEventListener('click', reset);
