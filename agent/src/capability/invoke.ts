/**
 * The invoke pipeline (§16–§19, L3).
 *
 * ```
 * resolve tool → validate input → trust + capability gate → dangerous?
 *   → resolve secrets → external? intend → execute(timeout) → validate OUTPUT
 *   → artifacts → external? commit → events → render observation
 * ```
 *
 * The rule that shapes the whole file: **every failure produces an
 * observation, never an exception that escapes.** Unknown tool, bad schema,
 * refused capability, timeout, a tool that throws — all come back as text the
 * model reads on its next step and can adapt to. That is §19's "a denial is
 * not a crash", and it is the difference between an agent that recovers and
 * one that dies.
 *
 * The second rule: **output is validated as strictly as input.** A tool whose
 * remote changed shape must fail at its own boundary rather than quietly feed
 * malformed data into the model, the memory and every decision downstream.
 */
import { z } from 'zod';
import type { EventLog } from '../substrate/events/log.js';
import type { Clock, FileStore, Hashing, Ids, Logger, Net, Storage } from '../substrate/ports.js';
import type { Redactor } from '../substrate/events/redact.js';
import { canonicalJson } from '../substrate/hash.js';
import type { TrustLevel } from '../substrate/events/types.js';
import type { Capability } from '../security/trust.js';
import { decide, type Grants } from './policy.js';
import type { ApprovalStore } from './approvals.js';
import { trustRank } from '../substrate/events/types.js';
import type { Vault } from '../security/vault.js';
import type { ModelRequestFirewall } from '../security/firewall.js';
import { ArtifactStore, INLINE_LIMIT_BYTES } from './artifacts.js';
import { ScopedNetImpl, type EgressBudget } from './egress.js';
import { Outbox } from './outbox.js';
import type { ToolRegistry } from './registry.js';
import type { Rendered, Tool, ToolContext, ToolResult } from './tool.js';

/** What the model gets back. Always text, always within budget. */
export interface Observation {
  tool: string;
  callId: string;
  ok: boolean;
  text: string;
  truncated: boolean;
  artifacts: string[];
  /** Trust of the *result*, which feeds the lattice on the next step. */
  trust: TrustLevel;
  /**
   * Set when the call needs a human before it can proceed.
   *
   * The invoker does not block or poll — it records the request and hands
   * the id back. Deciding what to do with a run that cannot continue is the
   * orchestrator's job (§19: suspend durably, release all resources), and
   * the capability layer has no business knowing how runs are parked.
   */
  awaitingApproval?: { approvalId: string; preview: string };
}

export interface InvokeRequest {
  callId: string;
  /** Needed so a 'session'-scoped approval can be matched. */
  sessionId?: string | null;
  /**
   * The approval that authorises this specific call.
   *
   * Set only by the resume path. It is checked against the stored record —
   * same tool, same input, same run — so it cannot be used to launder an
   * approval for one call into permission for another.
   */
  approvalId?: string;
  tool: string;
  version?: string;
  input: unknown;
  runId: string;
  stepId: string;
  principal: string;
  effectiveTrust: TrustLevel;
  /** How many tokens of the result the model can afford. */
  renderBudget?: number;
  signal?: AbortSignal;
}

export interface InvokerDeps {
  registry: ToolRegistry;
  events: EventLog;
  storage: Storage;
  clock: Clock;
  ids: Ids;
  hashing: Hashing;
  logger: Logger;
  /**
   * The principal's grants and what they delegated to the agent (§19).
   *
   * Required for the same reason `redactor` is: a default would be either
   * too wide (and invisible) or too narrow (and mysterious). `DEFAULT_GRANTS`
   * exists for tests and single-user setups, so choosing it is a visible act.
   */
  grants: Grants;
  /**
   * Approvals (M4). Without it, a `dangerous` tool is refused outright —
   * which is the correct failure, but not a useful product.
   */
  approvals?: ApprovalStore;
  /**
   * Redacts secrets from observation text on the way to the model (§13).
   *
   * Required, not optional. An optional redactor is one `new Invoker({...})`
   * away from a silent leak, and the failure mode is invisible: everything
   * works, and the secret is in the prompt. Pass `new Redactor()` if you
   * genuinely have no secrets.
   */
  redactor: Redactor;
  files: FileStore;
  net: Net;
  vault?: Vault;
  firewall?: ModelRequestFirewall;
  /** Per-run egress budget (§14). Default 10 MiB. */
  egressBudgetBytes?: number;
  resolveDns?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_RENDER_BUDGET = 800;

export class Invoker {
  readonly outbox: Outbox;
  readonly artifacts: ArtifactStore;
  private readonly budgets = new Map<string, EgressBudget>();

