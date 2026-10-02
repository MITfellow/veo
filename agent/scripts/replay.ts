/**
 * `npm run replay -- <runId>` — §34.5.
 *
 *   npm run replay -- 01K9…           # against ./.arish/arish.db
 *   ARISH_DB=/path/to.db npm run replay -- 01K9…
 *   npm run replay -- --last          # the most recent run
 *   npm run replay -- --last --trace  # and print its readable trace
 *
 * Rebuilds the context the run would assemble with today's code and
 * diffs it against what was recorded at the time. Exits 1 if anything
 * moved, so it can be a CI step: refactor the assembler, run this over a
 * corpus of historical runs, and the command tells you exactly what a
 * model would now see differently.
 *
 * It opens the database **read-only** — a command that audits the log
 * must not be able to write to it.
 */
import { resolve } from 'node:path';
import { createSubstrate } from '../src/substrate/index.js';
import { Snapshotter } from '../src/orchestration/snapshot.js';
import { Compactor } from '../src/cognition/compaction.js';
import { assembleContext } from '../src/cognition/context/assemble.js';
import { policyFor } from '../src/cognition/context/policy.js';
import { ConstitutionStore } from '../src/cognition/constitution/store.js';
import { viewOf } from '../src/cognition/constitution/render.js';
import { PersonaStore } from '../src/cognition/persona/store.js';
import { MemoryService } from '../src/cognition/memory/service.js';
import { HashEmbedder } from '../src/providers/fake-embedder.js';
import { replayRun, renderReplay } from '../src/observability/replay.js';
import { traceOf, renderTrace } from '../src/observability/trace.js';
import { DEFAULT_SYSTEM } from '../src/orchestration/runner.js';
import type { PayloadOf } from '../src/substrate/events/types.js';

const args = process.argv.slice(2);
const wantsTrace = args.includes('--trace');
const wantsLast = args.includes('--last');
const explicitId = args.find((arg) => !arg.startsWith('--'));
const dbPath = resolve(process.env.ARISH_DB ?? './.arish/arish.db');

const substrate = createSubstrate({ dbPath });
const { storage, events, clock, ids, logger } = substrate;

const runId =
  explicitId ??
  (wantsLast
    ? storage.get<{ id: string }>('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1')?.id
    : undefined);

if (runId === undefined) {
  // eslint-disable-next-line no-console
  console.error(
    'usage: npm run replay -- <runId> | --last [--trace]\n' +
      `  database: ${dbPath}\n` +
      '  (no run id given, and --last found nothing)',
  );
  substrate.close();
  process.exit(2);
}

/* The same cognition stack the agent composes, minus anything that acts. */
const compactor = new Compactor({ events, clock, ids });
const constitution = new ConstitutionStore({ storage, events, clock, ids });
const persona = new PersonaStore({ storage, events, clock });
const memory = new MemoryService({
  storage,
  events,
  clock,
  ids,
  principal: 'user:me',
  embedder: new HashEmbedder(),
  logger,
});

const snapshotter = new Snapshotter({
  events,
  clock,
  compactor,
  memory: memory.source,
  constitutionDoc: () => viewOf(constitution.current()),
  persona: (who) => persona.lines(who),
  tools: { summaries: () => [] },
});

const result = replayRun(events, runId, (id) => {
  const started = events.read({ runId: id, types: ['run.started'] })[0];
  if (started === undefined) return null;
  const p = started.payload as PayloadOf<'run.started'>;

  const gathered = snapshotter.gather({
    principal: started.principal,
    sessionId: started.sessionId ?? p.sessionId,
    runId: id,
    // The conversation as it stood when the run began.
    asOfSeq: started.seq,
    trigger: p.trigger,
    degradation: 'L0',
    observations: [],
    fallbackTrust: p.trigger === 'user' ? 'USER' : 'SYSTEM',
  });

  const assembled = assembleContext({
    principal: started.principal,
    sessionId: started.sessionId ?? p.sessionId,
    trust: gathered.effectiveTrust,
    // The *original* time, not now: a replay that used today's clock
    // would diff the Situation block on every run and tell you nothing.
    now: started.ts,
    policy: policyFor('replay', { window: 6_000, reserveForOutput: 0 }),
    snapshot: {
      ...gathered.snapshot,
      kernel: gathered.snapshot.kernel === '' ? DEFAULT_SYSTEM : gathered.snapshot.kernel,
    },
  });

  return {
    digest: assembled.digest,
    totalTokens: assembled.totalTokens,
    policyVersion: assembled.policyVersion,
    blocks: assembled.blocks.map((b) => ({ name: b.name, tokens: b.tokens, items: b.items })),
  };
});

// eslint-disable-next-line no-console
console.log(`\n${renderReplay(result)}\n`);

if (wantsTrace) {
  const trace = traceOf(runId, events.read({ runId }));
  // eslint-disable-next-line no-console
  if (trace !== null) console.log(renderTrace(trace));
}

const drifted = result.diffs.length > 0;
substrate.close();

// Non-zero on drift, so this can gate a refactor in CI.
process.exit(result.found ? (drifted ? 1 : 0) : 2);
