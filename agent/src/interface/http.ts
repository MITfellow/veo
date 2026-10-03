/**
 * The HTTP interface (§29, L6).
 *
 * Node's built-in `node:http`, no framework. §29 is about twenty routes with
 * no middleware ecosystem needed, and a web framework is a ten-year
 * dependency with a CVE cadence and a migration every major version. Routing
 * is a table and a loop; see decision 016.
 *
 * M2 ships the conversational subset. Memory, vault and approval routes
 * arrive with the milestones that make them mean something.
 */
import { z } from 'zod';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, Ids, Logger } from '../substrate/ports.js';
import type { Storage } from '../substrate/ports.js';
import { Runner, type RunOutcome } from '../orchestration/runner.js';
import type { ApprovalScope, ApprovalStore } from '../capability/approvals.js';
import type { Redactor } from '../substrate/events/redact.js';
import { SseConnection, parseLastEventId, replayRun, toFrame } from './stream.js';
import type { MemoryService } from '../cognition/memory/service.js';
import type { ConstitutionStore } from '../cognition/constitution/store.js';
import { EntrenchedArticleError } from '../cognition/constitution/types.js';
import { CHECKS } from '../cognition/constitution/checks.js';
import type { AskBudget } from '../cognition/calibration/probe.js';
import type { BiasAuditor } from '../cognition/calibration/audit.js';
import { report as calibrationReport } from '../cognition/calibration/confidence.js';
import type { Schedule, ScheduleStore } from '../orchestration/schedule.js';
import { ScheduleParseError, scheduleSessionId } from '../orchestration/schedule.js';
import { IDENTITY_CARD_MAX_TOKENS } from '../cognition/context/types.js';
import type { CalendarEvent, CalendarStore } from '../cognition/calendar/store.js';
import type { Task, TaskStore } from '../cognition/tasks/store.js';
import type { Reminder, ReminderStore } from '../cognition/reminders/store.js';
import { PersonaSchema, type PersonaStore } from '../cognition/persona/store.js';
import { traceOf, renderTrace } from '../observability/trace.js';
import { computeMetrics } from '../observability/metrics.js';
import { exportAll, importAll, type ExportDocument } from '../portability/export.js';
import { verifyBackup } from '../portability/backup.js';
import type { Substrate } from '../substrate/index.js';
import type { Vault } from '../security/vault.js';
import type { Keyring } from '../security/keyring.js';
import { KeyringError, LockedError } from '../security/keyring.js';
import { VaultError } from '../security/vault.js';
import type { JobQueue } from '../orchestration/queue.js';
import { LEVEL_MEANING, type Degradation } from '../orchestration/degradation.js';
import { CronParseError } from '../orchestration/cron.js';
import { factLine } from '../cognition/memory/store.js';
import type { Fact } from '../cognition/memory/types.js';

export interface ApiDeps {
  events: EventLog;
  storage: Storage;
  clock: Clock;
  ids: Ids;
  logger: Logger;
  runner: Runner;
  /** M4. Omitted means the approval routes 404 rather than lying. */
  approvals?: ApprovalStore;
  /** Redacts the SSE stream (§13). Supply it; the default is unredacted. */
  redactor?: Redactor;
  /** Bearer token. §15: never a hardcoded user id — the token maps to one. */
  auth: { token: string; principal: string };
  degradation?: () => string;
  /**
   * Called with the user's text before the run starts (M6). The memory
   * layer uses it to run asynchronous recall ahead of synchronous context
   * assembly. Optional, and its rejection is swallowed by design.
   */
  beforeRun?: (principal: string, sessionId: string, text: string) => Promise<void>;
  /**
   * The memory store, for §22.8's user-control routes. Omitted means those
   * routes 404 rather than pretending the agent has no memory.
   */
  memory?: MemoryService;
  /**
   * §25's constitution. Omitted means the routes 404 — but `main.ts` always
   * passes it: an agent whose contract the user cannot read is exactly the
   * "prompt in a textarea" this milestone exists to replace.
   */
  constitution?: ConstitutionStore;
  /** §24.2's ask budget, for the calibration panel. */
  askBudget?: AskBudget;
  /** §24.3's bias audit. */
  auditor?: BiasAuditor;
  /**
   * Called when an interactive run starts and ends (M8).
   *
   * §28: "interactive runs always have strict priority over background
   * jobs". The worker implements that by not leasing while one is in
   * flight, and this is how it finds out.
   */
  onRunStart?: () => void;
  onRunEnd?: () => void;
  /** §28's scheduler and queue (M8). Omitted → those routes 404. */
  schedules?: ScheduleStore;
  queue?: JobQueue;
  /** §27's ladder. The `degradation` function above reads from it. */
  ladder?: Degradation;
  /** §29's persona (M9). */
  persona?: PersonaStore;
  /** S1's calendar. Omitted → the calendar routes 404. */
  calendar?: CalendarStore;
  /** S2's task list, on the same terms. */
  tasks?: TaskStore;
  /** S3's reminders. Omitted → the reminder routes 404. */
  reminders?: ReminderStore;
  /**
   * §13's vault and keyring (M9). Omitted → the vault routes 404, which is
   * the honest answer for a build that has no secret storage wired.
   */
  vault?: Vault;
  keyring?: Keyring;
  /**
   * The whole substrate plus its file path, for §29's portability routes.
   * Nothing else in the API needs them, which is why they are separate
   * from `storage`/`events`: export, import and backup verification are
   * the only operations that are about the database rather than about
   * what is in it.
   */
  substrate?: Substrate;
  dbPath?: string;
}

/** §29: `{ decision, scope }`. Validated like every other boundary. */
const ApprovalDecisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  scope: z.enum(['once', 'session', 'shape', 'always']).default('once'),
  reason: z.string().max(500).optional(),
  /** Fields to pin when scope is 'shape'. */
  pin: z.array(z.string()).optional(),
});

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  principal: string;
  body: () => Promise<unknown>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  /** `/sessions/:id/messages` */
  pattern: string;
  handler: Handler;
  /** Health must answer even when auth is misconfigured. */
  public?: boolean;
}

