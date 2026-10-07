import type { HealthState } from '../semantics/manifest.js';
import { MANIFESTS } from '../semantics/manifest.js';
import type { BrokerContext } from '../semantics/broker.js';
import type { IdentityStore } from '../auth/identities.js';
import type { Scope } from '../world/contracts.js';
import type { ConnectorRuntime, OperationFailure } from './types.js';

/**
 * What the broker is told about the state of the world.
 *
 * Until now `BrokerContext.health` was a test fixture. This builds it from
 * three things that are actually true: whether a runtime exists, whether
 * an account is attached and usable, and what happened the last time we
 * called.
 *
 * It does not probe. A health check that makes a request costs a request,
 * tells you about a moment that has passed, and doubles the traffic of a
 * cautious caller. Observed failures are the signal — the information is
 * free and it is about the call you actually made.
 */

export interface Observation {
  connectorId: string;
  code: OperationFailure;
  at: number;
}

/** How long a `rate_limited` observation keeps a connector out. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
/** How long a `transport` failure does. Short: the network comes back. */
export const TRANSPORT_COOLDOWN_MS = 60_000;

export class HealthBoard {
  private readonly recent = new Map<string, Observation>();

  constructor(
    private readonly deps: {
      runtimes: ReadonlyMap<string, ConnectorRuntime>;
      identities: IdentityStore;
      now: () => number;
    },
  ) {}

  /** Called after every connector call, successful or not. */
  record(connectorId: string, code: OperationFailure | 'ok'): void {
    if (code === 'ok') {
      this.recent.delete(connectorId);
      return;
    }
    this.recent.set(connectorId, { connectorId, code, at: this.deps.now() });
  }

  stateOf(connectorId: string): HealthState {
    const runtime = this.deps.runtimes.get(connectorId);
    if (runtime === undefined) return 'UNAVAILABLE';

    const cooling = this.cooldown(connectorId);
    if (cooling !== null) return cooling;

    const manifest = MANIFESTS.find((m) => m.connectorId === connectorId);
    const needsAccount = (manifest?.identityProviders.length ?? 0) > 0;
    if (!needsAccount) return runtime.healthFor({ connected: true, usable: true });

    const accounts = this.deps.identities.list()
      .filter((i) => manifest?.identityProviders.includes(i.provider) === true);
    return runtime.healthFor({
      connected: accounts.length > 0,
      usable: accounts.some((a) => a.status === 'active'),
    });
  }

  /** The whole map, ready to drop into a `BrokerContext`. */
  snapshot(): Map<string, HealthState> {
    const out = new Map<string, HealthState>();
    for (const manifest of MANIFESTS) out.set(manifest.connectorId, this.stateOf(manifest.connectorId));
    return out;
  }

  /**
   * A complete context. One call so that a caller cannot assemble three
   * quarters of one and have the broker silently treat the rest as absent.
   */
  contextFor(scope: Scope, enabled: readonly string[]): BrokerContext {
    return {
      scope,
      enabled,
      health: this.snapshot(),
      identities: this.deps.identities.refs(),
    };
  }

  private cooldown(connectorId: string): HealthState | null {
    const last = this.recent.get(connectorId);
    if (last === undefined) return null;
    const age = this.deps.now() - last.at;

    if (last.code === 'rate_limited' && age < RATE_LIMIT_COOLDOWN_MS) return 'RATE_LIMITED';
    if (last.code === 'transport' && age < TRANSPORT_COOLDOWN_MS) return 'UNAVAILABLE';
    // `auth` is not a cooldown: the identity record already carries it, and
    // a second source of truth about whether an account works is how the
    // two disagree.
    return null;
  }
}
