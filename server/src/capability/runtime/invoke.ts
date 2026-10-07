import type { CapabilityBroker, BrokerContext, Refusal, Route } from '../semantics/broker.js';
import type { IdentityStore } from '../auth/identities.js';
import type { OAuthClient } from '../auth/oauth.js';
import type { Egress } from '../../security/egress.js';
import type { Logger } from '../../substrate/ports.js';
import type { ConnectorRuntime, OperationFailure } from './types.js';

/**
 * The join: objective in, answer out.
 *
 * Everything this uses already existed separately — the broker picks the
 * connector (014), the identity store spends a token (015), egress opens
 * the door (013), the runtime speaks the provider's dialect. This is the
 * only file that knows they go together, and it is deliberately the
 * thinnest of the five.
 *
 * Two behaviours are the reason it exists at all:
 *
 *   **A dead grant is routed around, once.** A 401 marks the account and
 *   re-routes to the next implementor rather than failing the objective —
 *   §147: one connector having answered is not the question being
 *   answered, and one connector having *failed* is not the question being
 *   unanswerable.
 *
 *   **Provenance is assembled, not asserted.** Which connector, which
 *   account, how strongly verified, and why that route was chosen all
 *   come from values that existed before the call.
 */

export interface Provenance {
  connectorId: string;
  operation: string;
  identityId: string | null;
  verification: Route['verification'];
  verificationStrength: Route['verificationStrength'];
  /** The broker's reason, copied verbatim. Not a generated explanation. */
  because: string;
  /** Always the connector's declared trust. Nothing downstream raises it. */
  trust: 'FOREIGN' | 'USER' | 'SYSTEM';
  at: number;
  /** Connectors tried and dropped before this one, with the reason. */
  fellBackFrom: Array<{ connectorId: string; code: OperationFailure }>;
}

export type Attempt<O = unknown> =
  | { ok: true; output: O; summary: string; provenance: Provenance }
  | { ok: false; refusal: Refusal };

export interface InvokerDeps {
  broker: CapabilityBroker;
  identities: IdentityStore;
  /** Keyed by connector id. A manifest with no runtime can be routed to and not run. */
  runtimes: ReadonlyMap<string, ConnectorRuntime>;
  /** Keyed by provider id, for refresh. */
  clients: ReadonlyMap<string, OAuthClient>;
  egress: Egress;
  now: () => number;
  log: Logger;
}

export interface Pursuit {
  context: BrokerContext;
  idempotencyKey: string;
  /** How many connectors may be tried before giving up. */
  maxAttempts?: number;
}

export class ConnectorInvoker {
  constructor(private readonly deps: InvokerDeps) {}

  /**
   * Pursue an objective. Returns an answer with provenance, or a refusal
   * carrying a remedy — never a thrown error for an expected condition.
   */
  async pursue<O>(capabilityId: string, input: unknown, pursuit: Pursuit): Promise<Attempt<O>> {
    const tried: Array<{ connectorId: string; code: OperationFailure }> = [];
    const limit = pursuit.maxAttempts ?? 3;

    for (let attempt = 0; attempt < limit; attempt++) {
      const excluded = tried.map((t) => t.connectorId);
      const routing = this.deps.broker.next(capabilityId, pursuit.context, excluded);
      if (!routing.ok) return { ok: false, refusal: this.explain(routing.refusal, tried) };

      const outcome = await this.run<O>(routing.route, input, pursuit);
      if (outcome.kind === 'ok') {
        return {
          ok: true,
          output: outcome.output,
          summary: outcome.summary,
          provenance: this.provenanceOf(routing.route, tried),
        };
      }

      tried.push({ connectorId: routing.route.connectorId, code: outcome.code });
      this.after(routing.route, outcome);
      if (!RETRYABLE.has(outcome.code)) {
        return { ok: false, refusal: this.failed(capabilityId, routing.route, outcome.message, tried) };
      }
    }

    return { ok: false, refusal: this.exhausted(capabilityId, tried) };
  }

  // ───────────────────────────────────────────────────────────── internals

