import type { Storage } from '../../substrate/ports.js';
import type { EventLog } from '../../substrate/events/log.js';
import type { TrustLevel } from '../../substrate/events/types.js';
import { meetTrust } from '../../substrate/events/types.js';
import { MemoryStore } from '../memory/store.js';
import { EntityRegistry } from '../memory/entities.js';
import {
  BASIS_TRUST_CEILING, relationKindOf, relationPredicate, scopePermits,
  type Basis, type Claim, type NodeKind, type RelationKind, type Scope,
} from './contracts.js';
import { claimsFor, currentClaim, encodeBasis, decodeBasis, incomingIds } from './claims.js';

/**
 * Phase 2 — the Personal World Model.
 *
 * The brief calls this the single most important change, and the most
 * important decision inside it is what *not* to build. There is already a
 * bitemporal, trust-scaled, supersedable, replayable store of statements
 * about things: the fact table. A relation is a statement about two things.
 * So a relation is a fact whose predicate lives in a reserved namespace and
 * whose object is an entity id — and it inherits valid time, transaction
 * time, retraction, confidence, trust and the rebuild guarantee for free.
 *
 * The alternative — a `relations` table with its own writer — would have
 * meant a second place to forget supersession, a second thing to keep
 * replayable, and two answers to "what do we believe about X".
 *
 * What this layer adds on top of facts is the part facts cannot express:
 *
 *   **kind** — a node is a person or a project or a meeting, not a string.
 *   **scope** — which part of a life a thing belongs to (§7).
 *   **basis** — how we came to believe it, as a closed set (§4).
 *   **traversal** — neighbours and paths, with the evidence carried along.
 *
 * Scope and basis are encoded in the fact's `basis` column as a structured
 * prefix rather than as new columns, so no migration is required and every
 * fact written before this phase still parses. The encoding is written and
 * read in exactly one place — `encodeBasis`/`decodeBasis` below — which is
 * the condition under which an encoding is acceptable rather than a trap.
 */

export interface WorldDeps {
  storage: Storage;
  events: EventLog;
  now: () => number;
  nextId: () => string;
}

export class WorldError extends Error {
  constructor(readonly kind: 'unknown_node' | 'invalid' | 'scope', message: string) {
    super(message);
    this.name = 'WorldError';
  }
}

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  scope: Scope;
}

export interface Edge {
  id: string;
  from: string;
  kind: RelationKind;
  to: string;
  /** Resolved for display; the edge itself stores ids. */
  toName: string;
  validFrom: number;
  validTo: number | null;
  basis: Basis;
  scope: Scope;
  confidence: number;
  trust: TrustLevel;
  source: string;
}

export interface RelateInput {
  from: string;
  kind: RelationKind;
  to: string;
  basis: Basis;
  scope: Scope;
  /** What reported it: a connector id, a tool name, 'user'. */
  source: string;
  trust: TrustLevel;
  confidence?: number | undefined;
  validFrom?: number | undefined;
  actor?: string | undefined;
  runId?: string | undefined;
}

/** Scope is a property of a node, held as a fact so it is correctable. */
const SCOPE_PREDICATE = 'world:scope';
const KIND_PREDICATE = 'world:kind';

export class WorldGraph {
  private readonly memory: MemoryStore;
  private readonly entities: EntityRegistry;

  constructor(private readonly deps: WorldDeps) {
    const shared = { storage: deps.storage, events: deps.events, now: deps.now, nextId: deps.nextId };
    this.memory = new MemoryStore(shared);
    this.entities = new EntityRegistry(shared);
  }

  // ─────────────────────────────────────────────────────────────── nodes

  /**
   * Make a node exist, or return the one that already does.
   *
   * Idempotent on (kind, name) because a world model that creates a second
   * "Rahul" every time a message mentions him is worse than no graph: every
   * traversal then has to guess which copy is the real one.
   */
  node(kind: NodeKind, name: string, scope: Scope = 'UNKNOWN', actor = 'agent'): string {
    const trimmed = name.trim();
    if (trimmed === '') throw new WorldError('invalid', 'A node needs a name.');

    const existing = this.findByName(kind, trimmed);
    if (existing !== undefined) return existing;

    // The entity registry only knows five kinds; everything else is stored
    // as 'thing' there and carries its real kind as a fact. One table of
    // things, and no lie told to the old column.
    const legacy = (['person', 'org', 'place', 'thing', 'project'] as readonly string[]).includes(kind)
      ? (kind as 'person')
      : 'thing';
    const id = this.entities.create(legacy, trimmed, actor);

    // USER trust, not SYSTEM, and the distinction is not cosmetic: trust is
    // monotonically non-increasing, so a SYSTEM-trust claim cannot be
    // retracted by a USER-trust action — which would make "forget this
    // person" (§141) impossible for the only person entitled to ask. The
    // world's bookkeeping about a node belongs to the user whose world it is.
    this.claim(id, KIND_PREDICATE, kind, 'USER_ASSERTION', scope, 'world', 'USER', 1, actor);
    this.claim(id, SCOPE_PREDICATE, scope, 'USER_ASSERTION', scope, 'world', 'USER', 1, actor);
    return id;
  }