  constructor(private readonly deps: InvokerDeps) {
    this.outbox = new Outbox(deps.storage, deps.events, deps.clock, deps.hashing);
    this.artifacts = new ArtifactStore(
      deps.files,
      deps.storage,
      deps.events,
      deps.clock,
      deps.ids,
      deps.hashing,
    );
  }

  async invoke(request: InvokeRequest): Promise<Observation> {
    const { registry, events } = this.deps;
    const budget = request.renderBudget ?? DEFAULT_RENDER_BUDGET;

    /* ── 1. resolve ────────────────────────────────────────────────────── */
    const tool = registry.get(request.tool, request.version);
    if (tool === undefined) {
      // Not an exception: the model asked for something that does not exist
      // and needs to be told, in words, so it can pick something that does.
      return this.refuse(
        request,
        `There is no tool called '${request.tool}'. Available tools: ` +
          `${registry.list().map((t) => t.name).join(', ') || '(none)'}.`,
        'not_found',
      );
    }

    /* ── 2. validate input ─────────────────────────────────────────────── */
    const parsedInput = tool.input.safeParse(request.input);
    if (!parsedInput.success) {
      const detail = parsedInput.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      this.appendToolFailed(request, tool, 'invalid_input', detail, false);
      return this.refuse(
        request,
        `The input to '${tool.name}' was not valid: ${detail}. Fix the arguments and try again.`,
        'invalid_input',
      );
    }

    /* ── 3. trust and capability gate ──────────────────────────────────── */
    if (trustRank(request.effectiveTrust) < trustRank(tool.minTrust)) {
      const reason =
        `'${tool.name}' was refused: it needs ${tool.capabilities.join(', ') || 'elevated trust'} ` +
        `and requires ${tool.minTrust} trust, but this step is running at ${request.effectiveTrust} ` +
        'because untrusted content is somewhere in its causal chain. ' +
        'Content whose origin cannot be vouched for does not reach credentials, money, or ' +
        'outbound messages, whatever that content asks for.';
      const escalated = await this.escalate(
        tool, parsedInput.data, request, tool.capabilities, reason,
      );
      if (escalated !== null) return escalated;

      this.appendPolicyDenied(request, tool, reason);
      const alternatives = this.alternativesTo(tool);
      return this.refuse(
        request,
        alternatives.length > 0
          ? `${reason} You can still use: ${alternatives.join(', ')}.`
          : `${reason} Do not retry this call. Tell the user what you were trying to do and why it stopped.`,
        'denied',
      );
    }

    // The capability set is the intersection of four things (§19), not the
    // trust ceiling alone: a USER-trust step still cannot do what the
    // principal never granted or never delegated.
    const verdict = decide({
      tool: tool.name,
      required: tool.capabilities as readonly Capability[],
      trust: request.effectiveTrust,
      grants: this.deps.grants,
      alternatives: this.alternativesTo(tool),
    });
    if (!verdict.allowed) {
      // §12.3: a human may lift this, when there is a human to ask and the
      // step is not FOREIGN-influenced.
      if (verdict.escalatable) {
        const escalated = await this.escalate(
          tool, parsedInput.data, request, verdict.missing, verdict.explanation,
        );
        if (escalated !== null) return escalated;
      }
      this.appendPolicyDenied(request, tool, verdict.explanation, verdict.missing);
      return this.refuse(request, verdict.explanation, 'denied');
    }

    /* ── 4. dangerous tools need a human (§19) ─────────────────────────── */
    if (tool.risk === 'dangerous') {
      const approvals = this.deps.approvals;
      const preview = await this.safePreview(tool, parsedInput.data, request);

      if (approvals === undefined) {
        // No approval mechanism wired up: refuse, and say so precisely. The
        // tool did not run, and the user can see what it would have done.
        this.appendPolicyDenied(request, tool, 'dangerous tool, no approval mechanism', []);
        return this.refuse(
          request,
          `'${tool.name}' needs a human's approval and no approval mechanism is configured. ` +
            `It was NOT executed. What it would have done: ${preview}`,
          'denied',
        );
      }

      // An approval granted for exactly this call, being resumed.
      if (request.approvalId !== undefined) {
        const record = approvals.get(request.approvalId);
        const matches =
          record !== undefined &&
          record.state === 'granted' &&
          record.tool === tool.name &&
          record.runId === request.runId &&
          canonicalJson(record.input) === canonicalJson(parsedInput.data);

        if (!matches) {
          const reason =
            `'${tool.name}' was not executed: approval '${request.approvalId}' does not ` +
            'authorise this exact call. An approval covers the call it was shown for, ' +
            'and nothing else.';
          this.appendPolicyDenied(request, tool, reason, []);
          return this.refuse(request, reason, 'denied');
        }
        // Authorised — fall through to execute.
      } else {

      const standing = approvals.standingDecision(
        tool.name,
        parsedInput.data,
        request.sessionId ?? null,
      );

      if (standing !== null && !standing.granted) {
        // A standing "never" is honoured without asking again. Re-asking a
        // question already answered no is how users learn to stop reading.
        const reason =
          `'${tool.name}' was permanently declined by the user` +
          (standing.via.reason !== null ? `: ${standing.via.reason}` : '.') +
          ' It was NOT executed, and asking again will not change it.';
        this.appendPolicyDenied(request, tool, reason, []);
        return this.refuse(request, reason, 'denied');
      }

      if (standing === null) {
        const record = approvals.request({
          runId: request.runId,
          stepId: request.stepId,
          sessionId: request.sessionId ?? null,
          principal: request.principal,
          tool: tool.name,
          toolVersion: tool.version,
          input: parsedInput.data,
          preview,
          risk: tool.risk,
          requestedTrust: request.effectiveTrust,
        });

        // Not an error and not a refusal: a pause. The run is suspended by
        // the orchestrator, and the tool has not run.
        return {
          tool: tool.name,
          callId: request.callId,
          ok: false,
          text:
            `'${tool.name}' is waiting for the user's approval. It has NOT run. ` +
            `They are being shown: ${preview}`,
          truncated: false,
          artifacts: [],
          trust: 'SYSTEM',
          awaitingApproval: { approvalId: record.id, preview },
        };
      }
      // standing.granted — fall through and execute.
      }
    }

    /* ── 5. secrets, scoped and zeroized ───────────────────────────────── */
    const secrets = new Map<string, Uint8Array>();
    const started = this.deps.clock.now();

    events.append({
      type: 'tool.started',
      payload: { tool: tool.name, idempotencyKey: this.keyFor(tool, parsedInput.data, request) },
      principal: request.principal,
      trust: 'SYSTEM',
      runId: request.runId,
      stepId: request.stepId,
    });

    try {
      return await this.withSecrets(tool, request, secrets, async () => {
        /* ── 6. outbox intend, before anything leaves ────────────────── */
        let key: string | null = null;
        if (tool.effect === 'external') {
          const intent = this.outbox.intend({
            tool: tool.name,
            toolVersion: tool.version,
            runId: request.runId,
            stepId: request.stepId,
            principal: request.principal,
            input: parsedInput.data,
            summary: this.summarize(tool, parsedInput.data),
          });
          key = intent.key;

          if (intent.alreadySettled) {
            // This exact effect, in this exact step, already happened. Doing
            // it again is the duplicate-payment bug the outbox exists for.
            return this.observation(request, tool, {
              text:
                `'${tool.name}' was already performed for this step ` +
                `(effect ${intent.key.slice(0, 12)}…). It was not run a second time.`,
              truncated: false,
            }, 'SYSTEM', []);
          }
          this.outbox.markAttempt(key);
        }

        /* ── 7. execute, with a timeout ──────────────────────────────── */
        const ctx = this.contextFor(tool, request, secrets, key);
        const result = await this.executeWithTimeout(tool, parsedInput.data, ctx, request);

        if (result.timedOut) {
          events.append({
            type: 'tool.timedout',
            payload: { tool: tool.name, timeoutMs: tool.timeoutMs },
            principal: request.principal,
            trust: 'SYSTEM',
            runId: request.runId,
            stepId: request.stepId,
          });
          if (key !== null) {
            // A timeout is the ambiguous case par excellence: the request may
            // well have arrived. It is left unsettled for reconciliation,
            // never retried here.
            this.outbox.needsAttention(
              key,
              `'${tool.name}' timed out after ${tool.timeoutMs}ms; the remote may or may not have acted`,
              request.principal,
            );
          }
          return this.refuse(
            request,
            `'${tool.name}' did not finish within ${tool.timeoutMs}ms and was stopped. ` +
              (tool.effect === 'external'
                ? 'Because it has an external effect, it has NOT been retried.'
                : 'You can try again.'),
            'timeout',
          );
        }

        const toolResult = result.value;

        if (!toolResult.ok) {
          this.appendToolFailed(
            request,
            tool,
            toolResult.error.kind,
            toolResult.error.message,
            toolResult.error.retryable,
          );
          const rendered = tool.renderForModel(toolResult, budget);
          return this.observation(request, tool, rendered, 'SYSTEM', []);
        }

        /* ── 8. validate the OUTPUT too ──────────────────────────────── */
        const parsedOutput = tool.output.safeParse(toolResult.value);
        if (!parsedOutput.success) {
          const detail = parsedOutput.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          this.appendToolFailed(request, tool, 'invalid_output', detail, false);
          return this.refuse(
            request,
            `'${tool.name}' returned something that does not match its declared output ` +
              `(${detail}). The result was discarded rather than used.`,
            'invalid_output',
          );
        }

        /* ── 9. artifacts absorb anything large ──────────────────────── */
        const artifacts = await this.absorb(tool, toolResult, request);

        /* ── 10. commit the effect ───────────────────────────────────── */
        if (key !== null) {
          const remoteRef =
            typeof (toolResult.value as { remoteRef?: unknown })?.remoteRef === 'string'
              ? ((toolResult.value as { remoteRef: string }).remoteRef)
              : null;
          this.outbox.commit(key, remoteRef, request.principal);
        }

        events.append({
          type: 'tool.succeeded',
          payload: {
            tool: tool.name,
            durationMs: this.deps.clock.now() - started,
            resultTrust: toolResult.trust,
            artifacts: artifacts.map((a) => a.id),
          },
          principal: request.principal,
          // The EVENT's trust is the result's trust: a FOREIGN result stays
          // FOREIGN in the log, so the lattice sees it on the next step and
          // the step that reads it is limited accordingly.
          trust: toolResult.trust,
          runId: request.runId,
          stepId: request.stepId,
        });

        const rendered = tool.renderForModel(toolResult, budget);
        return this.observation(
          request,
          tool,
          rendered,
          toolResult.trust,
          artifacts.map((a) => a.id),
        );
      });
    } catch (err) {
      // A tool that throws instead of returning `{ok:false}` is breaking the
      // contract. The run still has to survive it.
      const error = err as Error;
      this.appendToolFailed(request, tool, 'internal', error.message, false);
      return this.refuse(
        request,
        `'${tool.name}' failed unexpectedly: ${error.message}`,
        'internal',
      );
    }
  }

