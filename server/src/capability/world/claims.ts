import type { Storage } from '../../substrate/ports.js';
import type { MemoryStore } from '../memory/store.js';
import { scopePermits, winner, type Basis, type Claim, type Scope } from './contracts.js';

/**
 * §4 — the current world, as distinct from memory.
 *
 * This file holds the one rule that makes a world model different from a
 * diary: when two live claims about the same thing disagree, **basis
 * decides, then valid time decides.**
 *
 * Basis first is the whole point. A verified reading of the calendar beats
 * a remembered sentence however recently the sentence was said — otherwise
 * "the meeting is Friday", said once with conviction, outranks the calendar
 * that has since moved it to Monday. Recency alone cannot express that,
 * because the sentence and the reading are about different kinds of
 * knowing, not different times.
 */

/** The structured prefix that carries scope, basis and source inside `basis`. */
const MARK = 'world/1';

export function encodeBasis(basis: Basis, scope: Scope, source: string): string {
  // Pipe-delimited and escaped: `source` is the only free field, and a
  // source containing a pipe would otherwise shift every field after it.
  return [MARK, basis, scope, source.replace(/\|/g, '/')].join('|');
}

export interface Decoded { basis: Basis; scope: Scope; source: string }

export function decodeBasis(raw: string): Decoded {
  const parts = raw.split('|');
  if (parts[0] !== MARK || parts.length < 4) {
    // A fact written before this phase, or by `arish memory add`. It is an
    // observation of unknown scope — not an error, and not promoted.
    return { basis: 'OBSERVATION', scope: 'UNKNOWN', source: raw.slice(0, 80) };
  }
  return {
    basis: (parts[1] ?? 'OBSERVATION') as Basis,
    scope: (parts[2] ?? 'UNKNOWN') as Scope,
    source: parts.slice(3).join('|'),
  };
}

export function described(claim: Claim): string {
  return `'${claim.object}' (${claim.basis.toLowerCase().replace('_', ' ')}, ${claim.scope.toLowerCase()})`;
}

/** Every live claim about one subject and predicate, strongest first. */
export function claimsFor(memory: MemoryStore, subject: string, predicate: string): Claim[] {
  return memory
    .asOf({ subject, predicate })
    .map((fact) => {
      const decoded = decodeBasis(fact.basis);
      return {
        id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
        basis: decoded.basis,
        scope: decoded.scope,
        confidence: fact.confidence,
        trust: fact.trust,
        because: '',
      };
    })
    .sort((a, b) => (winner(a, b) === a ? -1 : 1));
}

/**
 * What is true *now*, with the losers named.
 *
 * `because` names what it beat, so a caller can say "the calendar says
 * Monday, though you told me Friday" instead of silently picking one. An
 * assistant that resolves a contradiction without mentioning it is the same
 * assistant that will one day resolve it the other way.
 */
export function currentClaim(
  memory: MemoryStore, subject: string, predicate: string, asking: Scope = 'UNKNOWN',
): Claim | undefined {
  const live = claimsFor(memory, subject, predicate).filter(
    (claim) => asking === 'UNKNOWN' || scopePermits(asking, claim.scope),
  );
  if (live.length === 0) return undefined;

  let best = live[0] as Claim;
  for (const candidate of live.slice(1)) best = winner(best, candidate);

  const beaten = live.filter((claim) => claim.id !== best.id);
  const because = beaten.length === 0
    ? `the only live claim, ${described(best)}`
    : `${described(best)}, over ${beaten.length} other${beaten.length === 1 ? '' : 's'} ` +
      `(${beaten.map((claim) => described(claim)).join('; ')})`;

  return { ...best, because };
}

/** Relations pointing *at* a node. Asked of the index, not of a scan. */
export function incomingIds(storage: Storage, nodeId: string, at: number): string[] {
  return storage
    .prepare(
      `SELECT id FROM facts
        WHERE object = ? AND predicate LIKE 'rel:%'
          AND status = 'active' AND retracted_at IS NULL
          AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
        ORDER BY id`,
    )
    .all<{ id: string }>(nodeId, at, at)
    .map((row) => row.id);
}
