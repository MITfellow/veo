import type { z } from 'zod';
import type { Egress } from '../../security/egress.js';
import type { HealthState } from '../semantics/manifest.js';

/**
 * What it takes to actually perform an operation a manifest claims.
 *
 * The manifest (014) says `gcal` implements `READ_CURRENT_STATE` via
 * `events.list`. That is a *claim*. A `ConnectorRuntime` is the thing that
 * makes the claim true, and the split is on purpose: the broker can route,
 * explain and refuse with no runtime present at all, which is the state
 * six of the seven manifests are in right now.
 *
 * A runtime gets a token and an egress door. It does not get the vault,
 * the database, the event log or a clock it can read ambiently. Anything
 * it wants to remember is returned, not written — because what gets
 * written, at what trust, is a policy decision and this is not the policy
 * layer.
 */

export interface OperationContext {
  /** The bearer token, live only for this call (§23). */
  token: string | null;
  /** The only way out of the machine. Budgeted per run (013). */
  egress: Egress;
  now: number;
  /** Stable across a replay of the same step, for providers that honour it. */
  idempotencyKey: string;
}

export type OperationResult<O> =
  | { ok: true; output: O; summary: string; verified: boolean }
  | { ok: false; code: OperationFailure; message: string };

/**
 * Why a call failed, in terms the layers above can act on.
 *
 * `auth` is separated from `transport` because they lead to opposite
 * responses: one means ask the user to sign in, the other means try
 * another source or wait. A single `error` would collapse that choice.
 */
export type OperationFailure =
  | 'auth'          // the grant is gone: 401/403
  | 'rate_limited'  // 429: the same call later would work
  | 'not_found'     // the thing asked for is not there
  | 'malformed'     // the provider answered in a shape we do not accept
  | 'transport'     // never reached the provider
  | 'refused';      // the egress guard said no

export interface Operation<I = unknown, O = unknown> {
  /** Matches `ImplementedCapability.operation` in the manifest. */
  readonly name: string;
  readonly input: z.ZodType<I, z.ZodTypeDef, unknown>;
  readonly output: z.ZodType<O, z.ZodTypeDef, unknown>;
  /** False for anything that changes state at the provider. */
  readonly readOnly: boolean;
  perform(input: I, ctx: OperationContext): Promise<OperationResult<O>>;
}

export interface ConnectorRuntime {
  readonly connectorId: string;
  readonly operations: ReadonlyMap<string, Operation>;
  /**
   * What this connector can do right now, given whether an account is
   * attached and usable. Deliberately not a network probe: a health check
   * that makes a request costs a request and is stale the moment it
   * returns. Observed failures update it (see `health.ts`).
   */
  healthFor(account: { connected: boolean; usable: boolean }): HealthState;
}