  /* ───────────────────────────── internals ──────────────────────────────── */

  private keyFor(tool: Tool<any, any>, input: unknown, request: InvokeRequest): string {
    return this.outbox.keyFor({
      tool: tool.name,
      toolVersion: tool.version,
      runId: request.runId,
      stepId: request.stepId,
      input,
    });
  }

  private summarize(tool: Tool<any, any>, input: unknown): string {
    const json = JSON.stringify(input);
    const shortened = json.length > 160 ? `${json.slice(0, 157)}...` : json;
    return `${tool.name} ${shortened}`;
  }

  /**
   * Resolve declared secrets, run the body, zeroize unconditionally.
   *
   * Nested `useSecret` calls, so M1's guarantee holds for every one of them:
   * the bytes are wiped in a `finally` even if the tool throws.
   */
  private async withSecrets<T>(
    tool: Tool<any, any>,
    request: InvokeRequest,
    into: Map<string, Uint8Array>,
    body: () => Promise<T>,
  ): Promise<T> {
    const refs = tool.secretsRequired ?? [];
    const vault = this.deps.vault;
    if (refs.length === 0 || vault === undefined) return body();

    const next = async (index: number): Promise<T> => {
      if (index >= refs.length) return body();
      const ref = refs[index]!;
      return vault.useSecret(ref, { principal: request.principal, tool: tool.name, runId: request.runId }, async (value) => {
        into.set(ref, value);
        try {
          return await next(index + 1);
        } finally {
          into.delete(ref);
        }
      });
    };
    return next(0);
  }

