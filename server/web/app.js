/*
 * The Get Started flow.
 *
 * Plain DOM, no framework. Four steps, rendered from the server's JSON so
 * the page never states anything the platform has not told it — in
 * particular it never says a connector works, or a model is attached,
 * unless the API said so.
 */

const $ = (id) => document.getElementById(id);
/**
 * There is deliberately no `html:` option here.
 *
 * It existed, it was used with a server-supplied string, and it silently
 * swallowed "<name>" out of a help message. Text is text.
 */
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false) node.setAttribute(k, v);
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

/**
 * Build the icon with real DOM nodes rather than an HTML string.
 *
 * Nothing here is user input today, but `innerHTML` with server-supplied
 * values is a habit that is wrong exactly once. See the `<name>` bug below.
 */
const NS = 'http://www.w3.org/2000/svg';
const svg = (path, color) => {
  const root = document.createElementNS(NS, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('stroke', color);
  const d = document.createElementNS(NS, 'path');
  d.setAttribute('d', path);
  root.append(d);
  const box = el('span', { class: 'icon', style: `background:${color}14` });
  box.append(root);
  return box;
};

/** Bold lead-in plus plain text, without touching innerHTML. */
const lead = (bold, rest) => el('div', {}, [el('strong', { text: bold }), rest ? el('span', { text: ' ' + rest }) : null]);

/**
 * Show the bottom fade only while there is genuinely more to scroll to.
 * Re-checked on scroll and on resize, because "is this list cut off" is a
 * question about the viewport, not about the data.
 */
function trackOverflow(wrap) {
  const list = wrap.querySelector('.list');
  if (!list) return;
  const update = () => {
    const more = list.scrollHeight - list.clientHeight - list.scrollTop > 8;
    wrap.classList.toggle('has-more', more);
  };
  list.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  requestAnimationFrame(update);
}

/** A scrollable list plus its affordance, as one node. */
const listPane = (children) => {
  const wrap = el('div', { class: 'list-wrap' }, [el('div', { class: 'list' }, children)]);
  queueMicrotask(() => trackOverflow(wrap));
  return wrap;
};

const state = { step: 0, status: null, connectors: null, model: null, draft: { provider: 'none', name: '', apiKeyRef: '', baseUrl: '' } };

/* ── step 1: about the platform ─────────────────────────────────────────── */

function renderAbout() {
  const s = state.status;
  $('eyebrow').textContent = 'About the platform';
  $('heading').textContent = 'A personal agent that is yours';
  $('lede').textContent =
    'ARISH runs on this machine. It keeps an append-only record of everything it learns, encrypts what matters, and refuses to let anything it read on the internet tell it what to do.';

  $('left-extra').replaceChildren(
    el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [el('b', { text: String(s.events) }), el('span', { text: 'events' })]),
      el('div', { class: 'stat' }, [el('b', { text: String(s.jobs) }), el('span', { text: 'cognitive jobs' })]),
      el('div', { class: 'stat' }, [el('b', { text: s.degradation }), el('span', { text: 'degradation' })]),
      el('div', { class: 'stat' }, [el('b', { text: 'L' + s.autonomy }), el('span', { text: 'autonomy' })]),
    ]),
  );

  $('pane-right').replaceChildren(
    el('div', { class: 'card', style: 'display:block;padding:4px 18px' },
      s.principles.map((p) =>
        el('div', { class: 'principle' }, [el('h3', { text: p.title }), el('p', { text: p.body })]),
      ),
    ),
  );
}

/* ── step 2: connectors ─────────────────────────────────────────────────── */

function connectorCard(c) {
  const check = el('input', {
    type: 'checkbox',
    class: 'check',
    'aria-label': `Add ${c.name}`,
    ...(c.enabled ? { checked: 'checked' } : {}),
    onchange: async (e) => {
      const result = await api(`/api/connectors/${c.id}`, {
        method: 'POST',
        body: JSON.stringify({ enabled: e.target.checked }),
      });
      state.connectors = await api('/api/connectors');
      renderConnectors();
      if (result.note) flash(result.note);
    },
  });

  return el('div', { class: `card${c.enabled ? ' is-on' : ''}${c.status === 'blocked' ? ' is-blocked' : ''}` }, [
    svg(c.icon, c.accent),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'card-title' }, [
        el('span', { text: c.name }),
        c.status === 'blocked'
          ? el('span', { class: 'tag blocked', text: c.requires === 'oauth' ? 'needs sign-in + network' : 'needs network' })
          : el('span', { class: 'tag local', text: 'ready' }),
        el('span', { class: 'tag trust', text: c.yieldsTrust }),
      ]),
      el('div', { class: 'card-sub', text: c.status === 'blocked' ? c.blockedBecause : c.blurb }),
    ]),
    check,
  ]);
}

