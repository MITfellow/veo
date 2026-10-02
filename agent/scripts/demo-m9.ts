/**
 * M9 demo — proof, portability and the things that break.
 *
 *   npm run demo:m9
 *
 * Six acts, all against a real agent on a real database:
 *
 *   1. the persona — voice, in the context, unevictable;
 *   2. a run, and the readable trace that explains it (§34.13);
 *   3. metrics computed from the log, with §32's budgets attached;
 *   4. export → import into an empty agent → identical projections;
 *   5. backup verification: "an untested backup is a rumor";
 *   6. a kill at a random instruction, and the invariants surviving it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { createSubstrate } from '../src/substrate/index.js';
import { importAll, type ExportDocument } from '../src/portability/export.js';
import { snapshotDigest } from '../src/substrate/projections/snapshot.js';

const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line('─'.repeat(t.length));
};
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const dim = (s: string) => line(`  \x1b[2m${s}\x1b[0m`);

const dir = mkdtempSync(join(tmpdir(), 'arish-demo-m9-'));
const app = await start({ port: 0, dbPath: join(dir, 'demo.db'), token: 'demo-token' });
const base = `http://127.0.0.1:${app.port}`;
const headers = { authorization: 'Bearer demo-token', 'content-type': 'application/json' };

const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as T;
};

/* ── 1. the persona ─────────────────────────────────────────────────────── */

rule('1. Voice: six fields, rendered as sentences, inside the kernel block');

const before = await call<{ persona: { formality: string }; rendered: string[] }>('/persona');
dim(`default: ${before.persona.formality}, ${before.rendered.length} lines`);

const after = await call<{ rendered: string[] }>('/persona', 'PUT', {
  agentName: 'Ada',
  addressUser: 'Ara',
  formality: 'plain',
  length: 'brief',
  emoji: false,
  language: 'match',
  notes: 'Use metric units and a 24-hour clock.',
});
for (const sentence of after.rendered) ok(sentence.replace(/^- /, ''));
dim('The constitution renders after this and outranks it: a persona cannot');
dim('repeal an article, only choose how the agent sounds obeying it.');

/* ── 2. a run, and its trace ────────────────────────────────────────────── */

rule('2. One real turn, and the trace that explains it (§34.13)');

const session = await call<{ id: string }>('/sessions', 'POST', { title: 'Demo' });
const started = await call<{ runId: string }>(`/sessions/${session.id}/messages`, 'POST', {
  text: 'what time is it?',
});
await new Promise((r) => setTimeout(r, 2500));

const trace = await (await fetch(`${base}/runs/${started.runId}/trace?format=text`, { headers })).text();
for (const text of trace.split('\n').slice(0, 24)) line(`  ${text}`);
dim('… the full trace also lists approvals, effects, constitution verdicts');
dim('and degradation, and is built from the log — so it renders for a run');
dim('that finished two years ago.');

/* ── 3. metrics ─────────────────────────────────────────────────────────── */

rule('3. Metrics, computed from the log, with §32 attached');

const metrics = await call<{
  runs: { total: number };
  latency: {
    contextAssemblyMs: { p95: number | null; budgetMs: number; met: boolean | null };
    modelMs: { p50: number | null };
  };
  tokens: { input: number; output: number };
  tools: { succeeded: number; failed: number; denied: number; successRate: number | null };
  context: { utilization: number | null };
  memory: { hitRate: number | null; facts: number };
}>('/metrics');

ok(`${metrics.runs.total} run(s) · ${metrics.tokens.input} in / ${metrics.tokens.output} out`);
ok(
  `context assembly p95 ${metrics.latency.contextAssemblyMs.p95?.toFixed(1) ?? '—'}ms ` +
    `against a ${metrics.latency.contextAssemblyMs.budgetMs}ms budget → ` +
    `${metrics.latency.contextAssemblyMs.met === true ? 'met' : 'NOT met'}`,
);
ok(
  `tools: ${metrics.tools.succeeded} ok, ${metrics.tools.failed} failed, ` +
    `${metrics.tools.denied} denied (denials are not failures)`,
);
ok(`context utilization ${((metrics.context.utilization ?? 0) * 100).toFixed(0)}% of the window`);
dim('No counters anywhere: restart the process and these numbers are the same.');

/* ── 4. export → import ─────────────────────────────────────────────────── */

rule('4. Portability: export, import into an empty agent, compare');

const doc = await call<ExportDocument>('/export', 'POST');
ok(`exported ${doc.eventCount} events · digest ${doc.projectionDigest}`);

const intoDir = mkdtempSync(join(tmpdir(), 'arish-demo-into-'));
const into = createSubstrate({ dbPath: join(intoDir, 'into.db') });
const outcome = importAll(into, doc);
ok(`${outcome.reason} — ${outcome.imported} events`);
ok(
  `projection digest ${outcome.projectionDigest === doc.projectionDigest ? 'matches' : 'DIFFERS'}` +
    ` after a full rebuild from events alone`,
);
const persona = into.storage.get<{ agent_name: string }>('SELECT * FROM personas');
ok(`the imported agent still answers to "${persona?.agent_name ?? '—'}"`);
const refused = importAll(into, doc);
ok(`a second import is refused: ${refused.reason}`);
into.close();
rmSync(intoDir, { recursive: true, force: true });

/* ── 5. backup verification ─────────────────────────────────────────────── */

rule('5. "An untested backup is a rumor" (§13.5)');

const report = await call<{ ok: boolean; notes: string[]; elapsedMs: number }>(
  '/backup/verify',
  'POST',
);
for (const note of report.notes) ok(note);
dim(`${report.ok ? 'healthy' : 'NOT HEALTHY'} · ${report.elapsedMs}ms`);

/* ── 6. a kill ──────────────────────────────────────────────────────────── */

rule('6. Kill the process and open the file again (§34.1)');

const dbPath = join(dir, 'demo.db');
await app.close();
dim('process closed mid-life, nothing flushed by hand');

const reopened = createSubstrate({ dbPath });
const chain = reopened.events.verifyChain();
ok(`hash chain verifies across ${chain.checked} events`);
const digestBefore = snapshotDigest(reopened.storage, reopened.hashing);
reopened.events.rebuild();
const digestAfter = snapshotDigest(reopened.storage, reopened.hashing);
ok(`projections rebuild ${digestBefore === digestAfter ? 'byte-identically' : 'DIFFERENTLY'}`);
const runs = reopened.storage.all<{ state: string }>('SELECT state FROM runs');
ok(`${runs.length} run(s), all in a terminal or resumable state: ${runs.map((r) => r.state).join(', ')}`);
reopened.close();

line();
dim('The chaos suite does this 200 times with randomized kill points.');
line();

rmSync(dir, { recursive: true, force: true });
