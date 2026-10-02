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
import { ScheduleParseError } from '../orchestration/schedule.js';
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

    this.add('GET', '/runs/:id/trace', ({ res, params }) => {
      const runId = params.id!;
      const all = events.read({ runId });
      if (all.length === 0) return json(res, 404, { error: 'no_such_run' });
      json(res, 200, {
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
      const targets = memory.store.bySubject(subject, { includeInactive: true });
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
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '100'), 500);
      const all = this.deps.events.read({
        ...(types.length > 0 ? { types: types as never } : {}),
        ...(url.searchParams.has('sessionId')
          ? { sessionId: url.searchParams.get('sessionId') as string }
          : {}),
        ...(url.searchParams.has('runId') ? { runId: url.searchParams.get('runId') as string } : {}),
      });
      const page = all.slice(-limit);
      json(res, 200, {
        total: all.length,
        events: page.map((event) => ({
          seq: event.seq,
          id: event.id,
          ts: event.ts,
          type: event.type,
          trust: event.trust,
          sessionId: event.sessionId,
          runId: event.runId,
          payload: this.deps.redactor?.redact(event.payload) ?? event.payload,
        })),
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
