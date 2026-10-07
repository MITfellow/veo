import { capability, type SemanticCapability } from './ontology.js';
import { implementorsOf, USABLE, type ConnectorManifest, type HealthState, type ImplementedCapability } from './manifest.js';
import type { Scope } from '../world/contracts.js';
import { scopePermits } from '../world/contracts.js';

/**
 * Phase 10 — the capability broker.
 *
 * The brief's §24 and §202: the model says *what it wants to accomplish*;
 * this decides *how*, or refuses with a reason the user can act on. The
 * user never picks a connector (§145), and the model never picks an
 * identity for a consequential action (§6).
 *
 * The broker's output is a **route**, not a result. Routing and executing
 * are separated deliberately: a route can be explained, logged, shown to a
 * human for approval, and tested — all without anything happening. "Why
 * this connector?" (§158) is answerable because the answer is a value that
 * existed before the call did.
 *
 * A refusal is a first-class outcome. Most of this file is about saying
 * *why* nothing can be routed, because "I can't access your work calendar
 * right now" (§136) is a good answer and silence is not.
 */

export interface IdentityRef {
  identityId: string;
  provider: string;
  /** Which part of the user's life this account belongs to. */
  scope: Scope;
  /** Provider scopes this identity actually holds. */
  grantedScopes: readonly string[];
  status: 'active' | 'expired' | 'revoked';
  lastVerified: number;
}

export interface BrokerContext {
  /** What the work is for; decides which identities and sources are eligible. */
  scope: Scope;
  /** Live health per connector id. Absent means UNAVAILABLE, never assumed healthy. */
  health: ReadonlyMap<string, HealthState>;
  identities: readonly IdentityRef[];
  /** Connectors the user has actually switched on. */
  enabled: readonly string[];
  /**
   * Historical success rate per `connectorId:capabilityId`, 0..1.
   * Routing input only (§150): it reorders candidates and never grants
   * permission that policy withheld.
   */
  successRate?: ReadonlyMap<string, number>;
}

export interface Route {
  capabilityId: string;
  connectorId: string;
  operation: string;
  /** Null when the objective needs no account. */
  identity: IdentityRef | null;
  verification: ImplementedCapability['verifyBy'];
  verificationStrength: ImplementedCapability['verificationStrength'];
  risk: SemanticCapability['risk'];
  tier: SemanticCapability['tier'];
  /** Evidence-based, for §158. Never a generated explanation. */
  because: string;
  /** Routes that were viable but ranked lower, in order. */
  alternatives: Array<{ connectorId: string; why: string }>;
}

export interface Refusal {
  capabilityId: string;
  /** What the user should be told. Plain, specific, actionable. */
  reason: string;
  /** What would make it work. Empty when nothing would. */
  remedy: string[];
  /** Per-candidate detail, for diagnostics (§92). */
  considered: Array<{ connectorId: string; rejected: string }>;
}

export type Routing = { ok: true; route: Route } | { ok: false; refusal: Refusal };

interface Candidate {
  manifest: ConnectorManifest;
  impl: ImplementedCapability;
  identity: IdentityRef | null;
  score: number;
  why: string;
}

const STRENGTH_SCORE: Record<ImplementedCapability['verificationStrength'], number> = {
  STRONG: 1, MODERATE: 0.7, WEAK: 0.4, UNVERIFIED: 0,
};

