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
  }

  /* ───────────────────────────── live plumbing ──────────────────────────── */

  private readonly inflight = new Map<string, Promise<RunOutcome>>();

  private track(runId: string, promise: Promise<RunOutcome>): void {
    this.inflight.set(runId, promise);
    void promise
      .catch((err: unknown) => {
        this.deps.logger.error('run threw', { runId, message: (err as Error).message });
        return undefined;
      })
      .finally(() => {
        this.inflight.delete(runId);
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
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
