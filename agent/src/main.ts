/**
 * The agent process (L6 entry point).
 *
 * One file that composes every layer in dependency order and starts the HTTP
 * + SSE surface Veo talks to. Nothing is constructed anywhere else: if you
 * want to know what this agent can do, the answer is the forty lines below.
 *
 *     npm run agent            # from the repo root
 *
 * Configuration, all optional:
 *
 *     ARISH_PORT      default 7777
 *     ARISH_DB        default ./.arish/arish.db   (one file; backup is `cp`)
 *     ARISH_TOKEN     default a token printed at boot
 *     ARISH_API_KEY   an OpenAI-compatible key; without it the agent runs
 *                     offline and says so rather than pretending
 *     ARISH_BASE_URL  default https://api.openai.com/v1
 *     ARISH_MODEL     default gpt-4o-mini
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSubstrate } from './substrate/index.js';
import { ToolRegistry } from './capability/registry.js';
import { registerBuiltins } from './tools/index.js';
import { makeHistoryExpand } from './tools/history-expand.js';
import { Invoker } from './capability/invoke.js';
import { DEFAULT_GRANTS } from './capability/policy.js';
import { ApprovalStore, SuspensionStore } from './capability/approvals.js';
import { DailyLedger, DEFAULT_DAILY_BUDGET } from './capability/budgets.js';
import { Compactor } from './cognition/compaction.js';
import { Snapshotter } from './orchestration/snapshot.js';
import { Runner } from './orchestration/runner.js';
import { Api } from './interface/http.js';
import { OfflineProvider } from './providers/offline.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import { DiskFileStore } from './adapters/files.js';
import { NodeNet } from './adapters/net.js';
import type { ModelProvider } from './substrate/ports.js';

const PORT = Number(process.env.ARISH_PORT ?? 7777);
const DB = resolve(process.env.ARISH_DB ?? './.arish/arish.db');
const PRINCIPAL = process.env.ARISH_PRINCIPAL ?? 'user:me';

export interface StartedAgent {
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface StartOptions {
  /** 0 asks the OS for a free port — what the tests use. */
  port?: number;
  dbPath?: string;
  token?: string;
}

export async function start(options: StartOptions = {}): Promise<StartedAgent> {
  const port = options.port ?? PORT;
  const db = options.dbPath ?? DB;
  mkdirSync(dirname(db), { recursive: true });
  const substrate = createSubstrate({ dbPath: db });
  const { events, storage, clock, ids, hashing, logger, redactor } = substrate;

  /* ── L4/L5: the model ──────────────────────────────────────────────────── */
  const apiKey = process.env.ARISH_API_KEY;
  const model: ModelProvider =
    apiKey === undefined || apiKey === ''
      ? new OfflineProvider()
      : new OpenAiCompatibleProvider({
          apiKey,
          model: process.env.ARISH_MODEL ?? 'gpt-4o-mini',
          ...(process.env.ARISH_BASE_URL === undefined
            ? {}
            : { baseUrl: process.env.ARISH_BASE_URL }),
          pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
        });

  /* ── L3: capability ────────────────────────────────────────────────────── */
  const approvals = new ApprovalStore(storage, events, clock, ids);
  const suspensions = new SuspensionStore(storage, events, clock);
  const compactor = new Compactor({ events, clock, ids });

  const registry = new ToolRegistry();
  registerBuiltins(registry);
  registry.register(
    makeHistoryExpand(compactor, (runId) => {
      const row = storage.get<{ session_id: string }>(
        'SELECT session_id FROM runs WHERE id = ?',
        [runId],
      );
      return row?.session_id ?? null;
    }),
  );

  const invoker = new Invoker({
    registry,
    grants: DEFAULT_GRANTS,
    approvals,
    events,
    storage,
    clock,
    ids,
    hashing,
    logger,
    redactor,
    files: new DiskFileStore(resolve(dirname(db), 'files')),
    net: new NodeNet(),
  });

  /* ── L5: orchestration ─────────────────────────────────────────────────── */
  const snapshotter = new Snapshotter({
    events,
    clock,
    compactor,
    // Block 13 of the context is the tool list, filtered by trust. The
    // registry is the only place tool names exist (invariant 9), so the
    // snapshot reads them from it rather than keeping a second list that
    // can drift.
    tools: {
      summaries: () =>
        registry.list().map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: registry.specsFor((candidate) => candidate.name === tool.name)[0]
            ?.parameters ?? {},
          minTrust: tool.minTrust,
        })),
    },
  });
  const runner = new Runner({
    events,
    clock,
    ids,
    logger,
    model: model as never,
    invoker,
    approvals,
    suspensions,
    snapshotter,
    compactor,
    dailyLedger: new DailyLedger(events, clock),
    dailyBudget: DEFAULT_DAILY_BUDGET,
  });

  /* ── L6: interface ─────────────────────────────────────────────────────── */
  const token = options.token ?? process.env.ARISH_TOKEN ?? ids.token(24);
  const api = new Api({
    events,
    storage,
    clock,
    ids,
    logger,
    runner,
    approvals,
    redactor,
    auth: { token, principal: PRINCIPAL },
  });

  const server = api.server();
  await new Promise<void>((ready) => server.listen(port, '0.0.0.0', ready));
  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

  logger.info('agent listening', {
    port: actualPort,
    db,
    model: model.id,
    // Never the token itself. It is printed once, to the operator's
    // terminal, by the caller — not written to a log file that gets shipped.
    offline: apiKey === undefined || apiKey === '',
  });

  return {
    port: actualPort,
    token,
    close: async () => {
      await new Promise<void>((done) => server.close(() => done()));
      substrate.close();
    },
  };
}

/** Run directly (`node agent/dist/main.js`), not when imported by a test. */
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  start().then(
    (agent) => {
      // eslint-disable-next-line no-console
      console.log(
        `\n  agent → http://127.0.0.1:${agent.port}\n  token → ${agent.token}\n` +
          `  db    → ${DB}\n`,
      );
    },
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('the agent did not start:', error);
      process.exit(1);
    },
  );
}