export class CapabilityBroker {
  /**
   * Find the way to pursue an objective, or say why there is none.
   *
   * Order: does the objective exist → which connectors claim it → is each
   * switched on, healthy, in scope and identified → rank what survives.
   * Nothing is ranked before it is eligible, so a high score can never
   * promote something that policy already excluded.
   */
  route(capabilityId: string, context: BrokerContext): Routing {
    const objective = capability(capabilityId);
    if (objective === undefined) {
      return this.refuse(capabilityId, `There is no objective called '${capabilityId}'.`, [], []);
    }

    const considered: Array<{ connectorId: string; rejected: string }> = [];
    const viable: Candidate[] = [];

    for (const { manifest, impl } of implementorsOf(capabilityId)) {
      const outcome = this.evaluate(manifest, impl, objective, context);
      if (typeof outcome === 'string') {
        considered.push({ connectorId: manifest.connectorId, rejected: outcome });
        continue;
      }
      viable.push(outcome);
    }

    if (viable.length === 0) return this.refuse(capabilityId, this.summarise(considered, objective), this.remedies(considered), considered);

    viable.sort((a, b) => b.score - a.score || a.manifest.connectorId.localeCompare(b.manifest.connectorId));
    const best = viable[0] as Candidate;

    return {
      ok: true,
      route: {
        capabilityId,
        connectorId: best.manifest.connectorId,
        operation: best.impl.operation,
        identity: best.identity,
        verification: best.impl.verifyBy,
        verificationStrength: best.impl.verificationStrength,
        risk: objective.risk,
        tier: objective.tier,
        because: best.why,
        alternatives: viable.slice(1).map((c) => ({ connectorId: c.manifest.connectorId, why: c.why })),
      },
    };
  }

  /**
   * §147 — routing is reversible.
   *
   * When a route returns weak evidence, the caller asks for the next one
   * rather than concluding the answer does not exist. One connector having
   * answered is not the same as the question having been answered.
   */
  next(capabilityId: string, context: BrokerContext, exclude: readonly string[]): Routing {
    const filtered: BrokerContext = { ...context, enabled: context.enabled.filter((id) => !exclude.includes(id)) };
    return this.route(capabilityId, filtered);
  }

  // ─────────────────────────────────────────────────────────── eligibility

  /**
   * Judge one candidate: a scored `Candidate`, or the sentence saying why not.
   *
   * Eligibility and scoring are one pass because the identity found while
   * checking eligibility is the identity the route will use. Resolving it
   * twice — once to permit, once to record — is how the thing that was
   * checked and the thing that is used drift apart.
   */
  private evaluate(
    manifest: ConnectorManifest,
    impl: ImplementedCapability,
    objective: SemanticCapability,
    context: BrokerContext,
  ): Candidate | string {
    const blocked = this.gate(manifest, context);
    if (blocked !== null) return blocked;

    const identity = this.resolveIdentity(manifest, impl, objective, context);
    if (typeof identity === 'string') return identity;
    return this.score(manifest, impl, objective, context, identity);
  }

  /** Policy checks that do not depend on an account. */
  private gate(manifest: ConnectorManifest, context: BrokerContext): string | null {
    if (!context.enabled.includes(manifest.connectorId)) return 'not switched on by the user';

    const health = context.health.get(manifest.connectorId) ?? 'UNAVAILABLE';
    if (!USABLE.includes(health)) return healthReason(health);

    // Scope is checked against what the connector typically carries, so a
    // personal mailbox is not reached for a work objective by default.
    const scopeFits = manifest.typicalScopes.some((s) => scopePermits(context.scope, s));
    if (!scopeFits && context.scope !== 'UNKNOWN') {
      return `holds ${manifest.typicalScopes.join('/')} data, and this is a ${context.scope} objective`;
    }
    return null;
  }