function renderConnectors() {
  const { connectors, counts, risk } = state.connectors;
  $('eyebrow').textContent = 'Step 2 of 4 — Connectors';
  $('heading').textContent = 'Add connectors to your agent';
  $('lede').textContent =
    'A connector is somewhere the agent can look, or something it can change. Each one says what trust level its data carries — anything marked FOREIGN is quarantined and can never issue an instruction.';

  const left = [
    el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [el('b', { text: String(counts.enabled) }), el('span', { text: 'added' })]),
      el('div', { class: 'stat' }, [el('b', { text: String(counts.available) }), el('span', { text: 'ready' })]),
      el('div', { class: 'stat' }, [el('b', { text: String(counts.blocked) }), el('span', { text: 'blocked' })]),
    ]),
    el('div', { class: 'note' }, [
      lead('Blocked connectors are shown on purpose.',
        'This build makes no network calls at all, so anything needing OAuth or the internet cannot work yet. You can still choose it — the choice is remembered and it will be first to light up.'),
    ]),
  ];
  if (risk?.risky) left.push(el('div', { class: 'note warn', text: risk.why }));
  $('left-extra').replaceChildren(...left);

  const local = connectors.filter((c) => c.family === 'local');
  const saas = connectors.filter((c) => c.family === 'saas');

  $('pane-right').replaceChildren(
    listPane([
      el('p', { class: 'eyebrow', style: 'margin:4px 0 2px', text: 'On this machine' }),
      ...local.map(connectorCard),
      el('p', { class: 'eyebrow', style: 'margin:14px 0 2px', text: 'Accounts and the web' }),
      ...saas.map(connectorCard),
    ]),
  );
}

/* ── step 3: the model ──────────────────────────────────────────────────── */

function renderModel() {
  const m = state.model;
  $('eyebrow').textContent = 'Step 3 of 4 — Model';
  $('heading').textContent = 'Attach a language model';
  $('lede').textContent =
    'Every model-shaped function in ARISH is a job with two implementations: a deterministic baseline that works right now, and a model strategy that is already written, tested, and waiting for a provider.';

  const field = (label, hint, input) =>
    el('div', { class: 'field' }, [
      el('label', {}, [el('span', { text: label }), hint ? el('span', { class: 'hint', text: hint }) : null]),
      input,
    ]);

  const update = async (key, value) => {
    state.draft[key] = value;
    const check = await api('/api/model/check', { method: 'POST', body: JSON.stringify(state.draft) });
    renderModelSide(check);
  };

  const providerSelect = el('select', {
    onchange: (e) => update('provider', e.target.value),
  }, ['none', 'openai', 'anthropic', 'ollama', 'openai-compatible'].map((p) =>
    el('option', { value: p, text: p === 'none' ? 'None — use baselines (current)' : p, ...(state.draft.provider === p ? { selected: 'selected' } : {}) })));

  $('left-extra').replaceChildren(
    el('div', {}, [
      field('Provider', '', providerSelect),
      field('Model name', 'e.g. a chat model id',
        el('input', { type: 'text', value: state.draft.name, placeholder: 'model-name', oninput: (e) => update('name', e.target.value) })),
      field('API key', 'a secret:// reference, never the key itself',
        el('input', { type: 'text', value: state.draft.apiKeyRef, placeholder: 'secret://openai-key/1', oninput: (e) => update('apiKeyRef', e.target.value) })),
      field('Base URL', 'self-hosted and compatible endpoints',
        el('input', { type: 'text', value: state.draft.baseUrl, placeholder: 'http://127.0.0.1:11434', oninput: (e) => update('baseUrl', e.target.value) })),
      el('div', { class: 'note', id: 'model-check', text: m.statement }),
    ]),
  );

  renderJobs();
}

