import type { CryptoPort } from '../ports.js';
import type { StoredEvent } from './types.js';

/**
 * Canonical JSON.
 *
 * Two processes must produce byte-identical output for equal values, or the
 * hash chain is noise. Three rules get us there:
 *
 *   * object keys are emitted in sorted order
 *   * `undefined` is rejected rather than dropped, because dropping it means
 *     `{a: undefined}` and `{}` hash the same while comparing unequal
 *   * non-finite numbers are rejected, because `JSON.stringify` turns them
 *     into `null` and loses the distinction
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) throw new TypeError('canonicalJson: undefined is not representable');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') throw new TypeError('canonicalJson: bigint is not representable');
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
}

/** The first link. A chain starting from a constant is detectably truncated. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * The hash covers the **entire envelope except the hash itself**, including
 * `prevHash` and `seq`. Covering only the payload would let an attacker move
 * an event to a different session or run without detection.
 */
export function hashEvent(crypto: CryptoPort, event: Omit<StoredEvent, 'hash'>): string {
  return crypto.sha256(canonicalJson({
    seq: event.seq,
    id: event.id,
    type: event.type,
    ts: event.ts,
    actor: event.actor,
    trust: event.trust,
    sessionId: event.sessionId,
    runId: event.runId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    prevHash: event.prevHash,
  }));
}
