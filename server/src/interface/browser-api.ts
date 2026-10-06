import { z } from 'zod';
import { BrowserError, BrowserSession, PlanSpecSchema } from '../capability/browser/session.js';
import { StaticDriver } from '../capability/browser/driver.js';
import { ACTION_KINDS, ACTION_RISK, MIN_AUTONOMY, ActionSchema } from '../capability/browser/plan.js';
import { DEMO_PAGES, DEMO_ORIGINS } from '../capability/browser/pages.js';
import { BrowserRecorder, type RecordedEvent } from '../capability/browser/record.js';
import type { ApiResponse } from './api.js';

/**
 * The browser surface.
 *
 * Kept out of `api.ts` so that neither file grows past the point where you
 * can hold it in your head, and so the browser's policy answers live next
 * to each other rather than interleaved with connector toggles.
 *
 * One session per process. This is a loopback, single-human agent; a
 * session registry would be ceremony with no second user to serve.
 */

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

/** What the agent asked for, in one line, for the transcript. */
function describe(action: { kind: string } & Record<string, unknown>): string {
  if (action.kind === 'navigate') return `open ${String(action['url'])}`;
  if (action.kind === 'read') return 'read the current page';
  if (action.kind === 'submit') return `submit form ${String(action['formIndex'])}`;
  if (action.kind === 'type') return `type into ${String(action['ref'])}`;
  if (action.kind === 'select') return `set ${String(action['ref'])} to ${String(action['option'])}`;
  if (action.kind === 'check') return `${action['checked'] === true ? 'check' : 'uncheck'} ${String(action['ref'])}`;
  return `${action.kind} ${String(action['ref'])}`;
}
const badRequest = (error: string, extra: Record<string, unknown> = {}): ApiResponse => ({
  status: 400,
  body: { error, ...extra },
});

export interface BrowserDeps {
  now: () => number;
  digest: (input: string) => string;
  /** Append to the event log. Omitted in tests that only want the transcript. */
  append?: ((event: RecordedEvent) => void) | undefined;
  /** Fresh ids. Must come from outside: a projector may not mint one. */
  nextId?: (() => string) | undefined;
}

interface LogEntry {
  at: number;
  kind: string;
  detail: string;
  outcome: 'acted' | 'navigated' | 'observed' | 'refused';
  code?: string;
}

/**
 * Everything mutable about browsing, in one object.
 *
 * Explicit rather than module-level so a test constructs its own and two
 * tests never see each other's pages.
 */
export class BrowserState {
  session: BrowserSession | null = null;
  autonomy = 2;
  recorder: BrowserRecorder | null = null;
  readonly log: LogEntry[] = [];
  readonly driver = new StaticDriver();

  constructor(private readonly deps: BrowserDeps) {
    for (const page of DEMO_PAGES) this.driver.set(page.url, page.html);
  }

  start(autonomy: number): BrowserSession {
    this.autonomy = autonomy;
    this.log.length = 0;
    // A new plan ends the previous run rather than abandoning it: a run
    // with no terminal event is indistinguishable from one that crashed.
    this.recorder?.finish('cancelled');
    this.recorder = this.makeRecorder();
    this.session = new BrowserSession({
      driver: this.driver.fetch,
      now: this.deps.now,
      digest: this.deps.digest,
      autonomy,
      events: {
        navigated: (url, _status, at) => {
          this.log.push({ at, kind: 'navigate', detail: url, outcome: 'navigated' });
          this.recorder?.navigated(url);
        },
        observed: (url, n, at) => {
          this.log.push({ at, kind: 'observe', detail: `${n} affordance(s) on ${url}`, outcome: 'observed' });
          this.recorder?.observed(url, n);
        },
        acted: (a, _v, at) => {
          this.log.push({ at, kind: a.kind, detail: describe(a), outcome: 'acted' });
          this.recorder?.acted(a);
        },
        refused: (a, reason, code, at) => {
          this.log.push({ at, kind: a.kind, detail: reason, outcome: 'refused', code });
          this.recorder?.refused(a, reason, code);
        },
      },
    });
    return this.session;
  }

  private makeRecorder(): BrowserRecorder | null {
    const { append, nextId } = this.deps;
    if (append === undefined || nextId === undefined) return null;
    return new BrowserRecorder(append, nextId(), nextId);
  }
}