/** §22.8's list filters, validated like every other boundary. */
const MemoryQuery = z.object({
  q: z.string().max(200).optional(),
  basis: z.enum(['observed', 'inferred', 'asserted_by_user', 'imported']).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  status: z.enum(['active', 'disputed', 'quarantined', 'retired', 'all']).default('active'),
  pinned: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const SecretBody = z.object({
  name: z.string().min(1).max(64),
  value: z.string().min(1).max(8192),
  label: z.string().max(120).optional(),
});

/**
 * A locked vault is 423, not 500. The difference matters to a client: one
 * means "unlock and retry", the other means "something is broken".
 */
function vaultError(res: ServerResponse, error: unknown): void {
  if (error instanceof LockedError) {
    return json(res, 423, { error: 'locked', detail: 'the vault is locked — unlock it first' });
  }
  if (error instanceof KeyringError) {
    return json(res, 400, { error: 'keyring', detail: error.message });
  }
  if (error instanceof VaultError) {
    return json(res, 400, { error: 'vault', detail: error.message });
  }
  throw error;
}

const CreateScheduleBody = z.object({
  name: z.string().min(1).max(120),
  /** A 5-field cron spec, or an instant for a one-shot. */
  spec: z.string().min(1).max(120),
  timezone: z.string().max(64).optional(),
  prompt: z.string().min(1).max(2000),
  catchUp: z.enum(['fire-all', 'fire-once', 'skip']).optional(),
  kind: z.enum(['cron', 'once']).optional(),
});

const UpdateScheduleBody = z.object({
  spec: z.string().min(1).max(120).optional(),
  timezone: z.string().max(64).optional(),
  catchUp: z.enum(['fire-all', 'fire-once', 'skip']).optional(),
  enabled: z.boolean().optional(),
});

const CalendarQuery = z.object({
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
});

const CreateEventBody = z.object({
  title: z.string().min(1).max(200),
  startsAt: z.number().int(),
  endsAt: z.number().int().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
  location: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const CreateTaskBody = z.object({
  title: z.string().min(1).max(200),
  dueAt: z.number().int().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const PatchTaskBody = z.object({ done: z.boolean() });

const PostReminderBody = z.object({
  text: z.string().min(1).max(200),
  /** Epoch ms. The client resolves "20 minutes before" into an instant. */
  remindAt: z.number().int(),
  ownerKind: z.enum(['task', 'event']),
  ownerId: z.string().min(1).max(64),
});

/** The wire shape of a task. */
function taskView(task: Task) {
  return {
    id: task.id,
    title: task.title,
    note: task.note,
    dueAt: task.dueAt,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    droppedAt: task.droppedAt,
    done: task.completedAt !== null,
  };
}

/** The wire shape of a reminder. */
function reminderView(reminder: Reminder) {
  return {
    id: reminder.id,
    text: reminder.text,
    remindAt: reminder.remindAt,
    ownerKind: reminder.ownerKind,
    ownerId: reminder.ownerId,
    // One derived field rather than making the client work it out from
    // two nullable timestamps: three copies of that rule would drift.
    state:
      reminder.cancelledAt !== null
        ? 'cancelled'
        : reminder.firedAt !== null
          ? 'fired'
          : 'pending',
    cancelledAt: reminder.cancelledAt,
    firedAt: reminder.firedAt,
  };
}

/** The wire shape of a calendar event — camelCase, no principal. */
function eventView(event: CalendarEvent) {
  return {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    timezone: event.timezone,
    location: event.location,
    notes: event.notes,
    createdAt: event.createdAt,
    cancelledAt: event.cancelledAt,
  };
}

function scheduleView(schedule: Schedule) {
  return {
    id: schedule.id,
    name: schedule.name,
    kind: schedule.kind,
    spec: schedule.spec,
    timezone: schedule.timezone,
    prompt: typeof schedule.payload.prompt === 'string' ? schedule.payload.prompt : '',
    catchUp: schedule.catchUp,
    enabled: schedule.enabled,
    lastFiredAt: schedule.lastFiredAt,
    nextFireAt: schedule.nextFireAt,
    fireCount: schedule.fireCount,
    missedCount: schedule.missedCount,
  };
}

export class Api {
  private readonly routes: Route[] = [];
  /** Live runs, so SSE can attach to a run already in flight. */
  private readonly live = new Map<string, Set<(frame: ReturnType<typeof toFrame>) => void>>();

  constructor(private readonly deps: ApiDeps) {
    this.registerRoutes();

    // One hook for all runs: the runner emits chunks, the API fans them out
    // to whoever is listening. The runner knows nothing about HTTP.
    deps.runner.onChunk = (runId, _stepId, chunk) => {
      if (chunk.type !== 'text-delta') return;
      const listeners = this.live.get(runId);
      if (listeners === undefined) return;
      for (const listener of listeners) {
        listener({ id: -1, event: 'delta', data: { text: chunk.text } });
      }
    };
  }

  server(): Server {
    return createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const match = this.match(req.method ?? 'GET', url.pathname);

    if (match === null) {
      return json(res, 404, { error: 'not_found', path: url.pathname });
    }

    if (match.route.public !== true) {
      const principal = this.authenticate(req);
      if (principal === null) {
        // §15: every auth decision is auditable.
        this.deps.events.append({
          type: 'error.raised',
          payload: {
            kind: 'auth',
            message: `rejected ${req.method} ${url.pathname}: missing or invalid bearer token`,
            fatal: false,
          },
          principal: 'system',
          trust: 'SYSTEM',
        });
        return json(res, 401, {
          error: 'unauthorized',
          detail: 'Send Authorization: Bearer <token>.',
        });
      }
      return this.invoke(match.route, req, res, url, match.params, principal);
    }

    return this.invoke(match.route, req, res, url, match.params, 'anonymous');
  }

  private async invoke(
    route: Route,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    params: Record<string, string>,
    principal: string,
  ): Promise<void> {
    try {
      await route.handler({ req, res, url, params, principal, body: () => readJson(req) });
    } catch (err) {
      const error = err as Error;
      this.deps.logger.error('request failed', { path: url.pathname, message: error.message });
      if (!res.headersSent) json(res, 500, { error: 'internal', detail: error.message });
      else res.end();
    }
  }

  private authenticate(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (header === undefined) return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || token === undefined) return null;
    // Constant-time compare so a token cannot be recovered by timing.
    if (!safeEqual(token, this.deps.auth.token)) return null;
    return this.deps.auth.principal;
  }

  private match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const pattern = route.pattern.split('/').filter(Boolean);
      if (pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < pattern.length; i++) {
        const segment = pattern[i]!;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]!);
        else if (segment !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private add(method: string, pattern: string, handler: Handler, isPublic = false): void {
    this.routes.push({ method, pattern, handler, ...(isPublic ? { public: true } : {}) });
  }

  /* ──────────────────────────────── routes ──────────────────────────────── */

  private registerRoutes(): void {
    const { events, storage, ids, runner } = this.deps;

    this.add('GET', '/health', ({ res }) => {
      json(res, 200, {
        status: 'ok',
        degradation: this.deps.degradation?.() ?? 'L0',
        events: storage.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')?.n ?? 0,
      });
    }, true);

    this.add('POST', '/sessions', async ({ res, body, principal }) => {
      const input = (await body()) as { title?: string } | null;
      const sessionId = ids.ulid();
      events.append({
        type: 'session.created',
        payload: { title: input?.title ?? null, source: 'api' },
        principal,
        trust: 'USER',
        sessionId,
      });
      json(res, 201, { id: sessionId, title: input?.title ?? null });
    });

    this.add('GET', '/sessions', ({ res, url }) => {
      const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
      const rows = storage.all(
        'SELECT id, title, created_at, updated_at, message_count FROM sessions ' +
          'WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?',
        [limit],
      );
      json(res, 200, { sessions: rows });
    });

    this.add('GET', '/sessions/:id', ({ res, params }) => {
      const session = storage.get('SELECT * FROM sessions WHERE id = ?', [params.id!]);
      if (session === undefined) return json(res, 404, { error: 'no_such_session' });
      const messages = storage.all(
        'SELECT id, role, text, ts, trust FROM messages WHERE session_id = ? ORDER BY seq',
        [params.id!],
      );
      json(res, 200, { session, messages });
    });

    this.add('POST', '/sessions/:id/messages', async ({ res, params, body, principal }) => {
      const input = (await body()) as { text?: string } | null;
      const text = input?.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return json(res, 400, { error: 'bad_request', detail: 'text is required' });
      }
      const sessionId = params.id!;
      if (storage.get('SELECT id FROM sessions WHERE id = ?', [sessionId]) === undefined) {
        return json(res, 404, { error: 'no_such_session' });
      }

      events.append({
        type: 'message.user',
        payload: { text, attachments: [] },
        principal,
        trust: 'USER',
        sessionId,
      });

      // The run id has to be known *before* the run starts, or the client
      // cannot subscribe to a stream it is about to miss the start of.
      const runId = ids.ulid();
      // Memory gets first sight of the turn so recall can run its
      // asynchronous path (embeddings) before the synchronous context
      // assembly asks for it. Failure here is not fatal: recall degrades to
      // the lexical fallback rather than the request failing.
      const primed = this.deps.beforeRun?.(principal, sessionId, text) ?? Promise.resolve();
      const started = primed
        .catch(() => undefined)
        .then(() => runner.run({ sessionId, principal, trigger: 'user', runId }));
      this.track(runId, started);

      json(res, 202, { runId, sessionId });
    });

    this.add('GET', '/runs/:id/stream', async (ctx) => {
      const runId = ctx.params.id!;
      const after = parseLastEventId(ctx.req.headers['last-event-id']);

      // Declared before the connection so `onClose` can reference it.
      let connection: SseConnection;
      const listener = (frame: ReturnType<typeof toFrame>): void => {
        if (frame !== null) void connection.send(frame);
      };

      connection = new SseConnection({
        res: ctx.res,
        clock: this.deps.clock,
        // The third exit from the system, after the log and the invoker.
        // Live deltas never pass through the log, so without this a secret
        // the model is mid-sentence quoting would stream straight out.
        ...(this.deps.redactor !== undefined ? { redactor: this.deps.redactor } : {}),
        onClose: () => this.untrack(runId, listener),
      });

      // Replay first, live second, and in that order: anything that happened
      // before the client connected (or while it was asleep) comes out of the
      // log, so a reconnect loses nothing.
      for (const frame of replayRun(events, runId, after)) {
        await connection.send(frame);
      }

      const terminal = storage.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', [
        runId,
      ]);
      if (terminal !== undefined && terminal.state !== 'running') {
        await connection.close();
        return;
      }

      this.listen(runId, listener);

      const settled = this.inflight.get(runId);
      if (settled !== undefined) {
        await settled;
        // The terminal frames were appended to the log by the runner; send
        // whatever the client has not seen yet.
        for (const frame of replayRun(events, runId, after)) {
          if (frame.event === 'done' || frame.event === 'error' || frame.event === 'cancelled') {
            await connection.send(frame);
          }
        }
      }
      this.untrack(runId, listener);
      await connection.close();
    });

    this.add('POST', '/runs/:id/cancel', ({ res, params, principal }) => {
      const cancelled = runner.cancel(params.id!, principal);
      json(res, cancelled ? 202 : 409, {
        runId: params.id,
        cancelled,
        ...(cancelled ? {} : { detail: 'run is not currently executing' }),
      });
    });

    /* ── approvals (§29) ──────────────────────────────────────────────── */

    this.add('GET', '/approvals', ({ res }) => {
      const approvals = this.deps.approvals;
      if (approvals === undefined) return json(res, 404, { error: 'approvals_not_configured' });
      // Expire first: showing someone a question that can no longer be
      // answered wastes the one bit of attention this mechanism gets.
      approvals.expireStale();
      json(res, 200, {
        approvals: approvals.pending().map((record) => ({
          id: record.id,
          runId: record.runId,
          tool: record.tool,
          preview: record.preview,
          risk: record.risk,
          requestedAt: record.requestedAt,
          expiresAt: record.expiresAt,
        })),
      });
    });

    this.add('POST', '/approvals/:id', async ({ res, params, principal, body }) => {
      const approvals = this.deps.approvals;
      if (approvals === undefined) return json(res, 404, { error: 'approvals_not_configured' });

      const parsed = ApprovalDecisionBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, {
          error: 'invalid_body',
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }

      const record = approvals.get(params.id!);
      if (record === undefined) return json(res, 404, { error: 'no_such_approval' });
      if (record.state !== 'pending') {
        return json(res, 409, {
          error: 'already_answered',
          state: record.state,
          detail: 'a change of mind is a new request',
        });
      }

      approvals.decide(params.id!, {
        granted: parsed.data.decision === 'approve',
        scope: parsed.data.scope as ApprovalScope,
        by: principal,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.pin !== undefined ? { pin: parsed.data.pin } : {}),
      });

      // Resuming is the slow part, and the caller does not need to wait for
      // the model. 202 plus the run id, exactly like sending a message.
      void this.deps.runner.resume(params.id!).catch((err: unknown) => {
        this.deps.logger.error('resume failed', {
          approvalId: params.id,
          message: (err as Error).message,
        });
      });

      json(res, 202, { approvalId: params.id, runId: record.runId, resumed: true });
    });

    this.add('GET', '/runs/:id/trace', ({ res, params, url }) => {
      const runId = params.id!;
      const all = events.read({ runId });
      if (all.length === 0) return json(res, 404, { error: 'no_such_run' });

      // §30: "renderable as readable text". The same data either way — the
      // text form is built from the structured one, so the two can never
      // tell different stories about the same run.
      const structured = traceOf(runId, all);
      if (url.searchParams.get('format') === 'text') {
        const body = renderTrace(structured!);
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }

      json(res, 200, {
        trace: structured,
        runId,
        // §30: the trace is rendered from the log, which is why it is
        // available for a run that finished years ago.
        events: all.map((e) => ({
          seq: e.seq,
          ts: e.ts,
          type: e.type,
          trust: e.trust,
          stepId: e.stepId,
          payload: e.payload,
        })),
        steps: storage.all('SELECT * FROM steps WHERE run_id = ? ORDER BY idx', [runId]),
      });
    });

    /* ───────────────────── §22.8 — what the agent knows ──────────────────── */

    // These are not an admin panel. §22.8: "a person only lets an agent this
    // deep into their life if they can see and rip out what it knows." The
    // routes exist so the Veo client can show someone their own memory and
    // destroy any of it, without asking the agent nicely in conversation.

    const memory = this.deps.memory;

    this.add('GET', '/memory', ({ res, url, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      const parsed = MemoryQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) {
        return json(res, 400, { error: 'bad_request', detail: parsed.error.issues });
      }
      const query = parsed.data;

      const all = memory.store.allFacts(principal, {
        includeInactive: query.status !== 'active',
      });
      const matched = all.filter((fact) => {
        if (query.status !== 'all' && fact.status !== query.status) return false;
        if (query.basis !== undefined && fact.basis !== query.basis) return false;
        if (query.minConfidence !== undefined && fact.confidence < query.minConfidence) return false;
        if (query.pinned !== undefined && fact.pinned !== (query.pinned === 'true')) return false;
        if (query.q !== undefined && query.q !== '') {
          const haystack = `${factLine(fact)} ${fact.predicate}`.toLowerCase();
          if (!haystack.includes(query.q.toLowerCase())) return false;
        }
        return true;
      });

      json(res, 200, {
        facts: matched.slice(0, query.limit).map(summarise),
        total: matched.length,
        // The counts the UI needs to be honest about what it is not showing.
        counts: {
          active: all.filter((fact) => fact.status === 'active').length,
          disputed: all.filter((fact) => fact.status === 'disputed').length,
          quarantined: all.filter((fact) => fact.status === 'quarantined').length,
          retired: all.filter((fact) => fact.status === 'retired').length,
          pinned: all.filter((fact) => fact.pinned).length,
        },
      });
    });

    // §29 names this one and nothing had needed it until the client
    // wanted to show the user the card the model actually sees.
    this.add('GET', '/memory/identity-card', ({ res, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      const card = memory.store.identityCard(principal);
      json(res, 200, {
        card,
        // The same cap the context applies, stated rather than implied, so
        // a user reading this page knows they are seeing all of it.
        maxTokens: IDENTITY_CARD_MAX_TOKENS,
      });
    });

    this.add('GET', '/memory/digest', ({ res, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      // Build the card if consolidation has not run yet, rather than
      // showing someone an empty panel for their first twelve episodes.
      // It is a pure function of the store, so computing it on demand costs
      // nothing and is never stale.
      const identity =
        memory.store.identityCard(principal) ??
        (memory.store.recallable(principal, 1).length > 0
          ? memory.consolidator.identityCard(principal, this.deps.clock.now())
          : null);
      json(res, 200, {
        entries: memory.store.digest(principal, 10),
        identity: identity === null ? null : { text: identity.text, updatedAt: this.deps.clock.now() },
      });
    });

    this.add('GET', '/memory/export', ({ res, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      // Everything, including what was retired and what was refused. An
      // export that quietly omits the inconvenient parts is not an export.
      const facts = memory.store.allFacts(principal, { includeInactive: true });
      json(res, 200, {
        exportedAt: this.deps.clock.now(),
        principal,
        facts: facts.map((fact) => ({
          ...fact,
          text: factLine(fact),
          history: memory.store.history(fact.id).map((version) => ({
            text: factLine(version),
            recordedAt: version.recordedAt,
            confidence: version.confidence,
            status: version.status,
          })),
        })),
        rules: memory.store.allRules(principal),
        refused: memory.store.rejections(principal, 200),
      });
    });

    this.add('GET', '/memory/:id', ({ res, params }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      // `getAny`, not `get`: a corrected or retired belief is hidden from
      // the agent but must stay visible to the person auditing it.
      const fact = memory.store.getAny(params.id!);
      if (fact === undefined) return json(res, 404, { error: 'no_such_fact' });

      // §22.8's "explain": source text, date, confidence, reasoning chain,
      // in plain language. The chain is the point — a confidence number with
      // no story behind it is the thing §24.1 calls a lie with a decimal.
      json(res, 200, {
        fact: summarise(fact),
        sources: fact.sources,
        history: memory.store.history(fact.id).map((version) => ({
          text: factLine(version),
          recordedAt: version.recordedAt,
          validFrom: version.validFrom,
          validTo: version.validTo,
          confidence: version.confidence,
          status: version.status,
        })),
        explanation: explain(fact),
      });
    });

    this.add('POST', '/memory/:id/pin', async ({ res, params, body, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      const input = (await body()) as { pinned?: boolean } | null;
      if (memory.store.get(params.id!) === undefined) {
        return json(res, 404, { error: 'no_such_fact' });
      }
      const pinned = input?.pinned ?? true;
      memory.store.pin(params.id!, pinned, principal, 'USER');
      json(res, 200, { id: params.id, pinned });
    });

    this.add('POST', '/memory/:id/correct', async ({ res, params, body, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      const input = (await body()) as { correction?: string } | null;
      const correction = input?.correction;
      if (typeof correction !== 'string' || correction.trim() === '') {
        return json(res, 400, { error: 'bad_request', detail: 'correction is required' });
      }
      const fact = memory.store.get(params.id!);
      if (fact === undefined) return json(res, 404, { error: 'no_such_fact' });

      memory.store.correct({
        factId: fact.id,
        principal,
        trust: 'USER',
        was: fact.object,
        now: correction,
        by: 'user',
      });
      // The replacement outranks whatever it replaced: the user said it.
      const id = memory.store.write({
        principal,
        subject: fact.subject,
        predicate: fact.predicate,
        object: correction,
        basis: 'asserted_by_user',
        confidence: 0.9,
        sources: fact.sources,
        trust: 'USER',
        stability: fact.stability,
        sensitivity: fact.sensitivity,
      });
      json(res, 200, { corrected: fact.id, replacement: id });
    });

    this.add('DELETE', '/memory/:id', ({ res, params, url, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      if (memory.store.get(params.id!) === undefined) {
        return json(res, 404, { error: 'no_such_fact' });
      }
      const reason = url.searchParams.get('reason') ?? 'the user deleted it';
      memory.store.forget(params.id!, reason, principal, 'USER');
      // 200, not 204: the client needs to be told the content is destroyed
      // rather than hidden, and a bare 204 says nothing.
      json(res, 200, { forgotten: params.id, shredded: true });
    });

    this.add('DELETE', '/memory', ({ res, url, principal }) => {
      if (memory === undefined) return json(res, 404, { error: 'no_memory' });
      const subject = url.searchParams.get('subject');
      if (subject === null) {
        return json(res, 400, {
          error: 'bad_request',
          detail: "refusing to forget everything without a subject; pass ?subject=self or an entity id",
        });
      }
      const reason = url.searchParams.get('reason') ?? `the user asked to forget ${subject}`;
      // No limit here: "forget everything about X" must mean everything.
      const targets = memory.store.bySubject(subject, {
        includeInactive: true,
        limit: 1_000_000,
      });
      for (const fact of targets) memory.store.forget(fact.id, reason, principal, 'USER');
      json(res, 200, { forgotten: targets.map((fact) => fact.id), shredded: true });
    });

    /* ──────────────────── §25 — the constitution ──────────────────────── */

    // The document is the agent's terms of employment, and §25's promise is
    // that every change to it is answerable. These routes are how a person
    // reads those terms, rewrites them, and sees what they caught — without
    // having to ask the agent, whose account of its own rules is exactly the
    // thing that should not be load-bearing.

    const constitution = this.deps.constitution;

    this.add('GET', '/constitution', ({ res }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      const doc = constitution.current();
      json(res, 200, {
        version: doc.version,
        hash: doc.hash,
        ratifiedAt: doc.ratifiedAt,
        articles: doc.live.map((a) => ({
          id: a.id,
          text: a.text,
          origin: a.origin,
          kind: a.kind,
          enforcement: a.enforcement,
          check: a.check,
          checkDescribes: a.check === null ? null : (CHECKS[a.check]?.describes ?? null),
          checkMisses: a.check === null ? null : (CHECKS[a.check]?.misses ?? null),
          remedy: a.remedy,
          enforcedBy: a.enforcedBy,
          entrenched: a.entrenched,
          subject: a.subject,
          stance: a.stance,
          cites: a.cites,
          supersededBy: a.supersededBy ?? null,
          addedVersion: a.addedVersion,
        })),
        conflicts: doc.conflicts,
        proposals: constitution.proposals('pending'),
      });
    });

    this.add('GET', '/constitution/history', ({ res }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      json(res, 200, { history: constitution.history(200) });
    });

    this.add('POST', '/constitution/articles', async ({ res, body, principal }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      const input = (await body()) as Record<string, unknown> | null;
      const text = typeof input?.text === 'string' ? input.text.trim() : '';
      if (text === '') return json(res, 400, { error: 'bad_request', detail: 'text is required' });
      try {
        const doc = constitution.adopt(principal, {
          ...(typeof input?.id === 'string' ? { id: input.id } : {}),
          text,
          origin: 'user',
          kind: (input?.kind as 'directive') ?? 'directive',
          enforcement: 'advisory',
          subject: typeof input?.subject === 'string' ? input.subject : 'general',
          stance: (input?.stance as 'require') ?? 'require',
          cites: 'written by the principal',
        });
        json(res, 201, { version: doc.version, hash: doc.hash, conflicts: doc.conflicts });
      } catch (error) {
        if (error instanceof EntrenchedArticleError) {
          return json(res, 409, { error: 'entrenched', article: error.articleId, cites: error.cites, detail: error.message });
        }
        throw error;
      }
    });

    this.add('PUT', '/constitution', async ({ res, body, principal }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      const input = (await body()) as { articles?: { id?: string; text?: string; subject?: string }[] } | null;
      const articles = (input?.articles ?? [])
        .filter((a): a is { id?: string; text: string; subject?: string } => typeof a.text === 'string' && a.text.trim() !== '')
        .map((a) => ({
          ...(a.id === undefined ? {} : { id: a.id }),
          text: a.text.trim(),
          origin: 'user' as const,
          kind: 'directive' as const,
          enforcement: 'advisory' as const,
          subject: a.subject ?? 'general',
          cites: 'written by the principal',
        }));
      const doc = constitution.replaceUserArticles(principal, articles);
      json(res, 200, { version: doc.version, hash: doc.hash, conflicts: doc.conflicts });
    });

    this.add('DELETE', '/constitution/articles/:id', ({ res, params, principal }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      try {
        const doc = constitution.repeal(principal, params.id!);
        json(res, 200, { version: doc.version, hash: doc.hash, repealed: params.id });
      } catch (error) {
        if (error instanceof EntrenchedArticleError) {
          // 409, not 403: the request is not unauthorised, it is impossible.
          // The article describes what the code does, and the code is not
          // changing because a row changed.
          return json(res, 409, { error: 'entrenched', article: error.articleId, cites: error.cites, detail: error.message });
        }
        return json(res, 404, { error: 'no_such_article', detail: String(error) });
      }
    });

    this.add('POST', '/constitution/proposals/:id/dismiss', ({ res, params, principal }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      try {
        constitution.dismiss(principal, params.id!);
        json(res, 200, { dismissed: params.id });
      } catch {
        json(res, 404, { error: 'no_such_proposal' });
      }
    });

    this.add('POST', '/constitution/proposals/:id/ratify', ({ res, params, principal }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      try {
        const doc = constitution.ratifyProposal(principal, params.id!);
        json(res, 200, { version: doc.version, hash: doc.hash });
      } catch {
        json(res, 404, { error: 'no_such_proposal' });
      }
    });

    this.add('GET', '/constitution/compliance', ({ res, url }) => {
      if (constitution === undefined) return json(res, 404, { error: 'no_constitution' });
      const days = Number(url.searchParams.get('days') ?? '14');
      const from = this.deps.clock.now() - days * 86_400_000;
      const rows = this.deps.storage.all<{
        article_id: string;
        check_id: string;
        verdict: string;
        n: number;
      }>(
        `SELECT article_id, check_id, verdict, COUNT(*) AS n
           FROM constitution_enforcements WHERE at >= ?
          GROUP BY article_id, check_id, verdict`,
        [from],
      );
      const byArticle = new Map<string, { articleId: string; check: string; upheld: number; violated: number; unverifiable: number }>();
      for (const row of rows) {
        const entry = byArticle.get(row.article_id) ?? {
          articleId: row.article_id,
          check: row.check_id,
          upheld: 0,
          violated: 0,
          unverifiable: 0,
        };
        if (row.verdict === 'upheld') entry.upheld += row.n;
        else if (row.verdict === 'violated') entry.violated += row.n;
        else entry.unverifiable += row.n;
        byArticle.set(row.article_id, entry);
      }
      const recent = this.deps.storage.all<{
        at: number;
        article_id: string;
        detail: string;
        remedy: string;
      }>(
        `SELECT at, article_id, detail, remedy FROM constitution_enforcements
          WHERE verdict = 'violated' AND at >= ? ORDER BY at DESC LIMIT 20`,
        [from],
      );
      json(res, 200, { windowDays: days, articles: [...byArticle.values()], recentViolations: recent });
    });

    /* ──────────────────── §24 — calibration and bias ──────────────────── */

    this.add('GET', '/calibration', ({ res, url, principal }) => {
      const askBudget = this.deps.askBudget;
      const auditor = this.deps.auditor;
      if (askBudget === undefined || auditor === undefined) {
        return json(res, 404, { error: 'no_calibration' });
      }
      const days = Number(url.searchParams.get('days') ?? '30');
      const from = this.deps.clock.now() - days * 86_400_000;
      const resolutions = askBudget.resolutions(principal, from);
      const state = askBudget.state(principal);
      json(res, 200, {
        calibration: calibrationReport(resolutions, state.pending, {
          from,
          to: this.deps.clock.now(),
        }),
        probes: state,
        // `write: false` — reading the panel must not write an audit event,
        // or the metrics would measure how often the user looked at them.
        bias: auditor.run(principal, { write: false }),
      });
    });


    /* ─────────────────── §30 — metrics, §13.5 — backups ───────────────── */

    this.add('GET', '/metrics', ({ res, url }) => {
      const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? '30'), 1), 365);
      json(
        res,
        200,
        computeMetrics(
          { storage: this.deps.storage, events: this.deps.events, now: this.deps.clock.now() },
          days,
        ),
      );
    });

    this.add('POST', '/export', ({ res }) => {
      const substrate = this.deps.substrate;
      if (substrate === undefined) return json(res, 404, { error: 'no_substrate' });
      // Secrets leave as ciphertext with their wrapped keys. §13 does not
      // have a portability exception (decision 038).
      json(res, 200, exportAll(substrate));
    });

    this.add('POST', '/import', async ({ res, body }) => {
      const substrate = this.deps.substrate;
      if (substrate === undefined) return json(res, 404, { error: 'no_substrate' });
      const doc = (await body()) as ExportDocument;
      const outcome = importAll(substrate, doc);
      json(res, outcome.ok ? 200 : 409, outcome);
    });

    this.add('POST', '/backup/verify', ({ res }) => {
      const substrate = this.deps.substrate;
      const dbPath = this.deps.dbPath;
      if (substrate === undefined || dbPath === undefined) {
        return json(res, 404, { error: 'no_substrate' });
      }
      // §13.5: an untested backup is a rumor. This is the test.
      json(res, 200, verifyBackup({ live: substrate, dbPath, now: this.deps.clock.now() }));
    });

    /* ───────────────────────── §13 — the vault ────────────────────────── */

    // Names and metadata only, ever. There is no route that returns a
    // secret value, and that is not an oversight to be fixed later: a
    // value that can be fetched over HTTP is a value that lives outside
    // the vault boundary the moment someone adds a logger.

    const vault = this.deps.vault;
    const keyring = this.deps.keyring;

    this.add('GET', '/vault/secrets', ({ res }) => {
      if (vault === undefined || keyring === undefined) return json(res, 404, { error: 'no_vault' });
      json(res, 200, { state: keyring.state(), secrets: vault.list() });
    });

    this.add('POST', '/vault/secrets', async ({ res, body, principal }) => {
      if (vault === undefined) return json(res, 404, { error: 'no_vault' });
      const parsed = SecretBody.safeParse(await body());
      if (!parsed.success) return json(res, 400, { error: 'bad_request', detail: parsed.error.issues });
      try {
        const ref = await vault.create(parsed.data.name, parsed.data.value, {
          principal,
          ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
        });
        json(res, 201, { ref: `secret://${ref.name}#${ref.version}` });
      } catch (error) {
        return vaultError(res, error);
      }
    });

    this.add('POST', '/vault/secrets/:name/rotate', async ({ res, params, body, principal }) => {
      if (vault === undefined) return json(res, 404, { error: 'no_vault' });
      const parsed = z.object({ value: z.string().min(1).max(8192) }).safeParse(await body());
      if (!parsed.success) return json(res, 400, { error: 'bad_request' });
      try {
        const ref = await vault.rotate(params.name ?? '', parsed.data.value, { principal });
        json(res, 200, { ref: `secret://${ref.name}#${ref.version}` });
      } catch (error) {
        return vaultError(res, error);
      }
    });

    this.add('DELETE', '/vault/secrets/:name', ({ res, params, principal }) => {
      if (vault === undefined) return json(res, 404, { error: 'no_vault' });
      try {
        const destroyed = vault.destroy(params.name ?? '', 'all', { principal });
        json(res, destroyed > 0 ? 200 : 404, { destroyed });
      } catch (error) {
        return vaultError(res, error);
      }
    });

    this.add('POST', '/vault/unlock', async ({ res, body }) => {
      if (keyring === undefined) return json(res, 404, { error: 'no_vault' });
      const parsed = z.object({ passphrase: z.string().min(1).max(512) }).safeParse(await body());
      if (!parsed.success) return json(res, 400, { error: 'bad_request' });
      try {
        if (keyring.state() === 'uninitialized') {
          const result = await keyring.initialize(parsed.data.passphrase);
          await keyring.unlock(parsed.data.passphrase);
          // Shown exactly once, and never stored anywhere we can read it.
          return json(res, 201, { state: keyring.state(), recoveryCode: result.recoveryCode });
        }
        await keyring.unlock(parsed.data.passphrase);
        json(res, 200, { state: keyring.state() });
      } catch (error) {
        return vaultError(res, error);
      }
    });

    this.add('POST', '/vault/lock', ({ res }) => {
      if (keyring === undefined) return json(res, 404, { error: 'no_vault' });
      keyring.lock();
      json(res, 200, { state: keyring.state() });
    });

    this.add('POST', '/vault/panic', async ({ res, body }) => {
      if (keyring === undefined) return json(res, 404, { error: 'no_vault' });
      // Irreversible, so it needs the word typed out. A confirmation
      // dialog can be clicked through; a required literal cannot be
      // clicked through by accident.
      const parsed = z.object({ confirm: z.literal('destroy my secrets') }).safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, {
          error: 'confirmation_required',
          detail:
            'This destroys the keyring. Every secret becomes permanently unreadable, ' +
            'including in every backup that already exists. Send { "confirm": "destroy my secrets" }.',
        });
      }
      keyring.panic();
      json(res, 200, { state: keyring.state(), destroyed: true });
    });

    /* ─────────────────────────── §29 — persona ────────────────────────── */

    // Voice, not rules. The constitution is what the agent may do; this is
    // how it sounds doing it (decision 036). A whole-document PUT, because
    // a partial update of six fields is a merge nobody can read back.

    this.add('GET', '/persona', ({ res, principal }) => {
      const persona = this.deps.persona;
      if (persona === undefined) return json(res, 404, { error: 'no_persona' });
      const current = persona.get(principal);
      json(res, 200, { persona: current, rendered: persona.lines(principal) });
    });

    this.add('PUT', '/persona', async ({ res, body, principal }) => {
      const persona = this.deps.persona;
      if (persona === undefined) return json(res, 404, { error: 'no_persona' });
      const parsed = PersonaSchema.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_persona', detail: parsed.error.issues });
      }
      const saved = persona.put(principal, parsed.data);
      json(res, 200, { persona: saved, rendered: persona.lines(principal) });
    });

    /* ──────────────────────── S1 — the calendar ─────────────────────── */

    // Local by construction: these read and write the agent's own event
    // log. There is no connector behind them and nothing leaves the box.

    const calendar = this.deps.calendar;

    this.add('GET', '/calendar', ({ res, url, principal }) => {
      if (calendar === undefined) return json(res, 404, { error: 'no_calendar' });
      const parsed = CalendarQuery.safeParse({
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
      });
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_window', detail: parsed.error.issues });
      }
      if (parsed.data.q !== undefined && parsed.data.q !== '') {
        return json(res, 200, { events: calendar.find(principal, parsed.data.q).map(eventView) });
      }
      const window = {
        ...(parsed.data.from === undefined ? {} : { from: parsed.data.from }),
        ...(parsed.data.to === undefined ? {} : { to: parsed.data.to }),
      };
      json(res, 200, { events: calendar.list(principal, window).map(eventView) });
    });

    this.add('POST', '/calendar', async ({ res, body, principal }) => {
      if (calendar === undefined) return json(res, 404, { error: 'no_calendar' });
      const parsed = CreateEventBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_event', detail: parsed.error.issues });
      }
      try {
        const created = calendar.add(principal, {
          title: parsed.data.title,
          startsAt: parsed.data.startsAt,
          ...(parsed.data.endsAt === undefined ? {} : { endsAt: parsed.data.endsAt }),
          ...(parsed.data.allDay === undefined ? {} : { allDay: parsed.data.allDay }),
          ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
          ...(parsed.data.location === undefined ? {} : { location: parsed.data.location }),
          ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
        });
        json(res, 201, {
          ...eventView(created),
          // Reported, never enforced — see the tool.
          conflicts: calendar
            .conflicts(principal, created.startsAt, created.endsAt, created.id)
            .map((other) => ({ id: other.id, title: other.title })),
        });
      } catch (error) {
        // A backwards end or an unknown timezone is the caller's mistake.
        json(res, 400, {
          error: 'invalid_event',
          detail: error instanceof Error ? error.message : 'the event could not be added',
        });
      }
    });

    this.add('DELETE', '/calendar/:id', ({ res, params, principal }) => {
      if (calendar === undefined) return json(res, 404, { error: 'no_calendar' });
      const cancelled = calendar.cancel(principal, params.id ?? '');
      if (cancelled) {
        this.deps.reminders?.cancelFor(principal, 'event', params.id ?? '', 'event cancelled');
      }
      json(
        res,
        cancelled ? 200 : 404,
        cancelled ? { cancelled: params.id } : { error: 'no_such_event' },
      );
    });


    /* ──────────────────────── S3 — reminders ───────────────────────── */

    const reminders = this.deps.reminders;

    this.add('GET', '/reminders', ({ res, url, principal }) => {
      if (reminders === undefined) return json(res, 404, { error: 'no_reminders' });
      const includeDone = url.searchParams.get('includeDone') === 'true';
      const found = includeDone ? reminders.all(principal) : reminders.pending(principal);
      json(res, 200, { reminders: found.map(reminderView) });
    });

    this.add('POST', '/reminders', async ({ res, body, principal }) => {
      if (reminders === undefined) return json(res, 404, { error: 'no_reminders' });
      const parsed = PostReminderBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_reminder', detail: parsed.error.issues });
      }
      // The owner has to exist. A reminder about a deleted task is the
      // failure that teaches someone to stop reading reminders.
      const owner =
        parsed.data.ownerKind === 'task'
          ? this.deps.tasks?.get(principal, parsed.data.ownerId)
          : this.deps.calendar?.get(principal, parsed.data.ownerId);
      if (owner === undefined) {
        return json(res, 404, { error: 'no_such_owner' });
      }
      try {
        const reminder = reminders.set(principal, {
          ownerKind: parsed.data.ownerKind,
          ownerId: parsed.data.ownerId,
          remindAt: parsed.data.remindAt,
          text: parsed.data.text,
        });
        json(res, 201, reminderView(reminder));
      } catch (error) {
        json(res, 400, {
          error: 'invalid_reminder',
          detail: error instanceof Error ? error.message : 'the reminder could not be set',
        });
      }
    });

    this.add('DELETE', '/reminders/:id', ({ res, params, principal }) => {
      if (reminders === undefined) return json(res, 404, { error: 'no_reminders' });
      const cancelled = reminders.cancel(principal, params.id ?? '', 'cancelled by the user');
      json(
        res,
        cancelled ? 200 : 404,
        cancelled ? { cancelled: params.id } : { error: 'no_such_reminder' },
      );
    });

    /* ────────────────────── S4 — notifications ─────────────────────── */

    // Only fired reminders, deliberately. The person asked to be told
    // this, at this moment, and that request is what earns an
    // interruption; everything else the agent says in the background
    // is something it chose to say. A badge whose first item is an
    // unrequested briefing is a badge people learn to ignore.

    this.add('GET', '/notifications', ({ res, principal }) => {
      if (reminders === undefined) return json(res, 404, { error: 'no_reminders' });
      json(res, 200, {
        notifications: reminders.unseen(principal).map((reminder) => ({
          id: reminder.id,
          text: reminder.text,
          firedAt: reminder.firedAt,
          ownerKind: reminder.ownerKind,
          ownerId: reminder.ownerId,
          // Where the agent's own words about it landed, so the client
          // can open that conversation rather than just saying a
          // reminder happened.
          sessionId: scheduleSessionId(reminder.scheduleId),
        })),
      });
    });

    this.add('POST', '/notifications/:id/seen', ({ res, params, principal }) => {
      if (reminders === undefined) return json(res, 404, { error: 'no_reminders' });
      const seen = reminders.markSeen(principal, params.id ?? '');
      json(res, seen ? 200 : 404, seen ? { id: params.id, seen: true } : { error: 'no_such_notification' });
    });

    /* ──────────────────────── S2 — the task list ────────────────────── */

    const tasks = this.deps.tasks;

    this.add('GET', '/tasks', ({ res, url, principal }) => {
      if (tasks === undefined) return json(res, 404, { error: 'no_tasks' });
      const includeClosed = url.searchParams.get('includeClosed') === 'true';
      json(res, 200, { tasks: tasks.list(principal, { includeClosed }).map(taskView) });
    });

    this.add('POST', '/tasks', async ({ res, body, principal }) => {
      if (tasks === undefined) return json(res, 404, { error: 'no_tasks' });
      const parsed = CreateTaskBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_task', detail: parsed.error.issues });
      }
      try {
        json(
          res,
          201,
          taskView(
            tasks.add(principal, {
              title: parsed.data.title,
              ...(parsed.data.dueAt === undefined ? {} : { dueAt: parsed.data.dueAt }),
              ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
            }),
          ),
        );
      } catch (error) {
        json(res, 400, {
          error: 'invalid_task',
          detail: error instanceof Error ? error.message : 'the task could not be added',
        });
      }
    });

    // Completing is a PATCH rather than its own verb because it is a
    // state change on the task, and un-completing has to be possible:
    // a tick-box you cannot untick is a trap.
    this.add('PATCH', '/tasks/:id', async ({ res, params, body, principal }) => {
      if (tasks === undefined) return json(res, 404, { error: 'no_tasks' });
      const parsed = PatchTaskBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_patch', detail: parsed.error.issues });
      }
      const id = params.id ?? '';
      if (!parsed.data.done) {
        // S3: un-ticking is a `task.reopened` event. It fails only for
        // a task that does not exist, is already open, or was dropped
        // — dropping is not undone by reopening, it is undone by
        // deciding to do the thing again, which is a new task.
        const reopened = tasks.reopen(principal, id);
        return json(
          res,
          reopened ? 200 : 409,
          reopened
            ? { id, done: false }
            : {
                error: 'not_reopenable',
                detail:
                  'Only a completed task can be reopened. A dropped task is gone on ' +
                  'purpose — add it again if you have changed your mind.',
              },
        );
      }
      const done = tasks.complete(principal, id);
      // A reminder about something already done is noise, and noise is
      // how a reminder list stops being read.
      if (done) this.deps.reminders?.cancelFor(principal, 'task', id, 'task completed');
      json(res, done ? 200 : 404, done ? { id, done: true } : { error: 'no_such_task' });
    });

    this.add('DELETE', '/tasks/:id', ({ res, params, principal }) => {
      if (tasks === undefined) return json(res, 404, { error: 'no_tasks' });
      const dropped = tasks.drop(principal, params.id ?? '');
      if (dropped) {
        this.deps.reminders?.cancelFor(principal, 'task', params.id ?? '', 'task dropped');
      }
      json(res, dropped ? 200 : 404, dropped ? { dropped: params.id } : { error: 'no_such_task' });
    });

    /* ────────────────── §28 — schedules, jobs, degradation ────────────── */

    // §29's endpoint list predates the scheduler and does not name these
    // (decision 035). They follow the same shape as everything else it does
    // name: bearer auth, zod at the boundary, `cache-control: no-store`.

    const schedules = this.deps.schedules;
    const queue = this.deps.queue;

    this.add('GET', '/schedules', ({ res, principal }) => {
      if (schedules === undefined) return json(res, 404, { error: 'no_scheduler' });
      json(res, 200, { schedules: schedules.list(principal).map(scheduleView) });
    });

    this.add('POST', '/schedules', async ({ res, body, principal }) => {
      if (schedules === undefined) return json(res, 404, { error: 'no_scheduler' });
      const parsed = CreateScheduleBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_schedule', detail: parsed.error.issues });
      }
      try {
        const created = schedules.create(principal, {
          name: parsed.data.name,
          spec: parsed.data.spec,
          payload: { prompt: parsed.data.prompt },
          ...(parsed.data.timezone === undefined ? {} : { timezone: parsed.data.timezone }),
          ...(parsed.data.catchUp === undefined ? {} : { catchUp: parsed.data.catchUp }),
          ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
        });
        json(res, 201, scheduleView(created));
      } catch (error) {
        // A bad cron spec is the user's typo, not a server fault. 400 with
        // the parser's own sentence — which already explains the interval
        // floor when that is what was wrong.
        if (error instanceof CronParseError || error instanceof ScheduleParseError) {
          return json(res, 400, { error: 'invalid_spec', detail: error.message });
        }
        throw error;
      }
    });

    this.add('PATCH', '/schedules/:id', async ({ res, params, body, principal }) => {
      if (schedules === undefined) return json(res, 404, { error: 'no_scheduler' });
      const parsed = UpdateScheduleBody.safeParse(await body());
      if (!parsed.success) {
        return json(res, 400, { error: 'invalid_schedule', detail: parsed.error.issues });
      }
      try {
        // Spread the present keys only: `exactOptionalPropertyTypes` draws
        // a real distinction between "not given" and "given as undefined",
        // and so does a PATCH.
        const patch = Object.fromEntries(
          Object.entries(parsed.data).filter(([, value]) => value !== undefined),
        );
        const updated = schedules.update(principal, params.id ?? '', patch);
        if (updated === null) return json(res, 404, { error: 'no_such_schedule' });
        json(res, 200, scheduleView(updated));
      } catch (error) {
        if (error instanceof CronParseError || error instanceof ScheduleParseError) {
          return json(res, 400, { error: 'invalid_spec', detail: error.message });
        }
        throw error;
      }
    });

    this.add('DELETE', '/schedules/:id', ({ res, params, principal }) => {
      if (schedules === undefined) return json(res, 404, { error: 'no_scheduler' });
      const removed = schedules.delete(principal, params.id ?? '');
      json(res, removed ? 200 : 404, removed ? { deleted: params.id } : { error: 'no_such_schedule' });
    });

    this.add('GET', '/jobs', ({ res, url }) => {
      if (queue === undefined) return json(res, 404, { error: 'no_queue' });
      const status = url.searchParams.get('status');
      json(res, 200, {
        counts: queue.counts(),
        jobs: queue
          .list(status === null ? {} : { status: status as 'pending' })
          .map((job) => ({
            id: job.id,
            kind: job.kind,
            status: job.status,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            runAfter: job.runAfter,
            lastError: job.lastError,
            scheduleId: job.scheduleId,
            enqueuedAt: job.enqueuedAt,
          })),
      });
    });

    this.add('GET', '/jobs/dead-letter', ({ res }) => {
      if (queue === undefined) return json(res, 404, { error: 'no_queue' });
      json(res, 200, { dead: queue.deadLetters() });
    });

    this.add('POST', '/jobs/:id/replay', ({ res, params }) => {
      if (queue === undefined) return json(res, 404, { error: 'no_queue' });
      const jobId = queue.replay(params.id ?? '');
      if (jobId === null) return json(res, 404, { error: 'no_such_dead_letter' });
      json(res, 202, { jobId });
    });

    /**
     * §29's `GET /events` — the audit surface, filterable.
     *
     * Listed in §29 and not built until now because nothing needed it.
     * M8 does: "did my agent do anything while I was asleep?" is a
     * question about the log, and the log is the only honest answer. The
     * payloads go through the redactor on the way out, like the SSE
     * stream does.
     */
    this.add('GET', '/events', ({ res, url }) => {
      const types = (url.searchParams.get('types') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100'), 1), 500);

      const filter = {
        ...(types.length > 0 ? { types: types as never } : {}),
        ...(url.searchParams.has('sessionId')
          ? { sessionId: url.searchParams.get('sessionId') as string }
          : {}),
        ...(url.searchParams.has('runId') ? { runId: url.searchParams.get('runId') as string } : {}),
      };

      /**
       * `sinceSeq` is the cursor, and it is exclusive: "everything after
       * the last row I saw".
       *
       * Without it the only way to follow the log was to re-fetch the
       * whole tail window and diff it client-side, which is why the UI
       * had a refresh button instead of a live view — building a poll
       * loop on a cursorless route papers over the gap rather than
       * closing it. The log is append-only and `seq` is monotonic, so a
       * cursor is the natural shape here: a page can never shift under
       * a reader the way an offset into a mutable table can.
       */
      const sinceRaw = url.searchParams.get('sinceSeq');
      const since = sinceRaw === null ? null : Number(sinceRaw);
      if (since !== null && (!Number.isInteger(since) || since < 0)) {
        return json(res, 400, { error: 'bad_request', detail: 'sinceSeq must be a whole number' });
      }

      // Paging happens in SQL now. It used to read every matching row
      // and slice the array, which at 150k events cost ~1.6s per call.
      const rows =
        since === null
          ? // No cursor: the newest page. Read it backwards so the
            // database does the work, then put it back in log order.
            this.deps.events.read({ ...filter, limit, reverse: true }).reverse()
          : this.deps.events.read({ ...filter, fromSeq: since + 1, limit });

      const total = this.deps.events.count(filter);
      const last = rows.at(-1)?.seq;

      json(res, 200, {
        total,
        events: rows.map((event) => ({
          seq: event.seq,
          id: event.id,
          ts: event.ts,
          type: event.type,
          trust: event.trust,
          sessionId: event.sessionId,
          runId: event.runId,
          payload: this.deps.redactor?.redact(event.payload) ?? event.payload,
        })),
        /**
         * Hand the cursor back rather than making the caller derive it:
         * an empty page still has to advance nothing, and `max(seq)` of
         * an empty array is the sort of thing every client gets wrong
         * once.
         */
        nextSeq: last ?? since ?? 0,
        hasMore: since === null ? total > rows.length : rows.length === limit,
      });
    });

    this.add('GET', '/degradation', ({ res }) => {
      const ladder = this.deps.ladder;
      if (ladder === undefined) {
        // Honest default rather than a 404: a system with no ladder wired
        // is at L0 by definition, and saying so is cheaper than making
        // every client handle a missing endpoint.
        return json(res, 200, { level: 'L0', meaning: LEVEL_MEANING.L0, signals: [] });
      }
      json(res, 200, ladder.state());
    });
  }


  /* ───────────────────────────── live plumbing ──────────────────────────── */

  private readonly inflight = new Map<string, Promise<RunOutcome>>();

  private track(runId: string, promise: Promise<RunOutcome>): void {
    this.inflight.set(runId, promise);
    this.deps.onRunStart?.();
    void promise
      .catch((err: unknown) => {
        this.deps.logger.error('run threw', { runId, message: (err as Error).message });
        return undefined;
      })
      .finally(() => {
        this.inflight.delete(runId);
        this.deps.onRunEnd?.();
      });
  }

  private listen(runId: string, listener: (f: ReturnType<typeof toFrame>) => void): void {
    const set = this.live.get(runId) ?? new Set();
    set.add(listener);
    this.live.set(runId, set);
  }

  private untrack(runId: string, listener: (f: ReturnType<typeof toFrame>) => void): void {
    const set = this.live.get(runId);
    if (set === undefined) return;
    set.delete(listener);
    if (set.size === 0) this.live.delete(runId);
  }
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** The shape §22.8's list and explain views both need. */
function summarise(fact: Fact) {
  return {
    id: fact.id,
    text: factLine(fact),
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    basis: fact.basis,
    confidence: fact.confidence,
    sourceCount: fact.sources.length,
    observationCount: fact.observationCount,
    status: fact.status,
    pinned: fact.pinned,
    sensitivity: fact.sensitivity,
    stability: fact.stability,
    trust: fact.trust,
    recordedAt: fact.recordedAt,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
  };
}