  private contextFor(
    tool: Tool<any, any>,
    request: InvokeRequest,
    secrets: Map<string, Uint8Array>,
    idempotencyKey: string | null = null,
  ): ToolContext {
    const signal = request.signal ?? new AbortController().signal;
    const budget = this.budgetFor(request.runId);

    return {
      signal,
      principal: request.principal,
      runId: request.runId,
      stepId: request.stepId,
      effectiveTrust: request.effectiveTrust,
      files: this.scopedFiles(tool),
      net: new ScopedNetImpl({
        net: this.deps.net,
        policy: tool.egress ?? { hosts: [], methods: [] },
        events: this.deps.events,
        budget,
        tool: tool.name,
        runId: request.runId,
        stepId: request.stepId,
        principal: request.principal,
        effectiveTrust: request.effectiveTrust,
        signal,
        ...(this.deps.resolveDns !== undefined ? { resolve: this.deps.resolveDns } : {}),
      }),
      secrets,
      emit: (progress) => {
        this.deps.logger.debug('tool progress', {
          tool: tool.name,
          runId: request.runId,
          message: progress.message,
        });
      },
      logger: this.deps.logger,
      // The injected clock. A tool cannot read the real one, so a replay
      // years later produces the same answer.
      now: () => this.deps.clock.now(),
      idempotencyKey,
    };
  }