function renderModelSide(check) {
  const box = $('model-check');
  if (!box) return;
  box.className = check.valid && state.draft.provider !== 'none' ? 'note' : 'note warn';
  // textContent, not innerHTML: the requirement strings contain literal
  // angle brackets ("arish vault set <name>") and innerHTML silently ate
  // them as a tag, which is how this bug was found.
  const headline = state.draft.provider === 'none'
    ? lead('No model configured — L1.', 'Every job below runs its baseline. This is the shipped state, not a broken one.')
    : check.valid
      ? lead('These settings would parse.', 'They still would not run.')
      : lead('Still needed:', check.missing.join('; '));

  box.replaceChildren(
    headline,
    ...(state.draft.provider === 'none' ? [] : check.blockers.map((b) => el('p', { style: 'margin:6px 0 0', text: b }))),
    check.envExample ? el('pre', { class: 'env', text: check.envExample }) : null,
  );
}

function renderJobs() {
  $('pane-right').replaceChildren(
    listPane([
      el('p', { class: 'eyebrow', style: 'margin:4px 0 2px', text: `${state.model.jobCount} cognitive jobs` }),
      ...state.model.jobs.map((j) =>
        el('div', { class: 'job' }, [
          el('div', {}, [
            el('code', { text: j.name }),
            el('p', { text: j.baselineQuality }),
          ]),
          el('span', { class: `pill${j.strategy === 'model' ? ' model' : ''}`, text: j.strategy }),
        ]),
      ),
    ]),
  );
}

/* ── step 4: done ───────────────────────────────────────────────────────── */

function renderDone() {
  const added = state.connectors.connectors.filter((c) => c.enabled);
  const live = added.filter((c) => c.status === 'available');
  $('eyebrow').textContent = 'Step 4 of 4 — Ready';
  $('heading').textContent = added.length > 0 ? 'You are set up' : 'Ready when you are';
  $('lede').textContent =
    `${live.length} connector${live.length === 1 ? '' : 's'} active, ${state.model.jobCount} jobs running on baselines. Everything from here is recorded as an event you can inspect, and nothing leaves this machine.`;

  $('left-extra').replaceChildren(
    el('div', { class: 'note' }, [
      lead('Try it from the terminal.', ''),
      el('pre', { class: 'env', text: 'arish status\narish doctor\narish vault init\narish verify-chain' }),
    ]),
  );

  $('pane-right').replaceChildren(
    el('div', { class: 'card', style: 'display:block;padding:4px 18px' }, [
      ...(added.length === 0
        ? [el('div', { class: 'principle' }, [el('h3', { text: 'No connectors added' }), el('p', { text: 'That is a legitimate way to run: the agent still remembers what you tell it directly.' })])]
        : added.map((c) =>
            el('div', { class: 'principle' }, [
              el('h3', { text: c.name }),
              el('p', { text: c.status === 'available' ? `Active — data enters at ${c.yieldsTrust} trust.` : `Chosen, not active. ${c.blockedBecause}` }),
            ]),
          )),
    ]),
  );
}

/* ── shell ──────────────────────────────────────────────────────────────── */

function flash(message) {
  const toast = el('div', {
    class: 'note warn',
    text: message,
    style: 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);max-width:540px;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.12)',
  });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 5200);
}

const STEPS = [renderAbout, renderConnectors, renderModel, renderDone];

function render() {
  STEPS[state.step]();
  $('steps').replaceChildren(
    ...STEPS.map((_, i) => el('span', { class: `step-dot${i === state.step ? ' on' : ''}` })),
  );
  $('prev').disabled = state.step === 0;
  $('next').disabled = state.step === STEPS.length - 1;
  for (const [id, step] of [['nav-home', 0], ['nav-connect', 1], ['nav-model', 2]]) {
    $(id).classList.toggle('active', state.step === step);
  }
  window.scrollTo({ top: 0 });
}

const go = (step) => {
  state.step = Math.max(0, Math.min(STEPS.length - 1, step));
  render();
};

$('prev').addEventListener('click', () => go(state.step - 1));
$('next').addEventListener('click', () => go(state.step + 1));
$('nav-home').addEventListener('click', () => go(0));
$('nav-connect').addEventListener('click', () => go(1));
$('nav-model').addEventListener('click', () => go(2));
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') go(state.step + 1);
  if (e.key === 'ArrowLeft') go(state.step - 1);
});

(async function boot() {
  const [status, connectors, model] = await Promise.all([
    api('/api/status'),
    api('/api/connectors'),
    api('/api/model'),
  ]);
  Object.assign(state, { status, connectors, model });
  state.draft.provider = model.provider;
  state.draft.name = model.name;
  state.draft.apiKeyRef = model.apiKeyRef;
  state.draft.baseUrl = model.baseUrl;
  render();
})();
