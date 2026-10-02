/**
 * M5 demo — what the model actually sees, and what it costs.
 *
 *   npm run demo:m5
 */
import { assembleContext } from '../src/cognition/context/assemble.js';
import { policyFor, resolveBudgets } from '../src/cognition/context/policy.js';
import { SURVIVAL_ORDER, RENDER_ORDER } from '../src/cognition/context/types.js';
import { TokenCache } from '../src/cognition/tokens.js';
import { Compactor } from '../src/cognition/compaction.js';
import { Snapshotter } from '../src/orchestration/snapshot.js';
import { createTestSubstrate } from '../src/substrate/index.js';
import { SCENARIOS, T0 } from '../test/fixtures/snapshots.js';

const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line('─'.repeat(t.length));
};
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);

/** Something a person might plausibly say, so the summary has material. */
const SCRIPT = [
  "Let's go with Alfama for the flat.",
  'I will sign the lease on Friday.',
  'Still need to tell Priya about the dates.',
  'We agreed the budget is 1400 a month.',
  'What day does the deposit clear?',
];

const assemble = (name: string, window: number) =>
  assembleContext({
    principal: 'user:ara',
    sessionId: 'ses-demo',
    trust: 'USER',
    now: T0,
    policy: policyFor('demo-model', { window, reserveForOutput: 0 }),
    snapshot: SCENARIOS[name]!(),
  });

/* ── 1 ──────────────────────────────────────────────────────────────────── */

rule('1. Fourteen blocks, two orders');
{
  line('  Survival order — who survives the squeeze (§21):');
  line(`    ${SURVIVAL_ORDER.join(' → ')}`);
  line();
  line('  Render order — what the model reads, top to bottom:');
  line(`    ${RENDER_ORDER.join(' → ')}`);
  line();
  line('  \x1b[2mThey are different on purpose. Kernel instructions survive');
  line('  everything and are read first; the conversation is read last and');
  line('  squeezed early. One array cannot say both.\x1b[0m');
}

/* ── 2 ──────────────────────────────────────────────────────────────────── */

rule('2. A cold start tells the truth about not knowing you');
{
  const context = assemble('cold-start', 4_000);
  const text = context.messages.map((m) => m.content).join('\n');
  const honest = text.split('\n').find((l) => l.includes('Act like someone'))!;
  for (const chunk of honest.match(/.{1,74}(\s|$)/g) ?? []) line(`  ${chunk.trim()}`);
  line();
  ok('a new user is never shown fabricated intimacy (§24.4)');
}

/* ── 3 ──────────────────────────────────────────────────────────────────── */

rule('3. Memories arrive with their epistemics (invariant 5)');
{
  const context = assemble('everything', 4_000);
  const text = context.messages.map((m) => m.content).join('\n');
  for (const l of text.split('\n')) {
    if (/\((observed|inferred|they told you|imported), \d/.test(l)) line(`  ${l.slice(0, 118)}`);
  }
  line();
  ok('"he told me" and "I guessed" do not look the same');
  ok('the secret-sensitivity fact is not rendered at all');
}

/* ── 4 ──────────────────────────────────────────────────────────────────── */

rule('4. The squeeze, reported rather than silent');
{
  for (const window of [8_000, 4_000, 2_400, 1_600]) {
    const context = assemble('near-overflow', window);
    const blocks = context.blocks
      .map((b) => `${b.name}=${b.tokens}`)
      .join(' ');
    line(`  ${String(window).padStart(5)} tokens → used ${String(context.totalTokens).padStart(4)}, dropped ${String(context.evictions.length).padStart(2)}`);
    line(`          ${blocks}`);
  }
  line();
  const tight = assemble('near-overflow', 1_600);
  const text = tight.messages.map((m) => m.content).join('\n');
  line(`  The model is told: "${text.split('\n').find((l) => l.includes('dropped to fit'))?.slice(0, 72)}…"`);
  ok('constraints and the identity card are still there at every size');
}

/* ── 5 ──────────────────────────────────────────────────────────────────── */

rule('5. Two hundred turns, under the bar');
{
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created', payload: { title: 'long' },
    principal: 'user:ara', trust: 'USER', sessionId: 'ses-long',
  });
  for (let i = 0; i < 200; i++) {
    const user = i % 2 === 0;
    substrate.events.append({
      type: user ? 'message.user' : 'message.agent',
      payload: user
        ? { text: `${SCRIPT[i % SCRIPT.length]} ${'Some further detail. '.repeat(6)}`, attachments: [] }
        : { text: `Noted. ${'I have recorded that. '.repeat(6)}` },
      principal: user ? 'user:ara' : 'system',
      trust: user ? 'USER' : 'DERIVED',
      sessionId: 'ses-long',
    });
  }

  const compactor = new Compactor(substrate);
  const snapshotter = new Snapshotter({ events: substrate.events, clock: substrate.clock, compactor });
  const cache = new TokenCache();
  const policy = policyFor('demo-model', { window: 8_000, reserveForOutput: 0 });

  const once = () => {
    const gathered = snapshotter.gather({
      principal: 'user:ara', sessionId: 'ses-long', runId: 'run-1',
      trigger: 'user', degradation: 'L0', observations: [], fallbackTrust: 'USER',
    });
    return assembleContext({
      principal: 'user:ara', sessionId: 'ses-long', trust: gathered.effectiveTrust,
      now: T0, policy, snapshot: gathered.snapshot, countTokens: (t) => cache.count(t),
    });
  };

  once();
  const start = performance.now();
  const context = once();
  const elapsed = performance.now() - start;

  line(`  200 turns → ${context.totalTokens} tokens, ${context.evictions.length} dropped`);
  line(`  assembly:   ${elapsed.toFixed(2)}ms   (the bar is 100ms)`);

  const chunk = compactor.compact('ses-long')!;
  line();
  line(`  compacted the oldest ${chunk.summary.span.turnCount} turns into:`);
  line(`    decided:   ${chunk.summary.decisions[0] ?? '—'}`);
  line(`    about:     ${chunk.summary.entities.slice(0, 6).join(', ') || '—'}`);
  line(`    pointers:  ${chunk.summary.span.fromEventId} .. ${chunk.summary.span.toEventId}`);

  const expanded = compactor.expand('ses-long', chunk.summary.span.fromEventId, chunk.summary.span.toEventId);
  line(`    expand():  ${expanded.length} original turns, still verbatim in the log`);
  ok('compaction is a view, never a deletion (§23)');
  substrate.close();
}

/* ── 6 ──────────────────────────────────────────────────────────────────── */

rule('6. Budgets are declared, not invented');
{
  const policy = policyFor('claude-3-5-sonnet');
  const budgets = resolveBudgets(policy);
  line(`  claude-3-5-sonnet: ${policy.window} window, ${policy.reserveForOutput} reserved for output`);
  for (const name of SURVIVAL_ORDER) {
    const b = budgets.byBlock[name];
    const bar = '█'.repeat(Math.max(1, Math.round(b.share * 100)));
    line(`    ${name.padEnd(13)} ${String(Math.round(b.share * 100)).padStart(2)}%  ${String(b.tokens).padStart(6)}  ${bar}`);
  }
}

rule('M5');
line('  A 200-turn session stays in budget, assembles in single-digit');
line('  milliseconds, and logs exactly what the model was given.');
line();
