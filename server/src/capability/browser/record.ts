import { ACTION_RISK, type Action, type CommittedPlan } from './plan.js';
import type { SessionEvents } from './session.js';

/**
 * Turn a browsing session into events.
 *
 * Decision 010: browsing is not a special case. A session is a **run**, and
 * each action is a **tool call** — so none of the eight event types this
 * uses are new, and the audit trail browsing needed is the one every tool
 * that comes after it inherits.
 *
 * The recorder is deliberately a port-shaped thing: it takes an `append`
 * function rather than an `EventLog`, because `capability/` may not reach
 * into the substrate and because a test wants the list of events, not a
 * database.
 *
 * It declares `implements SessionEvents` so that adding an event to the
 * session surface fails to compile here rather than quietly going
 * unrecorded. Each method takes only the arguments it uses; a narrower
 * signature still satisfies the interface.
 */

export interface RecordedEvent {
  type: 'run.planned' | 'run.started' | 'run.finished' | 'tool.invoked' | 'tool.succeeded' | 'tool.failed' | 'tool.denied';
  actor: string;
  trust: 'SYSTEM' | 'USER' | 'DERIVED' | 'TOOL' | 'FOREIGN';
  runId: string;
  payload: Record<string, unknown>;
}

export type AppendEvent = (event: RecordedEvent) => void;

/** Short, bounded summary of an action. Never page prose. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'navigate': return `open ${action.url}`;
    case 'read': return 'read the current page';
    case 'click': return `click ${action.ref}`;
    case 'type': return `type into ${action.ref}`;
    case 'select': return `set ${action.ref}`;
    case 'check': return `${action.checked ? 'check' : 'uncheck'} ${action.ref}`;
    case 'submit': return `submit form ${action.formIndex}`;
    case 'download': return `download ${action.ref}`;
  }
}

/**
 * The bounded reference an action points at.
 *
 * An origin or a ref — never a full URL with its query string, which can
 * carry an arbitrary amount of attacker-chosen text into a record the
 * privileged path reads back on replay.
 */
export function targetOf(action: Action): string | null {
  if (action.kind === 'navigate') {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(action.url.trim());
    return match === null ? null : `${match[1]?.toLowerCase()}://${match[2]?.toLowerCase()}`;
  }
  if (action.kind === 'submit') return `form ${action.formIndex}`;
  if ('ref' in action) return action.ref;
  return null;
}

const TOOL = 'browser';

/**
 * A `SessionEvents` sink that appends to the log.
 *
 * One call id per action, minted by the caller's id generator rather than
 * here: a projector must be a pure function of the events, and an id made
 * during replay would differ from the one made during the original run.
 * That is exactly the failure the rebuild-identity gate exists to catch.
 */
export class BrowserRecorder implements SessionEvents {
  /**
   * The call in flight, and the action it belongs to.
   *
   * Holding the action and not just the id is load-bearing. The first
   * version kept only `callId`, so when a call was left open — an action
   * permitted by the gate that then failed downstream — the *next*
   * refusal was written onto the abandoned row, and the action that was
   * actually refused got no row at all. Found by driving the real binary;
   * every unit test passed.
   */
  private pending: { callId: string; action: Action } | null = null;
  private steps = 0;
  private closed = false;

  constructor(
    private readonly append: AppendEvent,
    private readonly runId: string,
    private readonly nextId: () => string,
    private readonly actor = 'browser',
  ) {}

  /** Record the sealed plan. Must be called before any page is read. */
  planned(plan: CommittedPlan, autonomy: number): void {
    this.append({
      type: 'run.started',
      actor: this.actor,
      trust: 'USER',
      runId: this.runId,
      payload: { goal: plan.goal },
    });
    this.append({
      type: 'run.planned',
      actor: this.actor,
      trust: 'USER',
      runId: this.runId,
      payload: {
        goal: plan.goal,
        allowedKinds: [...plan.allowedKinds],
        maxSteps: plan.maxSteps,
        allowedOrigins: [...plan.allowedOrigins],
        carriesPrivateData: plan.carriesPrivateData,
        autonomy,
        seal: plan.seal,
      },
    });
  }

