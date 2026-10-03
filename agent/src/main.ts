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
import { MemoryService } from './cognition/memory/service.js';
import { HashEmbedder } from './providers/fake-embedder.js';
import { Runner } from './orchestration/runner.js';
import { Api } from './interface/http.js';
import { ConstitutionStore } from './cognition/constitution/store.js';
import { viewOf } from './cognition/constitution/render.js';
import { AskBudget } from './cognition/calibration/probe.js';
import { BiasAuditor } from './cognition/calibration/audit.js';
import { GovernedProvider } from './orchestration/governed-model.js';
import { OfflineProvider } from './providers/offline.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import { CalendarStore } from './cognition/calendar/store.js';
import { TaskStore } from './cognition/tasks/store.js';
import { MessageSearch } from './cognition/search/messages.js';
import { PersonaStore } from './cognition/persona/store.js';
import { JobQueue } from './orchestration/queue.js';
import { ScheduleStore, SCHEDULED_RUN, scheduleSessionId } from './orchestration/schedule.js';
import { ReminderStore } from './cognition/reminders/store.js';
import { Worker } from './orchestration/worker.js';
import { Degradation } from './orchestration/degradation.js';
import { createSecurity } from './security/index.js';
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

  /* ── L2: security (§13) ────────────────────────────────────────────────
   *
   * Built before anything that could write a secret into an event. The
   * vault registers every value it unwraps with the redactor the event log
   * already uses *and* with the model-request firewall, so a secret that
   * leaks into a payload is stripped at append time rather than discovered
   * in a log file later.
   *
   * The keyring starts uninitialized and the agent runs fine that way —
   * the vault is needed only by tools that use secrets. Setting a
   * passphrase (Settings → Secrets, or POST /vault/unlock on a fresh
   * install) is what brings it to life. */
  const security = createSecurity(substrate);

  /* ── L4/L5: the model ──────────────────────────────────────────────────── */
  const apiKey = process.env.ARISH_API_KEY;
  const rawModel: ModelProvider =
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

  /* ── L4: the constitution (M7) ─────────────────────────────────────────── */
  // Built before the model is wrapped and before anything can run, because
  // the gate below refuses every model call that does not carry it. On a
  // fresh install this ratifies the founding charter as version 1, through
  // the same event path a user amendment takes (§25).
  const constitution = new ConstitutionStore({ storage, events, clock, ids });
  constitution.ensureFounding(PRINCIPAL);

  const askBudget = new AskBudget({ storage, events, clock, ids });
  const auditor = new BiasAuditor({ storage, events, clock, ids });

  /**
   * Every model in this process goes through here. Not "the provider we
   * ship" — the port. Swapping providers by config (§34.4) cannot swap the
   * behavioural contract out with them, and a future code path that reaches
   * a model without an assembled context fails loudly instead of running an
   * ungoverned agent.
   */
  const governedModel = new GovernedProvider({
    inner: rawModel,
    constitution: () => constitution.current(),
    onJudgment: (judgment, meta) => {
      events.append({
        type: 'constitution.enforced',
        principal: PRINCIPAL,
        trust: 'SYSTEM',
        runId: meta.runId === '' ? null : meta.runId,
        stepId: meta.stepId === '' ? null : meta.stepId,
        payload: {
          runId: meta.runId,
          stepId: meta.stepId,
          version: meta.version,
          hash: meta.hash,
          verdicts: judgment.verdicts.map((v) => ({
            articleId: v.articleId,
            check: v.check,
            verdict: v.verdict,
            detail: v.detail,
          })),
          remedy: meta.remedyApplied,
          buffered: meta.buffered,
        },
      });
    },
  });

  /* ── L3: capability ────────────────────────────────────────────────────── */
  const approvals = new ApprovalStore(storage, events, clock, ids);
  const suspensions = new SuspensionStore(storage, events, clock);
  const compactor = new Compactor({ events, clock, ids });

  /* ── L4: memory (M6) ───────────────────────────────────────────────────── */
  // The hash embedder ships rather than being test-only: with no API key the
  // agent still gets hashed-semantic recall on top of lexical, which is a
  // long way better than an empty memories block.
  const memory = new MemoryService({
    storage,
    events,
    clock,
    ids,
    principal: PRINCIPAL,
    embedder: new HashEmbedder(),
    logger,
  });

  // §29's persona (M9). Read by the snapshotter on every turn and written
  // only by the user through PUT /persona.
  const persona = new PersonaStore({ storage, events, clock });

  // S1's calendar. Local by construction: an append to the same event
  // log, no sync and no third-party credential anywhere beneath it.
  const calendar = new CalendarStore({ storage, events, clock, ids });
  // S2: the list with no times on it, and the agent's own view of
  // everything that has ever been said to it.
  const tasks = new TaskStore({ storage, events, clock, ids });
  const conversations = new MessageSearch({ storage });

  const queue = new JobQueue({
    storage,
    events,
    clock,
    ids,
    leaseMs: substrate.config.queue.leaseMs,
    maxAttempts: substrate.config.queue.maxAttempts,
    baseBackoffMs: substrate.config.queue.baseBackoffMs,
  });
  const schedules = new ScheduleStore({ storage, events, clock, ids, queue });

  // S3: reminders are a link between something written down and a
  // one-shot schedule, so the queue and the scheduler are built here,
  // above the registry, rather than down with the worker.
  const reminders = new ReminderStore({ storage, events, clock, ids, schedules });

  // Closing an owner takes its reminders with it. That cascade lives
  // in the HTTP layer, which is where both sides are already in
  // scope: a dependency from the task store onto the reminder store
  // would be a cycle, and the task list does not need to know that
  // reminders exist at all.

  const registry = new ToolRegistry();
  registerBuiltins(registry, {
    memory: memory.toolDeps(),
    calendar: { store: calendar },
    tasks: { store: tasks },
    reminders: { store: reminders, tasks, calendar },
    conversations: { search: conversations },
  });
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
    // §13.2: tools receive `secret://name` references and the invoker
    // resolves them inside the vault boundary, so the value never passes
    // through tool code that might log it.
    vault: security.vault,
  });

  /* ── L5: orchestration ─────────────────────────────────────────────────── */
  const snapshotter = new Snapshotter({
    events,
    persona: (who) => persona.lines(who),
    clock,
    compactor,
    memory: memory.source,
    // A function, not a value: the user can amend the contract between two
    // turns of one session, and a captured copy would render yesterday's.
    constitutionDoc: () => viewOf(constitution.current()),
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
          risk: tool.risk,
          effect: tool.effect,
        })),
    },
  });
  const runner = new Runner({
    events,
    clock,
    ids,
    logger,
    model: governedModel as never,
    modelConfigured: apiKey !== undefined && apiKey !== '',
    invoker,
    approvals,
    suspensions,
    snapshotter,
    compactor,
    observer: memory,
    // §34.10's outbox, read back (M9). Committed effects only — an
    // intended-but-unsettled effect is exactly the thing the agent must
    // not claim to have done.
    committedEffects: (runId: string) =>
      storage
        .all<{ tool: string; summary: string }>(
          `SELECT tool, summary FROM effects WHERE run_id = ? AND state = 'committed'`,
          [runId],
        )
        .map((row) => `${row.tool}: ${row.summary}`),
    dailyLedger: new DailyLedger(events, clock),
    dailyBudget: DEFAULT_DAILY_BUDGET,
  });

  /* ── L5: time and proactivity (M8) ─────────────────────────────────────── */
  // §28's promise is that proactive behaviour needs *zero kernel changes*:
  // a scheduled run is an ordinary run whose trigger happens to be
  // 'schedule'. The handler below is the whole of it.
  const ladder = new Degradation({ events, clock, principal: PRINCIPAL });
  // §27's L4: a locked vault is a real reduction in what the agent can
  // do, and the ladder is the place that is said out loud.
  if (security.keyring.state() === 'locked') {
    ladder.report('vault', 'the vault is locked; tools that need secrets will refuse');
  }
  if (apiKey === undefined || apiKey === '') {
    // Honest from the first second: with no key the agent is on its
    // offline fallback, and §27 forbids being quietly dumber than
    // yesterday without saying so.
    ladder.report('model', 'no ARISH_API_KEY is configured; answering from the offline fallback');
  }


  /** How many interactive runs are in flight. Background work waits. */
  let interactive = 0;

  const worker = new Worker({
    queue,
    schedules,
    clock,
    logger,
    busy: () => interactive > 0,
    pollIntervalMs: substrate.config.queue.pollIntervalMs,
    handlers: {
      [SCHEDULED_RUN]: async (job) => {
        const prompt = typeof job.payload.prompt === 'string' ? job.payload.prompt : '';
        const scheduleId = typeof job.payload.scheduleId === 'string' ? job.payload.scheduleId : '';
        const schedule = scheduleId === '' ? null : schedules.get(scheduleId);

        // A reminder is a one-shot schedule carrying its reminder id,
        // so the moment it actually fires is recorded here — at the
        // point where it really happened, not when it was set. "You
        // were reminded and it went past anyway" is only answerable
        // from the log if the log says it.
        const reminderId =
          typeof job.payload.reminderId === 'string' ? job.payload.reminderId : '';
        if (reminderId !== '') reminders.markFired(job.principal, reminderId);

        // One session per schedule, reused, so a recurring briefing reads
        // as a continuing thread rather than a pile of orphan sessions.
        const sessionId = scheduleSessionId(scheduleId);
        const existing = storage.get<{ id: string }>('SELECT id FROM sessions WHERE id = ?', [sessionId]);
        if (existing === undefined) {
          events.append({
            type: 'session.created',
            principal: job.principal,
            trust: 'USER',
            sessionId,
            payload: { title: schedule?.name ?? 'Scheduled' },
          });
        }

        events.append({
          type: 'message.user',
          principal: job.principal,
          trust: 'USER',
          sessionId,
          payload: { text: prompt },
        });

        await memory.prime(job.principal, sessionId, prompt).catch(() => undefined);
        const outcome = await runner.run({
          sessionId,
          principal: job.principal,
          trigger: 'schedule',
          // So the context can say *why* it is talking at 9am, which is
          // the difference between an explanation and a notification.
          triggerDetail: schedule === null ? 'a schedule' : `your schedule "${schedule.name}"`,
        });
        if (outcome.status === 'failed') {
          // Thrown, not swallowed: the queue's retry and dead-letter path
          // is the only thing standing between a flaky model and a
          // briefing that silently never arrives.
          throw new Error(`scheduled run ${outcome.runId} failed: ${outcome.reason ?? 'unknown'}`);
        }
      },
    },
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
    // Warms the recall cache with the user's own words before the run
    // assembles its context; see StoredMemorySource.
    beforeRun: (principal, sessionId, text) => memory.prime(principal, sessionId, text),
    // §22.8's user-control routes. Mandatory, not optional: a store nobody
    // can inspect is a store nobody should accept.
    memory,
    // §25's user-facing surface: read the contract, amend it, see what it
    // caught. A constitution nobody can read is a prompt with extra steps.
    constitution,
    // S1's calendar, on the same terms: a calendar the user cannot see
    // and edit directly is one they cannot trust the agent with.
    calendar,
    tasks,
    reminders,
    askBudget,
    auditor,
    // §28 + §27.
    schedules,
    queue,
    ladder,
    persona,
    vault: security.vault,
    keyring: security.keyring,
    substrate,
    dbPath: db,
    degradation: () => ladder.current(),
    onRunStart: () => {
      interactive += 1;
    },
    onRunEnd: () => {
      interactive = Math.max(0, interactive - 1);
    },
  });

  worker.start();

  const server = api.server();
  await new Promise<void>((ready) => server.listen(port, '0.0.0.0', ready));
  const bound = server.address();
  const actualPort = typeof bound === 'object' && bound !== null ? bound.port : port;

  logger.info('agent listening', {
    port: actualPort,
    db,
    model: rawModel.id,
    // Never the token itself. It is printed once, to the operator's
    // terminal, by the caller — not written to a log file that gets shipped.
    offline: apiKey === undefined || apiKey === '',
  });

  return {
    port: actualPort,
    token,
    close: async () => {
      // §28's order: refuse new work, finish what is in hand, then go.
      await worker.stop();
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
