import { z } from 'zod';
import { buildObservation, readableText, type AgentView, type Target } from './view.js';
import {
  ActionSchema,
  commitPlan,
  evaluateAction,
  verifySeal,
  type Action,
  type CommittedPlan,
  type PlanSpec,
  type EvaluationContext,
  type Verdict,
} from './plan.js';
import { DriverError, isSafeScheme, normalizeUrl, unattachedDriver, type BrowserDriver } from './driver.js';

/**
 * A browsing session.
 *
 * Holds the committed plan, the current observation, and the step count.
 * Every action goes through `act`, which evaluates the policy *before*
 * touching the driver — a refused action is never performed, not performed
 * and then rolled back.
 *
 * The session never hands page prose to its caller. `observe()` returns the
 * agent view; the readable text is available only through `readForUser`,
 * which is explicitly named for its audience.
 */

export interface SessionEvents {
  navigated(url: string, status: number, at: number): void;
  observed(url: string, affordances: number, at: number): void;
  acted(action: Action, verdict: Verdict, at: number): void;
  refused(action: Action, reason: string, code: string, at: number): void;
}

const noopEvents: SessionEvents = {
  navigated: () => {},
  observed: () => {},
  acted: () => {},
  refused: () => {},
};

export interface SessionOptions {
  driver?: BrowserDriver | undefined;
  now: () => number;
  digest: (input: string) => string;
  autonomy: number;
  events?: SessionEvents | undefined;
}