  acted(action: Action): void {
    // An action starting while another is open means the previous one
    // never reached a terminal event. Close it honestly rather than
    // letting it linger and collect someone else's outcome.
    this.abandon();
    this.pending = { callId: this.invoke(action), action };
    this.steps++;
  }

  private invoke(action: Action): string {
    const callId = this.nextId();
    this.append({
      type: 'tool.invoked',
      actor: this.actor,
      // A tool call is TOOL trust at best, whatever the plan said. §20.
      trust: 'TOOL',
      runId: this.runId,
      payload: {
        callId,
        tool: TOOL,
        action: describeAction(action),
        target: targetOf(action),
        tier: ACTION_RISK[action.kind],
      },
    });
    return callId;
  }

  private abandon(): void {
    if (this.pending === null) return;
    const { callId } = this.pending;
    this.pending = null;
    this.append({
      type: 'tool.failed',
      actor: this.actor,
      trust: 'TOOL',
      runId: this.runId,
      payload: { callId, tool: TOOL, kind: 'abandoned', detail: 'superseded by a later action without a terminal event' },
    });
  }

  navigated(url: string): void {
    this.succeed(`loaded ${originOnly(url)}`);
  }

  observed(url: string, affordances: number): void {
    // Only closes a call that navigation did not already close — a `read`
    // or an interaction ends here instead.
    this.succeed(`${affordances} affordance(s) on ${originOnly(url)}`);
  }

  refused(action: Action, reason: string, code: string): void {
    // A gate refusal happens before `acted`, so there is normally nothing
    // in flight and a call has to be minted — a denial that leaves no row
    // is a denial nobody can audit. A call *is* in flight only when it
    // belongs to this same action, which is the post-gate case.
    const mine = this.pending?.action === action ? this.pending.callId : null;
    if (mine === null) this.abandon();
    this.deny(mine ?? this.invoke(action), code, reason);
  }

  /** Deny the call in flight, if the caller knows the policy code. */
  denied(code: string, reason: string): void {
    if (this.pending === null) return;
    this.deny(this.pending.callId, code, reason);
  }

  private deny(callId: string, code: string, reason: string): void {
    this.pending = null;
    this.append({
      type: 'tool.denied',
      actor: this.actor,
      trust: 'TOOL',
      runId: this.runId,
      payload: { callId, tool: TOOL, code, reason: reason.slice(0, 400) },
    });
  }

  /** Something went wrong that policy permitted. A no-op if nothing is open. */
  failed(kind: string, detail: string): void {
    if (this.pending === null) return;
    const { callId } = this.pending;
    this.pending = null;
    this.append({
      type: 'tool.failed',
      actor: this.actor,
      trust: 'TOOL',
      runId: this.runId,
      payload: { callId, tool: TOOL, kind, detail: detail.slice(0, 400) },
    });
  }

  /** Close the run. Idempotent, because a session can end more than one way. */
  finish(stopReason: 'done' | 'budget' | 'denied' | 'cancelled' | 'error' | 'no-progress'): void {
    if (this.closed) return;
    this.closed = true;
    this.abandon();
    this.append({
      type: 'run.finished',
      actor: this.actor,
      trust: 'USER',
      runId: this.runId,
      payload: { stopReason, steps: this.steps },
    });
  }

  private succeed(detail: string): void {
    if (this.pending === null) return;
    const { callId } = this.pending;
    this.pending = null;
    this.append({
      type: 'tool.succeeded',
      actor: this.actor,
      trust: 'TOOL',
      runId: this.runId,
      payload: { callId, tool: TOOL, detail: detail.slice(0, 200) },
    });
  }
}

function originOnly(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^?#]*)?/i.exec(url.trim());
  return match === null ? url.slice(0, 80) : `${match[1]}://${match[2]}${match[3] ?? ''}`.slice(0, 120);
}