  /** A FileStore rooted at `tools/<name>/`. Paths outside it do not exist. */
  private scopedFiles(tool: Tool<any, any>): ToolContext['files'] {
    const root = `tools/${tool.name}/`;
    const scope = (path: string): string => {
      const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
      // `..` is the entire attack. Rejecting it is cheaper than resolving it.
      if (normalized.split('/').includes('..')) {
        throw new Error(`path '${path}' escapes this tool's sandbox`);
      }
      return `${root}${normalized}`;
    };
    const files = this.deps.files;
    return {
      read: (path) => files.get(scope(path)),
      write: (path, bytes) => files.put(scope(path), bytes),
      delete: (path) => files.delete(scope(path)),
      list: async (prefix = '') => {
        const keys = await files.list(scope(prefix));
        return keys.map((k) => k.slice(root.length));
      },
    };
  }

  private budgetFor(runId: string): EgressBudget {
    let budget = this.budgets.get(runId);
    if (budget === undefined) {
      budget = { maxBytes: this.deps.egressBudgetBytes ?? 10 * 1024 * 1024, used: 0 };
      this.budgets.set(runId, budget);
    }
    return budget;
  }

  private async executeWithTimeout(
    tool: Tool<any, any>,
    input: unknown,
    ctx: ToolContext,
    request: InvokeRequest,
  ): Promise<{ timedOut: true } | { timedOut: false; value: ToolResult<unknown> }> {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onOuterAbort);