  private async run<O>(route: Route, input: unknown, pursuit: Pursuit): Promise<RunOutcome<O>> {
    const runtime = this.deps.runtimes.get(route.connectorId);
    const operation = runtime?.operations.get(route.operation);
    if (runtime === undefined || operation === undefined) {
      // Routed to a manifest with no implementation. Honest, and the
      // reason `cannotDo` in a manifest is not the same as "not built".
      return { kind: 'fail', code: 'transport', message: `${route.connectorId} is described but not implemented in this build` };
    }

    const parsedInput = operation.input.safeParse(input);
    if (!parsedInput.success) {
      return { kind: 'fail', code: 'malformed', message: `the request to ${route.connectorId} was not valid` };
    }

    const ctx = { egress: this.deps.egress, now: this.deps.now(), idempotencyKey: pursuit.idempotencyKey };
    const result = route.identity === null
      ? await operation.perform(parsedInput.data, { ...ctx, token: null })
      : await this.withToken(route.identity.identityId, route.identity.provider, (token) =>
        operation.perform(parsedInput.data, { ...ctx, token }));

    if (!result.ok) return { kind: 'fail', code: result.code, message: result.message };

    const parsedOutput = operation.output.safeParse(result.output);
    if (!parsedOutput.success) {
      return { kind: 'fail', code: 'malformed', message: `${route.connectorId} produced output its own contract rejects` };
    }
    return { kind: 'ok', output: parsedOutput.data as O, summary: result.summary };
  }

  private async withToken<T>(identityId: string, provider: string, use: (token: string) => Promise<T>): Promise<T> {
    const client = this.deps.clients.get(provider);
    if (client === undefined) throw new Error(`No OAuth client configured for ${provider}.`);
    return this.deps.identities.withAccessToken(identityId, client, use);
  }

  /** Record what the failure means for the account, so the next route differs. */
  private after(route: Route, outcome: { code: OperationFailure; message: string }): void {
    this.deps.log.warn('connector call failed', {
      connector: route.connectorId, operation: route.operation, code: outcome.code,
    });
    if (outcome.code === 'auth' && route.identity !== null) {
      this.deps.identities.markExpired(route.identity.identityId, outcome.message);
    }
  }

  private provenanceOf(route: Route, fellBackFrom: Array<{ connectorId: string; code: OperationFailure }>): Provenance {
    return {
      connectorId: route.connectorId,
      operation: route.operation,
      identityId: route.identity?.identityId ?? null,
      verification: route.verification,
      verificationStrength: route.verificationStrength,
      because: route.because,
      // §20: anything from outside is FOREIGN, however well it parsed.
      trust: route.identity === null && route.connectorId === 'notes' ? 'USER' : 'FOREIGN',
      at: this.deps.now(),
      fellBackFrom,
    };
  }

  private explain(refusal: Refusal, tried: Array<{ connectorId: string; code: OperationFailure }>): Refusal {
    if (tried.length === 0) return refusal;
    const detail = tried.map((t) => `${t.connectorId} (${t.code})`).join(', ');
    return { ...refusal, reason: `${refusal.reason} Already tried: ${detail}.` };
  }

  private failed(
    capabilityId: string, route: Route, message: string,
    tried: Array<{ connectorId: string; code: OperationFailure }>,
  ): Refusal {
    return {
      capabilityId,
      reason: `${route.connectorId} could not do it: ${message}`,
      remedy: remedyFor(tried.at(-1)?.code, route.connectorId),
      considered: tried.map((t) => ({ connectorId: t.connectorId, rejected: t.code })),
    };
  }

  private exhausted(capabilityId: string, tried: Array<{ connectorId: string; code: OperationFailure }>): Refusal {
    return {
      capabilityId,
      reason: `Every source I could try failed: ${tried.map((t) => `${t.connectorId} (${t.code})`).join(', ')}.`,
      remedy: remedyFor(tried.at(-1)?.code, tried.at(-1)?.connectorId ?? 'the connector'),
      considered: tried.map((t) => ({ connectorId: t.connectorId, rejected: t.code })),
    };
  }
}

type RunOutcome<O> =
  | { kind: 'ok'; output: O; summary: string }
  | { kind: 'fail'; code: OperationFailure; message: string };

/**
 * Failures worth trying another source for.
 *
 * `malformed` is not here: if a provider answered in a shape we reject,
 * another provider will not fix it and the retry only spends budget.
 * `not_found` is not here either — the thing asked for does not exist,
 * and asking somewhere else is how a wrong answer gets found.
 */
const RETRYABLE = new Set<OperationFailure>(['auth', 'rate_limited', 'transport']);

function remedyFor(code: OperationFailure | undefined, connectorId: string): string[] {
  const remedies: Partial<Record<OperationFailure, string[]>> = {
    auth: [`sign in to ${connectorId} again`],
    rate_limited: [`wait a few minutes and ask again`],
    transport: [`check the network, then try again`],
    refused: [`this build will not contact that address`],
    not_found: [`check the name — ${connectorId} has no such item`],
    malformed: [`nothing you can do: ${connectorId} answered in a shape this build rejects`],
  };
  return code === undefined ? [] : remedies[code] ?? [];
}