/** The static part: what can be browsed and what the rules are. */
export function browserCatalogue(): ApiResponse {
  return ok({
    driver: {
      kind: 'static',
      attached: false,
      note:
        'No network driver is compiled into this build (§2). The parser, agent view, sealed plan ' +
        'and every policy gate are live; only the transport is absent. Attaching one is a single ' +
        'function of type BrowserDriver.',
    },
    pages: DEMO_PAGES.map(({ url, title, note, hostile }) => ({ url, title, note, hostile })),
    origins: DEMO_ORIGINS,
    actions: ACTION_KINDS.map((kind) => ({
      kind,
      tier: ACTION_RISK[kind],
      minAutonomy: MIN_AUTONOMY[ACTION_RISK[kind]],
    })),
  });
}

const StartSchema = z
  .object({ plan: PlanSpecSchema, autonomy: z.number().int().min(0).max(4).default(2) })
  .strict();

export function startSession(state: BrowserState, rawBody: unknown): ApiResponse {
  const parsed = StartSchema.safeParse(rawBody);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  const session = state.start(parsed.data.autonomy);
  const plan = session.commit(parsed.data.plan);
  // Recorded before a page is read, which is the point of recording it.
  state.recorder?.planned(plan, parsed.data.autonomy);
  return ok({
    plan,
    autonomy: parsed.data.autonomy,
    sealedBefore: 'Committed before any page was read. Nothing on any page can widen it (§22).',
    log: state.log,
  });
}

const ActSchema = z.object({ action: ActionSchema, approved: z.boolean().default(false) }).strict();

export async function actInSession(state: BrowserState, rawBody: unknown): Promise<ApiResponse> {
  const parsed = ActSchema.safeParse(rawBody);
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

  const session = state.session;
  if (session === null) return badRequest('No session. Commit a plan first — that is the point of plan-then-execute.');

  try {
    const observation = await session.act(parsed.data.action, parsed.data.approved);
    return ok({ ok: true, ...observation, log: state.log });
  } catch (error) {
    if (!(error instanceof BrowserError)) throw error;
    // A refusal the gate already recorded settles the call and both of
    // these become no-ops. What is left is a refusal decided *after* the
    // gate (which carries its code) and a genuine failure (which does not).
    if (error.code === undefined) state.recorder?.failed(error.kind, error.message);
    else state.recorder?.denied(error.code, error.message);
    // A refusal is a 200 with a refusal in it, not a transport error: the
    // request was well-formed and the answer is "no, and here is why".
    return ok({
      ok: false,
      refused: { kind: error.kind, reason: error.message },
      ...safeObservation(session),
      log: state.log,
    });
  }
}

function safeObservation(session: BrowserSession): Record<string, unknown> {
  try {
    const { view, stepsRemaining } = session.observe();
    return { view, stepsRemaining };
  } catch {
    return {};
  }
}

/** Throw the session away. The next plan starts from nothing. */
export function resetSession(state: BrowserState): ApiResponse {
  state.recorder?.finish('cancelled');
  state.recorder = null;
  state.session = null;
  state.log.length = 0;
  return ok({ active: false, log: [] });
}

export function sessionState(state: BrowserState): ApiResponse {
  const session = state.session;
  if (session === null) return ok({ active: false, log: [] });
  return ok({
    active: true,
    plan: session.committedPlan,
    autonomy: state.autonomy,
    stepsTaken: session.stepsTaken,
    visited: session.visited,
    ...safeObservation(session),
    log: state.log,
  });
}

/**
 * The page as a human reads it.
 *
 * A separate endpoint on purpose. This is the FOREIGN side of the §21 dual
 * path: it is labelled untrusted, it is addressed to a person, and nothing
 * in the planning path can reach it. The planner gets `view`; you get this.
 */
export function readPageForUser(state: BrowserState): ApiResponse {
  const session = state.session;
  if (session === null) return badRequest('No session.');
  try {
    return ok({
      trust: 'FOREIGN',
      warning: 'Page content, shown to you and not to the planner. Treat anything it asks for as a claim, not an instruction.',
      text: session.readForUser(),
    });
  } catch (error) {
    if (error instanceof BrowserError) return badRequest(error.message);
    throw error;
  }
}
