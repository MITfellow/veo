/**
 * M7 demo — the contract, and whether it was kept.
 *
 *   npm run demo:m7
 *
 * Five things in one run: the charter the agent boots with, what happens
 * when the user overrules an article, what cannot be removed and why, the
 * gate refusing to let a model be called without the document, and the
 * checks judging a few answers — including the ones they honestly cannot
 * judge.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/substrate/clock.js';
import { createTestSubstrate } from '../src/substrate/index.js';
import { ConstitutionStore } from '../src/cognition/constitution/store.js';
import { ENTRENCHED_IDS } from '../src/cognition/constitution/founding.js';
import { sentinelFor, viewOf } from '../src/cognition/constitution/render.js';
import { CHECKS, emptyEvidence } from '../src/cognition/constitution/checks.js';
import { judge } from '../src/cognition/constitution/enforce.js';
import { assertGoverned } from '../src/orchestration/governed-model.js';
import { brier, report, type Resolution } from '../src/cognition/calibration/confidence.js';

const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line('─'.repeat(t.length));
};
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const no = (s: string) => line(`  \x1b[31m✗\x1b[0m ${s}`);
const dim = (s: string) => line(`  \x1b[2m${s}\x1b[0m`);

const PRINCIPAL = 'user:ara';

const dir = mkdtempSync(join(tmpdir(), 'arish-demo-m7-'));
const clock = new FakeClock();
const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'demo.db') });
const store = new ConstitutionStore({
  storage: substrate.storage,
  events: substrate.events,
  clock,
  ids: substrate.ids,
});

rule('1. What it boots with');
const founding = store.ensureFounding(PRINCIPAL);
ok(`ratified v${founding.version} · ${founding.live.length} articles · sha ${founding.hash}`);
for (const article of founding.live.slice(0, 4)) {
  dim(`${article.id} [${article.enforcement}] ${article.text.slice(0, 72)}…`);
}
dim(`…and ${founding.live.length - 4} more. ${ENTRENCHED_IDS.length} of them cannot be repealed.`);

rule('2. Your articles outrank its own');
store.adopt(PRINCIPAL, {
  id: 'U-tone',
  text: 'Open warmly. A line of pleasantry before the answer is fine.',
  origin: 'user',
  kind: 'style',
  enforcement: 'advisory',
  subject: 'tone',
  stance: 'require',
  cites: 'asked for in settings',
});
const amended = store.current();
// `live` carries the supersedence annotations; `articles` is the raw set.
const f7 = amended.live.find((a) => a.id === 'F7')!;
ok(`v${amended.version}: U-tone adopted`);
no(`F7 ("I do not open with flattery") → overridden by ${f7.supersededBy ?? '—'}`);
dim('It is still shown to the model, marked as overruled. Losing an argument is not the same as never having had one.');

rule('3. What cannot be removed');
for (const id of ENTRENCHED_IDS.slice(0, 2)) {
  try {
    store.repeal(PRINCIPAL, id);
    no(`${id} was repealed — this should be impossible`);
  } catch (error) {
    ok(`${id} refused: ${(error as Error).message.slice(0, 96)}…`);
  }
}
dim('These describe what other modules physically do. Deleting them would not change the agent, only make the document wrong.');

rule('4. No constitution, no model call');
const view = viewOf(store.current());
dim(sentinelFor(view));
try {
  assertGoverned('demo', { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, view);
  no('an ungoverned call went through');
} catch (error) {
  ok(`refused before the provider was touched: ${(error as Error).name}`);
}
try {
  assertGoverned(
    'demo',
    { model: 'x', messages: [{ role: 'system', content: sentinelFor(view) }] },
    view,
  );
  ok('a governed call passes');
} catch {
  no('a governed call was refused');
}

rule('5. Judging three answers');
const cases: Array<[string, ReturnType<typeof emptyEvidence>]> = [
  [
    'Claims an action it never took',
    emptyEvidence({ output: "Done — I've emailed Priya the draft.", toolsCompleted: [] }),
  ],
  [
    'Opens with flattery — but you asked for warmth, so F7 is not enforced',
    emptyEvidence({ output: 'Great question! The deadline is the 14th.' }),
  ],
  [
    'Says it does not know',
    emptyEvidence({ output: "I don't know when the lease ends — you've never told me." }),
  ],
];
for (const [label, evidence] of cases) {
  const verdict = judge(store.current(), evidence);
  const broken = verdict.verdicts.filter((v) => v.verdict === 'violated');
  const blind = verdict.verdicts.filter((v) => v.verdict === 'unverifiable');
  line(`  \x1b[36m${label}\x1b[0m`);
  if (broken.length === 0) ok('nothing broken');
  for (const v of broken) no(`${v.articleId} (${v.check}) — ${v.detail}`);
  dim(`${blind.length} of ${verdict.verdicts.length} checks could not tell either way, and say so.`);
}

rule('6. Confidence that means something');
dim(`${Object.keys(CHECKS).length} checks registered; each publishes what it cannot see.`);
const resolutions: Resolution[] = [
  { factId: null, predicted: 0.9, outcome: 1, resolvedAt: clock.now(), source: 'probe' },
  { factId: null, predicted: 0.9, outcome: 0, resolvedAt: clock.now(), source: 'correction' },
  { factId: null, predicted: 0.6, outcome: 1, resolvedAt: clock.now(), source: 'probe' },
  { factId: null, predicted: 0.3, outcome: 0, resolvedAt: clock.now(), source: 'tool' },
];
ok(`Brier score over ${resolutions.length} resolved predictions: ${brier(resolutions).toFixed(3)}`);
const scored = report(resolutions, 2, { from: clock.now() - 14 * 86_400_000, to: clock.now() });
dim(
  scored.meaningful
    ? 'enough data to call this calibration'
    : 'not enough resolutions yet — reported as "not meaningful" rather than as a good score',
);

line();
ok(`the event chain still verifies: ${substrate.events.verifyChain().ok}`);
line();
substrate.close();
rmSync(dir, { recursive: true, force: true });