export class BrowserError extends Error {
  /**
   * `code` is set when this is a *policy* refusal rather than a failure.
   *
   * Some refusals can only be decided after the gate has passed — an href
   * is only known once the ref is dereferenced. Those still have to land in
   * the audit trail as denials with their reason, not as generic errors,
   * so the code travels with the throw instead of being guessed at the
   * catch site.
   */
  constructor(
    readonly kind: 'no_plan' | 'refused' | 'no_page' | 'seal_broken' | 'unsafe_scheme',
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

export interface Observation {
  view: AgentView;
  /** Opaque handle to the full page text, for the user-facing path only. */
  contentRef: string;
  stepsRemaining: number;
}

export class BrowserSession {
  private plan: CommittedPlan | null = null;
  private steps = 0;
  private view: AgentView | null = null;
  private targets: ReadonlyMap<string, Target> = new Map();
  /** Local form state: ref → value the agent has entered. */
  private readonly fields = new Map<string, string>();
  private html = '';
  private readonly history: string[] = [];
  private readonly driver: BrowserDriver;
  private readonly events: SessionEvents;

  constructor(private readonly options: SessionOptions) {
    this.driver = options.driver ?? unattachedDriver;
    this.events = options.events ?? noopEvents;
  }

  /** Commit a plan. Must happen before any page is read (§22). */
  commit(spec: PlanSpec): CommittedPlan {
    this.plan = commitPlan(spec, this.options.now(), this.options.digest);
    this.steps = 0;
    return this.plan;
  }

  get committedPlan(): CommittedPlan | null {
    return this.plan;
  }

  get stepsTaken(): number {
    return this.steps;
  }

  get visited(): readonly string[] {
    return this.history;
  }

  private requirePlan(): CommittedPlan {
    if (this.plan === null) {
      throw new BrowserError('no_plan', 'No plan is committed. A browsing session must agree what it may do before it reads anything (§22).');
    }
    if (!verifySeal(this.plan, this.options.digest)) {
      throw new BrowserError('seal_broken', 'The committed plan has been modified since it was sealed.');
    }
    return this.plan;
  }

  /**
   * The facts the gate judges against.
   *
   * Built here and nowhere else, so there is exactly one answer to "what
   * does the policy think is on screen" and it is always the current
   * observation.
   */
  private context(targetOrigin?: string, approved?: boolean): EvaluationContext {
    const affordances = this.view?.affordances ?? [];
    return {
      plan: this.requirePlan(),
      stepsTaken: this.steps,
      autonomy: this.options.autonomy,
      currentOrigin: this.view?.origin ?? '',
      knownRefs: new Set(affordances.map((a) => a.ref)),
      disabledRefs: new Set(affordances.filter((a) => a.disabled).map((a) => a.ref)),
      ...(targetOrigin === undefined ? {} : { targetOrigin }),
      ...(approved === undefined ? {} : { approved }),
    };
  }

  /** Evaluate without performing. The UI uses this to explain a refusal. */
  check(action: Action, targetOrigin?: string): Verdict {
    return evaluateAction(action, this.context(targetOrigin));
  }

  /**
   * Perform one action.
   *
   * `approved` is a separate argument rather than a field on the action so
   * that an approval can never arrive *inside* a payload the page
   * influenced. It comes from the human, through a different door.
   */
  async act(raw: unknown, approved = false): Promise<Observation> {
    const action = this.parse(raw);
    const targetOrigin = action.kind === 'navigate' ? originOf(action.url) : undefined;
    const verdict = evaluateAction(action, this.context(targetOrigin, approved));

    this.enforce(action, verdict);
    this.steps++;
    this.events.acted(action, verdict, this.options.now());
    await this.perform(action);
    const observation = this.observe();
    this.events.observed(observation.view.url, observation.view.affordances.length, this.options.now());
    return observation;
  }

  private parse(raw: unknown): Action {
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BrowserError('refused', `Not a valid action: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const action = parsed.data;
    if (action.kind === 'navigate' && !isSafeScheme(action.url)) {
      throw new BrowserError('unsafe_scheme', `Refusing ${action.url}: only http, https and file are navigable.`, 'origin_not_allowed');
    }
    return action;
  }

  /** Turn a verdict into either silence or a refusal. Nothing in between. */
  private enforce(action: Action, verdict: Verdict): void {
    if (verdict.allowed && !verdict.requiresApproval) return;
    const code = verdict.allowed ? 'needs_approval' : verdict.code;
    this.events.refused(action, verdict.reason, code, this.options.now());
    throw new BrowserError('refused', verdict.reason);
  }

  private async perform(action: Action): Promise<void> {
    if (action.kind === 'navigate') return this.load(action.url);
    if (action.kind === 'read') return;
    if (action.kind === 'submit') return this.submit(action.formIndex);

    const target = this.targets.get(action.ref);
    if (target === undefined) {
      throw new BrowserError('no_page', `Ref ${action.ref} is not in the current observation.`);
    }
    if (action.kind === 'click') return this.follow(target);
    if (action.kind === 'download') {
      throw new BrowserError(
        'no_page',
        'Download is authorised but this build has no transport to perform it (§2). The action was recorded.',
      );
    }
    this.fields.set(action.ref, valueOf(action));
    return Promise.resolve();
  }

  /**
   * Clicking.
   *
   * A link is navigation, so it is followed — and followed through the
   * *side table*, never through anything the planner typed, so a label
   * reading "Home" cannot carry a destination of its own.
   *
   * A button on a static document has nothing to run. That is reported as
   * a dead end rather than simulated: an agent that invents the page a
   * click would have produced is worse than one that cannot click.
   */
  private async follow(target: Target): Promise<void> {
    if (target.kind !== 'link' || target.href === null) {
      throw new BrowserError(
        'no_page',
        `'${target.ref}' is a ${target.kind}; activating it needs a live driver. The click was authorised and recorded.`,
      );
    }
    const resolved = resolveHref(target.href, this.view?.url ?? '');
    if (!isSafeScheme(resolved)) {
      throw new BrowserError('unsafe_scheme', `Refusing ${target.ref}: '${schemeOf(resolved)}' is not navigable.`, 'origin_not_allowed');
    }
    const origin = originOf(resolved);
    if (!this.originAllowed(origin)) {
      throw new BrowserError('refused', `${target.ref} leads to ${origin}, which the sealed plan does not allow.`, 'origin_not_allowed');
    }
    return this.load(resolved);
  }

  /**
   * Is this origin inside the fence?
   *
   * An empty origin list means "stay where you start", so the wall is the
   * origin of the page we are on. Reading it off the plan alone let a link
   * walk straight out of a pinned session — found by a test that was
   * passing for the wrong reason.
   */
  private originAllowed(origin: string): boolean {
    if (origin === '') return true;
    const plan = this.requirePlan();
    const allowed = plan.allowedOrigins.length > 0 ? plan.allowedOrigins : [this.view?.origin ?? ''];
    return allowed.includes(origin);
  }

  /** Where a submission would go, and with which fields. Never sent here. */
  private async submit(formIndex: number): Promise<void> {
    const fields = [...this.fields.entries()]
      .filter(([ref]) => this.targets.get(ref)?.formIndex === formIndex)
      .map(([ref]) => this.targets.get(ref)?.name ?? ref);
    throw new BrowserError(
      'no_page',
      `Submission of form ${formIndex} (${fields.length} field(s): ${fields.join(', ') || 'none'}) was authorised ` +
        'and recorded, but this build has no transport to send it (§2).',
    );
  }

  private async load(url: string): Promise<void> {
    try {
      const response = await this.driver({ url: normalizeUrl(url), method: 'GET' });
      const observation = buildObservation(response.html, response.url);
      this.html = response.html;
      this.view = observation.view;
      this.targets = observation.targets;
      this.fields.clear();
      this.history.push(response.url);
      this.events.navigated(response.url, response.status, this.options.now());
    } catch (error) {
      if (error instanceof DriverError) throw new BrowserError('no_page', error.message);
      throw error;
    }
  }

  observe(): Observation {
    const plan = this.requirePlan();
    // No event here: observing is reading the state we already hold, and a
    // transcript that logs a UI refresh as a step is a transcript nobody
    // reads. The event is emitted once per action, by `act`.
    if (this.view === null) throw new BrowserError('no_page', 'Nothing has been loaded yet.');
    return {
      view: this.view,
      contentRef: `$PAGE_${this.options.digest(this.view.url).slice(0, 12)}`,
      stepsRemaining: Math.max(0, plan.maxSteps - this.steps),
    };
  }

  /**
   * The page's readable text.
   *
   * Named for its audience. This is the FOREIGN-trust path of §21 and its
   * output goes to a human, never into a plan or a prompt. Nothing in the
   * privileged path calls it.
   */
  readForUser(): string {
    if (this.view === null) throw new BrowserError('no_page', 'Nothing has been loaded yet.');
    return readableText(this.html);
  }
}

/** What a field-setting action puts in the field. */
function valueOf(action: Extract<Action, { kind: 'type' | 'select' | 'check' }>): string {
  if (action.kind === 'type') return action.text;
  if (action.kind === 'select') return action.option;
  return action.checked ? 'on' : '';
}

function originOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(url.trim());
  return match === null ? '' : `${match[1]?.toLowerCase()}://${match[2]?.toLowerCase()}`;
}

export const PlanSpecSchema = z
  .object({
    goal: z.string().min(1),
    allowedKinds: z.array(z.enum(['navigate', 'read', 'click', 'type', 'select', 'check', 'submit', 'download'])).min(1),
    maxSteps: z.number().int().min(1).max(100),
    allowedOrigins: z.array(z.string()).default([]),
    carriesPrivateData: z.boolean().default(false),
  })
  .strict();

function resolveHref(href: string, base: string): string {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  const baseOrigin = originOf(base);
  if (baseOrigin === '') return trimmed;
  if (trimmed.startsWith('/')) return `${baseOrigin}${trimmed}`;
  const path = base.slice(baseOrigin.length).split('?')[0] ?? '';
  const dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return `${baseOrigin}${dir}${trimmed}`;
}

function schemeOf(url: string): string {
  return /^([a-z][a-z0-9+.-]*):/i.exec(url.trim())?.[1]?.toLowerCase() ?? 'relative';
}

export { buildObservation, readableText };
export type { Action, AgentView, CommittedPlan, PlanSpec, Verdict };