  get(nodeId: string): Node | undefined {
    const entity = this.entities.get(nodeId);
    if (entity === undefined) return undefined;
    return {
      id: entity.id,
      kind: (this.currentValue(entity.id, KIND_PREDICATE) ?? entity.kind) as NodeKind,
      name: entity.name,
      scope: (this.currentValue(entity.id, SCOPE_PREDICATE) ?? 'UNKNOWN') as Scope,
    };
  }

  /** Re-scope a node. A correction, not an overwrite: the old scope stays in history. */
  rescope(nodeId: string, scope: Scope, source: string, actor = 'user'): void {
    this.require(nodeId);
    this.claim(nodeId, SCOPE_PREDICATE, scope, 'USER_ASSERTION', scope, source, 'USER', 1, actor);
  }

  findByName(kind: NodeKind, name: string): string | undefined {
    const normalized = name.trim().toLowerCase();
    for (const candidate of this.entities.candidates(name, 50)) {
      const node = this.get(candidate.id);
      if (node !== undefined && node.kind === kind && node.name.toLowerCase() === normalized) return node.id;
    }
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────── edges

  /**
   * Record that two things are related.
   *
   * The edge's trust is the *meet* of the caller's trust and the ceiling its
   * basis allows: an inference drawn from a web page cannot become a USER
   * relationship by being written confidently (§20, §68).
   */
  relate(input: RelateInput): string {
    this.require(input.from);
    this.require(input.to);
    const trust = meetTrust(input.trust, BASIS_TRUST_CEILING[input.basis]);
    return this.claim(
      input.from,
      relationPredicate(input.kind),
      input.to,
      input.basis,
      input.scope,
      input.source,
      trust,
      input.confidence ?? 0.7,
      input.actor ?? 'agent',
      input.validFrom,
      input.runId,
    );
  }

  /** Stop believing an edge. The history stays; the belief does not. */
  unrelate(edgeId: string, reason: string, actor = 'user'): void {
    this.memory.retract(edgeId, reason, 'USER', actor);
  }

  /**
   * Everything currently related to a node, in either direction.
   *
   * Both directions, because "which project is Rahul on" and "who is on this
   * project" are the same edge asked from opposite ends, and a caller that
   * has to know which way it was written is a caller that will get it wrong.
   */
  neighbours(nodeId: string, options: { kind?: RelationKind; scope?: Scope; at?: number } = {}): Edge[] {
    const at = options.at ?? this.deps.now();
    const out = this.edgesFrom(nodeId, at);
    const back = this.edgesTo(nodeId, at);
    const all = [...out, ...back];

    return all
      .filter((edge) => options.kind === undefined || edge.kind === options.kind)
      .filter((edge) => options.scope === undefined || scopePermits(options.scope, edge.scope))
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  }

  /**
   * Is there a path, and what is the evidence for it?
   *
   * Breadth-first and shallow on purpose. A six-hop connection between two
   * people in a personal graph is not a relationship, it is a coincidence,
   * and presenting it as context is how an assistant confidently involves
   * the wrong person.
   */
  path(fromId: string, toId: string, maxHops = 3): Edge[] | undefined {
    if (fromId === toId) return [];
    const seen = new Set<string>([fromId]);
    let frontier: Array<{ id: string; trail: Edge[] }> = [{ id: fromId, trail: [] }];

    for (let hop = 0; hop < maxHops; hop++) {
      const next: Array<{ id: string; trail: Edge[] }> = [];
      for (const { id, trail } of frontier) {
        for (const edge of this.neighbours(id)) {
          const other = edge.from === id ? edge.to : edge.from;
          if (seen.has(other)) continue;
          const extended = [...trail, edge];
          if (other === toId) return extended;
          seen.add(other);
          next.push({ id: other, trail: extended });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return undefined;
  }

  /**
   * Record a statement about a node that is not a relation.
   *
   * "The meeting is on Monday", "the document is v4", "this project is
   * archived" — the states that make the difference between a graph of
   * things and a model of a world. Separate from `relate` because the
   * object here is a value, not a node, and conflating the two is how a
   * graph ends up with a node called 'Monday'.
   */
  state(
    subject: string,
    predicate: string,
    object: string,
    opts: { basis: Basis; scope: Scope; source: string; trust: TrustLevel; confidence?: number; validFrom?: number; actor?: string },
  ): string {
    this.require(subject);
    if (predicate.startsWith('rel:')) {
      throw new WorldError('invalid', 'A relation is written with relate(), so both ends are real nodes.');
    }
    const trust = meetTrust(opts.trust, BASIS_TRUST_CEILING[opts.basis]);
    return this.claim(
      subject, predicate, object, opts.basis, opts.scope, opts.source,
      trust, opts.confidence ?? 0.8, opts.actor ?? 'agent', opts.validFrom,
    );
  }

  // ──────────────────────────────────────────────────── current vs memory

  /**
   * §4 — what is true *now*, as opposed to what we remember.
   *
   * When two live claims disagree, basis decides and then valid time
   * decides. The returned `because` names the loser, so the caller can say
   * "the calendar says Monday, though you told me Friday" instead of
   * silently picking one.
   */
  current(subject: string, predicate: string, asking: Scope = 'UNKNOWN'): Claim | undefined {
    return currentClaim(this.memory, subject, predicate, asking);
  }

  /** Every live claim about one subject and predicate, strongest first. */
  claimsFor(subject: string, predicate: string): Claim[] {
    return claimsFor(this.memory, subject, predicate);
  }

  /**
   * §141 — forget a node.
   *
   * Every edge touching it is retracted and the node is detached. The
   * retraction events remain, because an audit of what was forgotten must
   * survive the forgetting; the content does not come back.
   */
  forget(nodeId: string, reason = 'user asked', actor = 'user'): number {
    const edges = this.neighbours(nodeId);
    for (const edge of edges) this.memory.retract(edge.id, reason, 'USER', actor);
    for (const predicate of [KIND_PREDICATE, SCOPE_PREDICATE]) {
      for (const claim of this.claimsFor(nodeId, predicate)) {
        this.memory.retract(claim.id, reason, 'USER', actor);
      }
    }
    return edges.length;
  }

  count(): { nodes: number; edges: number } {
    const nodes = this.entities.count();
    const edges = this.deps.storage
      .prepare(
        `SELECT COUNT(*) AS n FROM facts
          WHERE predicate LIKE 'rel:%' AND status = 'active' AND retracted_at IS NULL`,
      )
      .get<{ n: number }>()?.n ?? 0;
    return { nodes, edges };
  }

  // ───────────────────────────────────────────────────────────── internals

  private require(nodeId: string): void {
    if (this.entities.get(nodeId) === undefined) {
      throw new WorldError('unknown_node', `No node ${nodeId}. Create it before relating it.`);
    }
  }

  private currentValue(subject: string, predicate: string): string | undefined {
    return this.current(subject, predicate)?.object;
  }

  private claim(
    subject: string, predicate: string, object: string,
    basis: Basis, scope: Scope, source: string,
    trust: TrustLevel, confidence: number, actor: string,
    validFrom?: number, runId?: string,
  ): string {
    return this.memory.assert({
      subject,
      predicate,
      object,
      basis: encodeBasis(basis, scope, source),
      confidence,
      stability: 'slow',
      sourceTrust: trust,
      actor,
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(runId === undefined ? {} : { runId }),
    });
  }

  private edgesFrom(nodeId: string, at: number): Edge[] {
    return this.memory
      .asOf({ subject: nodeId, validAt: at })
      .flatMap((fact) => {
        const kind = relationKindOf(fact.predicate);
        if (kind === undefined) return [];
        const decoded = decodeBasis(fact.basis);
        return [{
          id: fact.id, from: fact.subject, kind, to: fact.object,
          toName: this.entities.get(fact.object)?.name ?? fact.object,
          validFrom: fact.validFrom, validTo: fact.validTo,
          basis: decoded.basis, scope: decoded.scope, source: decoded.source,
          confidence: fact.confidence, trust: fact.trust,
        }];
      });
  }

  private edgesTo(nodeId: string, at: number): Edge[] {
    return incomingIds(this.deps.storage, nodeId, at).flatMap((id) => {
      const fact = this.memory.get(id);
      if (fact === undefined) return [];
      const kind = relationKindOf(fact.predicate);
      if (kind === undefined) return [];
      const decoded = decodeBasis(fact.basis);
      return [{
        id: fact.id, from: fact.subject, kind, to: fact.object,
        toName: this.entities.get(fact.subject)?.name ?? fact.subject,
        validFrom: fact.validFrom, validTo: fact.validTo,
        basis: decoded.basis, scope: decoded.scope, source: decoded.source,
        confidence: fact.confidence, trust: fact.trust,
      }];
    });
  }
}
