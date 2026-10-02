import { createHash } from 'node:crypto';
import type { Hashing } from './ports.js';

/**
 * Canonical JSON.
 *
 * The hash chain is only meaningful if the same logical payload always produces
 * the same bytes, on any machine, in any Node version, after any refactor that
 * changes the order properties happen to be assigned in. So: keys sorted at
 * every depth, no insignificant whitespace, and a few explicit rules for the
 * values JSON is sloppy about.
 *
 * Deliberate choices:
 *  - `undefined` is dropped, exactly as `JSON.stringify` would, so an optional
 *    field that is absent and one that is explicitly `undefined` hash the same.
 *    `null` is a value and is kept — it means "known to be empty".
 *  - Numbers must be finite. `NaN`/`Infinity` would serialise as `null` and
 *    silently collide with a real null.
 *  - `bigint` is encoded with a tag rather than thrown away, because event
 *    payloads can carry row ids.
 *  - Arrays keep their order; it is information.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number (${String(value)})`);
      }
      // -0 and 0 are the same value for our purposes; JSON cannot express -0.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify({ $bigint: value.toString() });
    case 'undefined':
      return 'null'; // only reachable for a bare top-level undefined
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stringify(v))).join(',')}]`;
  }

  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString('base64') });
  }

  if (value instanceof Date) {
    throw new TypeError('canonicalJson: Date is ambiguous — store epoch millis');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = record[key];
    if (v === undefined) continue; // absent === explicitly undefined
    parts.push(`${JSON.stringify(key)}:${stringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

export class NodeHashing implements Hashing {
  sha256Hex(input: string | Uint8Array): string {
    return createHash('sha256').update(input).digest('hex');
  }
}

export const hashing: Hashing = new NodeHashing();
