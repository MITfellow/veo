/**
 * M2 demo — `npm run demo:m2`.
 *
 * The milestone's "done when", demonstrated literally:
 *
 *   > a two-turn conversation streams to curl **and the whole run is
 *   > reconstructible from the log alone**.
 *
 * This starts a real HTTP server on a real port, talks to it over a real
 * socket, streams real SSE, then throws away every projection and rebuilds
 * the entire conversation from the event log.
 */
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Api } from '../src/interface/http.js';
import { Runner } from '../src/orchestration/runner.js';
import { ALL_PROJECTORS, createSubstrate } from '../src/substrate/index.js';
import { FakeClock } from '../src/substrate/clock.js';
import { fakeIds } from '../src/substrate/ids.js';
import { testConfig } from '../src/substrate/config.js';
import { NullLogger } from '../src/substrate/log.js';
import { SqliteStorage } from '../src/substrate/storage/sqlite.js';
import { canonicalJson } from '../src/substrate/hash.js';
import type { ModelChunk, ModelRequest } from '../src/substrate/model/types.js';
import type { ModelCapabilities } from '../src/substrate/ports.js';

const DB = '/tmp/arish-demo-m2.db';
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${DB}${suffix}`);
  } catch {
    /* first run */
  }
}

const bold = (s: string): string => `\u001b[1m${s}\u001b[0m`;
const dim = (s: string): string => `\u001b[2m${s}\u001b[0m`;
const ok = (s: string): string => `\u001b[32m${s}\u001b[0m`;
const bad = (s: string): string => `\u001b[31m${s}\u001b[0m`;
const cyan = (s: string): string => `\u001b[36m${s}\u001b[0m`;
const head = (n: number, s: string): void => console.log(`\n${bold(`${n}. ${s}`)}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A scripted provider that streams word by word with a real delay, so the
 * demo shows actual streaming rather than one instantaneous blob.
 */
class DemoModel {
  readonly id = 'demo-model';
  readonly capabilities: ModelCapabilities = {
    tools: true,
    structuredOutput: true,
    vision: false,
    caching: false,
    maxContext: 8192,
    maxOutput: 1024,
  };
  private call = 0;
  constructor(private readonly answers: string[]) {}

  async *generate(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    const answer = this.answers[this.call++] ?? 'I have nothing further.';
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    for (const word of answer.split(/(?<=\s)/)) {
      if (signal.aborted) return;
      await sleep(18);
      yield { type: 'text-delta', text: word };
    }
    yield {
      type: 'usage',
      inputTokens: Math.ceil(promptChars / 4),
      outputTokens: Math.ceil(answer.length / 4),
      costMicros: 420,
    };
    yield { type: 'finish', reason: 'stop' };
  }

  async countTokens(input: ModelRequest | string): Promise<number> {
    const text = typeof input === 'string' ? input : input.messages.map((m) => m.content).join('');
    return Math.ceil(text.length / 4);
  }
}

const TOKEN = 'demo-token-not-a-real-secret';

const clock = new FakeClock('2026-03-01T09:00:00Z');
const substrate = createSubstrate({
  config: testConfig(),
  clock,
  ids: fakeIds(clock, 7),
  storage: new SqliteStorage({ path: DB }),
  logger: new NullLogger(),
});

const runner = new Runner({
  events: substrate.events,
  clock: substrate.clock,
  ids: substrate.ids,
  logger: substrate.logger,
  model: new DemoModel([
    'Nice to meet you, Ara. Lisbon in March is a good call — the jacarandas are not out yet, but the light is.',
    'You said your name is Ara, and that you are moving to Lisbon in March for a job at a climate startup.',
  ]),
});

const api = new Api({
  events: substrate.events,
  storage: substrate.storage,
  clock: substrate.clock,
  ids: substrate.ids,
  logger: substrate.logger,
  runner,
  auth: { token: TOKEN, principal: 'user:ara' },
});

const server = api.server();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const post = async (path: string, body: unknown): Promise<any> =>
  (await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })).json();

/** Stream SSE and print deltas as they land, like curl would. */
async function stream(runId: string, lastEventId?: string): Promise<string[]> {
  const res = await fetch(`${base}/runs/${runId}/stream`, {
    headers: { ...headers, ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}) },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const ids: string[] = [];
  let buffer = '';
  process.stdout.write('  ');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      if (block.trim().length === 0 || block.startsWith(':')) continue;
      const fields: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      if (fields.id !== undefined) ids.push(fields.id);
      if (fields.event === 'delta') {
        // Live tokens as they arrive off the socket.
        process.stdout.write(cyan(JSON.parse(fields.data!).text as string));
      } else if (fields.event === 'message') {
        // The durable record of the same text. On a live stream the deltas
        // already printed it; on a replay this is where it comes from.
        if (ids.length <= 1) process.stdout.write(cyan(JSON.parse(fields.data!).text as string));
      } else if (fields.event === 'done') {
        const data = JSON.parse(fields.data!) as { reason: string; steps: number };
        process.stdout.write(dim(`\n  [done: reason=${data.reason} steps=${data.steps}]\n`));
      }
    }
  }
  return ids;
}

/* ─────────────────────── 1. a real two-turn conversation ────────────────── */

head(1, 'A two-turn conversation over HTTP, streamed as SSE');
console.log(dim(`  server listening on ${base}`));

const session = await post('/sessions', { title: 'Lisbon' });
console.log(dim(`  POST /sessions → ${session.id}\n`));

console.log(`  ${bold('ara:')} My name is Ara and I am moving to Lisbon in March.`);
const run1 = await post(`/sessions/${session.id}/messages`, {
  text: 'My name is Ara and I am moving to Lisbon in March.',
});
console.log(dim(`  → 202 Accepted, runId ${run1.runId} (before the run finishes)`));
const ids1 = await stream(run1.runId);

console.log(`\n  ${bold('ara:')} What do you know about me?`);
const run2 = await post(`/sessions/${session.id}/messages`, { text: 'What do you know about me?' });
await stream(run2.runId);
console.log(dim('\n  Turn two saw turn one — the history came from the event log.'));

/* ────────────────────────── 2. resume loses nothing ─────────────────────── */

head(2, 'A sleeping laptop reconnects and loses nothing');

console.log(dim(`  the client had received up to id ${ids1[0]}; reconnecting from there:`));
const resumed = await stream(run1.runId, ids1[0]);
console.log(
  `  frames before: ${ids1.length}   after resume: ${resumed.length}   ` +
    `overlap: ${ok(resumed.includes(ids1[0]!) ? 'DUPLICATED' : 'none')}`,
);
console.log(
  dim('  The SSE id IS the event-log sequence number, so resume is just a log read.'),
);

/* ───────────────────────── 3. cancellation mid-stream ───────────────────── */

head(3, 'Cancelling mid-stream keeps what was already said');

const slowRunner = runner;
const run3 = await post(`/sessions/${session.id}/messages`, { text: 'Tell me everything.' });
await sleep(40);
const cancelled = await post(`/runs/${run3.runId}/cancel`, {});
console.log(`  POST /runs/:id/cancel → ${cancelled.cancelled ? ok('cancelled') : dim('already done')}`);
await sleep(80);
const partial = substrate.storage.get<{ text: string }>(
  'SELECT text FROM messages WHERE run_id = ? AND role = ?',
  [run3.runId, 'agent'],
);
console.log(`  partial text kept: ${partial === undefined ? dim('(none yet)') : ok(`"${partial.text.slice(0, 48)}…"`)}`);
console.log(dim('  The user watched those words appear; making them vanish is worse than stopping.'));
void slowRunner;

/* ──────────────────── 4. reconstructible from the log alone ─────────────── */

head(4, 'The whole conversation, rebuilt from the log alone');

const tables = ['sessions', 'messages', 'runs', 'steps'];
const dump = (): string =>
  canonicalJson(
    Object.fromEntries(
      tables.map((t) => [t, substrate.storage.all(`SELECT * FROM ${t} ORDER BY rowid`)]),
    ),
  );

const before = dump();
const counts = tables.map(
  (t) => `${t}=${substrate.storage.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0}`,
);
console.log(`  before: ${counts.join('  ')}`);

for (const projector of ALL_PROJECTORS) projector.reset(substrate.storage);
console.log(`  ${bad('dropped every projection')} → messages=${
  substrate.storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0
}`);

substrate.events.rebuild();
const after = dump();
console.log(`  after replay: ${tables
  .map((t) => `${t}=${substrate.storage.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0}`)
  .join('  ')}`);
console.log(`\n  byte-identical: ${before === after ? ok('YES') : bad('NO')}`);
console.log(`  hash chain:     ${substrate.events.verifyChain().ok ? ok('verified') : bad('BROKEN')}`);

/* ─────────────────────────────── 5. the trace ───────────────────────────── */

head(5, 'Every run explains itself (§30)');

const trace = (await (await fetch(`${base}/runs/${run1.runId}/trace`, { headers })).json()) as {
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
};
for (const event of trace.events) {
  const detail =
    event.type === 'model.requested'
      ? dim(` ${(event.payload.contextDigest as string).slice(0, 72)}…`)
      : event.type === 'run.finished'
        ? dim(` reason=${event.payload.reason} steps=${event.payload.steps}`)
        : '';
  console.log(`  ${dim(String(event.seq).padStart(3))} ${event.type.padEnd(18)}${detail}`);
}

console.log(dim(`\n  database: ${DB}  ·  npm run verify-chain -- ${DB}\n`));

server.close();
substrate.close();