  /**
   * Choose the account, or say why none fits.
   *
   * §6: the harness resolves this. Scope first, then granted provider
   * scopes, then recency of verification — an account that was confirmed
   * working ten minutes ago is a better bet than one last seen in March.
   *
   * A connector that declares no identity providers authenticates nothing:
   * a local calendar file has no account to pick, and demanding one would
   * make the offline source unreachable exactly when the online one is down.
   */
  private resolveIdentity(
    manifest: ConnectorManifest,
    impl: ImplementedCapability,
    objective: SemanticCapability,
    context: BrokerContext,
  ): IdentityRef | null | string {
    if (objective.identity.needed === 'none') return null;
    if (manifest.identityProviders.length === 0) return null;

    const forProvider = context.identities.filter((i) => manifest.identityProviders.includes(i.provider));
    if (forProvider.length === 0) return `no ${manifest.identityProviders.join(' or ')} account is connected`;

    const active = forProvider.filter((i) => i.status === 'active');
    if (active.length === 0) return 'the connected account needs signing in again';

    const inScope = active.filter((i) => scopePermits(context.scope, i.scope));
    if (inScope.length === 0) {
      return `no account for ${context.scope.toLowerCase()} work; connected accounts are ${active.map((i) => i.scope.toLowerCase()).join(', ')}`;
    }

    const authorised = inScope.filter((i) => impl.scopes.every((s) => i.grantedScopes.includes(s)));
    if (authorised.length === 0) return `the account has not granted ${impl.scopes.join(', ')}`;

    if (objective.identity.needed === 'specific' && authorised.length > 1) {
      // Not an error: a precise question beats a coin flip (§106, §139).
      const names = authorised.map((i) => `${i.provider}/${i.scope.toLowerCase()}`).join(' or ');
      return `two accounts could do this (${names}); ask which`;
    }
    return [...authorised].sort((a, b) => b.lastVerified - a.lastVerified)[0] as IdentityRef;
  }

  // ───────────────────────────────────────────────────────────── ranking

  private score(
    manifest: ConnectorManifest,
    impl: ImplementedCapability,
    objective: SemanticCapability,
    context: BrokerContext,
    identity: IdentityRef | null,
  ): Candidate {
    const verification = STRENGTH_SCORE[impl.verificationStrength];
    const history = context.successRate?.get(`${manifest.connectorId}:${objective.id}`) ?? 0.5;
    // Latency matters least: a slow correct answer beats a fast unverifiable one.
    const speed = 1 / (1 + impl.typicalLatencyMs / 1000);

    const score = 0.5 * verification + 0.35 * history + 0.15 * speed;
    const reasons = [
      `verification is ${impl.verificationStrength.toLowerCase()} (${impl.verifyBy})`,
      `past success ${(history * 100).toFixed(0)}%`,
      identity === null ? 'no account needed' : `using the ${identity.scope.toLowerCase()} ${identity.provider} account`,
    ];
    return { manifest, impl, identity, score, why: `${manifest.connectorId}: ${reasons.join(', ')}` };
  }

  // ───────────────────────────────────────────────────────────── refusals

  private summarise(
    considered: Array<{ connectorId: string; rejected: string }>,
    objective: SemanticCapability,
  ): string {
    if (considered.length === 0) {
      return `Nothing in this build can ${objective.purpose.charAt(0).toLowerCase()}${objective.purpose.slice(1)}`;
    }
    const detail = considered.map((c) => `${c.connectorId} (${c.rejected})`).join('; ');
    return `I can't do that right now: ${detail}.`;
  }

  private remedies(considered: Array<{ connectorId: string; rejected: string }>): string[] {
    const remedies = new Set<string>();
    for (const { connectorId, rejected } of considered) {
      if (rejected.includes('not switched on')) remedies.add(`switch on ${connectorId}`);
      if (rejected.includes('signing in')) remedies.add(`sign in to ${connectorId} again`);
      if (rejected.includes('not granted')) remedies.add(`grant ${connectorId} the missing permission`);
      if (rejected.includes('no ') && rejected.includes('account')) remedies.add(`connect an account for ${connectorId}`);
      if (rejected.includes('ask which')) remedies.add('tell me which account to use');
    }
    return [...remedies];
  }

  private refuse(
    capabilityId: string,
    reason: string,
    remedy: string[],
    considered: Array<{ connectorId: string; rejected: string }>,
  ): Routing {
    return { ok: false, refusal: { capabilityId, reason, remedy, considered } };
  }
}

function healthReason(health: HealthState): string {
  const reasons: Record<HealthState, string> = {
    AVAILABLE: 'available',
    DEGRADED: 'degraded',
    AUTH_REQUIRED: 'needs signing in again',
    PERMISSION_REQUIRED: 'is missing a permission',
    RATE_LIMITED: 'is rate limited right now',
    UNAVAILABLE: 'is not available in this build',
  };
  return reasons[health];
}