    const inner: ToolContext = { ...ctx, signal: controller.signal };
    let timer: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => {
          // Ask nicely first — a well-behaved tool unwinds on the signal.
          controller.abort();
          resolve({ timedOut: true });
        }, tool.timeoutMs);
      });

      // `Promise.race` is what makes the bound real: a tool that ignores its
      // AbortSignal still cannot hold the run open past the timeout. It may
      // keep running in the background, but nothing waits for it and its
      // result is discarded.
      return await Promise.race([
        tool.execute(input, inner).then((value) => ({ timedOut: false as const, value })),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  /** Large values become artifacts; the model gets a reference and a summary. */
  private async absorb(
    tool: Tool<any, any>,
    result: Extract<ToolResult<unknown>, { ok: true }>,
    request: InvokeRequest,
  ): Promise<Array<{ id: string }>> {
    const declared = result.artifacts ?? [];
    const serialized = JSON.stringify(result.value ?? null);
    if (serialized.length <= INLINE_LIMIT_BYTES) return declared;

    const ref = await this.artifacts.put(new TextEncoder().encode(serialized), {
      mediaType: 'application/json',
      summary: `${tool.name} result, ${serialized.length} bytes`,
      runId: request.runId,
      stepId: request.stepId,
      principal: request.principal,
      tool: tool.name,
    });
    return [...declared, ref];
  }

  /**
   * Ask a human to lift a trust-based refusal (§12.3).
   *
   *   > A FOREIGN-influenced step that wants a higher capability must emit
   *   > `policy.escalated` and obtain an explicit approval that shows the
   *   > user *what content is asking for it*.
   *
   * With one deliberate narrowing, written up in decision 022: a step whose
   * floor is **FOREIGN** is refused outright and never escalated. Offering
   * to approve what a web page asked for is the approval-fatigue attack with
   * extra steps — the user is shown a plausible request, approves the
   * fortieth one, and the gate was decorative. TOOL and above may escalate,
   * because something allowlisted is asking.
   */
  private async escalate(
    tool: Tool<any, any>,
    input: unknown,
    request: InvokeRequest,
    missing: readonly string[],
    reason: string,
  ): Promise<Observation | null> {
    const approvals = this.deps.approvals;
    if (approvals === undefined) return null;
    if (request.effectiveTrust === 'FOREIGN') return null;

    const standing = approvals.standingDecision(tool.name, input, request.sessionId ?? null);
    if (standing !== null && !standing.granted) return null;
    if (standing !== null && standing.granted) return null; // caller re-checks and proceeds

    const preview = await this.safePreview(tool, input, request);

    this.deps.events.append({
      type: 'policy.escalated',
      payload: {
        tool: tool.name,
        from: request.effectiveTrust,
        requested: [...missing],
        askingContent: reason,
      },
      principal: request.principal,
      trust: 'SYSTEM',
      runId: request.runId,
      stepId: request.stepId,
    });

    const record = approvals.request({
      runId: request.runId,
      stepId: request.stepId,
      sessionId: request.sessionId ?? null,
      principal: request.principal,
      tool: tool.name,
      toolVersion: tool.version,
      input,
      // The user is shown what the call would do AND why it needed them —
      // consent without the reason is just a button.
      preview: `${preview}\n\nThis needs you because: ${reason}`,
      risk: tool.risk,
      requestedTrust: request.effectiveTrust,
    });

    return {
      tool: tool.name,
      callId: request.callId,
      ok: false,
      text:
        `'${tool.name}' needs ${missing.join(', ') || 'higher trust'} and this step does not ` +
        `have it, so the user has been asked. It has NOT run.`,
      truncated: false,
      artifacts: [],
      trust: 'SYSTEM',
      awaitingApproval: { approvalId: record.id, preview },
    };
  }

  private async safePreview(
    tool: Tool<any, any>,
    input: unknown,
    request: InvokeRequest,
  ): Promise<string> {
    if (tool.dryRun === undefined) return '(no preview available)';
    try {
      return await tool.dryRun(input, this.contextFor(tool, request, new Map()));
    } catch (err) {
      return `(preview failed: ${(err as Error).message})`;
    }
  }

  /**
   * Build the observation the model will see.
   *
   * The text is redacted on the way out. The event log already redacts on
   * append, but the observation does not go through the log — it is
   * returned straight to the run loop and pasted into the next prompt. A
   * tool that puts a secret in its own output (buggy, or hostile) would
   * otherwise hand it to the model with nothing in the way, and invariant 7
   * says the value does not cross the vault boundary *by any route*.
   *
   * This works because the vault registers each secret with the Redactor
   * for exactly the duration of `useSecret`, and we are still inside that
   * window here.
   */
  private observation(
    request: InvokeRequest,
    tool: Tool<any, any>,
    rendered: Rendered,
    trust: TrustLevel,
    artifacts: string[],
  ): Observation {
    return {
      tool: tool.name,
      callId: request.callId,
      ok: true,
      text: this.scrub(rendered.text),
      truncated: rendered.truncated,
      artifacts,
      trust,
    };
  }

  /** Everything that leaves this class as text goes through here. */
  private scrub(text: string): string {
    return this.deps.redactor.redact(text);
  }

  private refuse(request: InvokeRequest, text: string, _kind: string): Observation {
    return {
      tool: request.tool,
      callId: request.callId,
      ok: false,
      text: this.scrub(text),
      truncated: false,
      artifacts: [],
      /**
       * A refusal is **kernel-authored text**, so it is SYSTEM.
       *
       * It was previously tagged with the step's effective trust, which
       * seemed conservative and was actively harmful: the context assembler
       * then fenced our own explanation as untrusted data and told the model
       * to ignore any instruction inside it. The model was being shown the
       * reason it was refused and simultaneously told not to act on it,
       * which is how a denial turns into a retry loop.
       *
       * This cannot launder trust upward: the step's floor is recomputed
       * from the event log every step (§12.1), where the FOREIGN event that
       * caused the refusal still sits. Nothing here raises it.
       */
      trust: 'SYSTEM',
    };
  }

  private appendToolFailed(
    request: InvokeRequest,
    tool: Tool<any, any>,
    kind: string,
    message: string,
    retryable: boolean,
  ): void {
    this.deps.events.append({
      type: 'tool.failed',
      payload: { tool: tool.name, kind, message, retryable },
      principal: request.principal,
      trust: 'SYSTEM',
      runId: request.runId,
      stepId: request.stepId,
    });
  }

  /**
   * Tools the model could use instead, so a denial ends the loop.
   *
   * Only tools whose capabilities the current grants actually cover — a
   * suggestion that will also be refused is worse than no suggestion.
   */
  private alternativesTo(denied: Tool<any, any>): string[] {
    return this.deps.registry
      .list()
      .filter((tool) => tool.name !== denied.name && tool.risk !== 'dangerous')
      .filter((tool) =>
        decide({
          tool: tool.name,
          required: tool.capabilities as readonly Capability[],
          trust: 'FOREIGN',
          grants: this.deps.grants,
        }).allowed,
      )
      .map((tool) => tool.name)
      .slice(0, 3);
  }

  private appendPolicyDenied(
    request: InvokeRequest,
    tool: Tool<any, any>,
    reason: string,
    missing: readonly string[] = tool.capabilities,
  ): void {
    this.deps.events.append({
      type: 'policy.denied',
      payload: {
        tool: tool.name,
        missing: [...missing],
        explanation: reason,
        effectiveTrust: request.effectiveTrust,
      },
      principal: request.principal,
      trust: 'SYSTEM',
      runId: request.runId,
      stepId: request.stepId,
    });
  }
}

/** Re-exported so tool authors import one module. */
export { z };