/**
 * The reasoning chain, in plain language (§22.8).
 *
 * Deliberately generated here rather than by the model: an explanation
 * written by the same thing that might be wrong is a story, not an audit.
 * This reads the record and says what it says.
 */
function explain(fact: Fact): string[] {
  const lines: string[] = [];
  const when = new Date(fact.recordedAt).toISOString().slice(0, 10);

  if (fact.basis === 'asserted_by_user') {
    lines.push(`You told me this on ${when}.`);
  } else if (fact.basis === 'inferred') {
    lines.push(`I worked this out on ${when} — you did not say it outright.`);
  } else if (fact.basis === 'observed') {
    lines.push(`I noticed this on ${when} from how a conversation went.`);
  } else {
    lines.push(`This was imported on ${when}.`);
  }

  for (const source of fact.sources) {
    if (source.quote !== undefined) lines.push(`The words it came from: "${source.quote}"`);
  }

  if (fact.observationCount > 1) {
    lines.push(`I have seen this ${fact.observationCount} times, which is why I am more sure of it.`);
  }
  lines.push(`I am about ${Math.round(fact.confidence * 100)}% sure.`);

  if (fact.status === 'disputed') {
    lines.push('I have conflicting information about this, so I will ask rather than assert it.');
  }
  if (fact.status === 'quarantined') {
    lines.push(
      'This came from untrusted content, so it is quarantined: I keep it only so you can see ' +
        'what was claimed. It never reaches a conversation.',
    );
  }
  if (fact.validTo !== null) {
    lines.push(`This stopped being true on ${new Date(fact.validTo).toISOString().slice(0, 10)}.`);
  }
  if (fact.pinned) lines.push('You pinned this, so it is in every conversation.');

  return lines;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Every response here is a view of mutable state, and some of it is the
    // most sensitive text in the system. Without this header a browser is
    // free to apply heuristic freshness to a GET with no validators — which
    // it does: pinning a memory and re-reading the list returned the stale
    // pre-pin copy from cache, and the UI looked broken for a reason that
    // was nowhere in the UI.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // A bounded read: an unbounded one is a one-line denial of service.
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
