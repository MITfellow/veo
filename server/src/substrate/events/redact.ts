/**
 * Redaction runs **before** the hash, so the chain verifies over exactly the
 * bytes that were stored. A hash taken over unredacted content could only be
 * checked by a process holding the secrets, which defeats the point of being
 * able to hand someone a log and let them verify it.
 *
 * The redactor replaces *values* and preserves *structure*: a reader can
 * still see that a field was present and what shape it had.
 */

export const REDACTED = '[redacted]';

export interface Redactor {
  /** Values to scrub wherever they appear, at any depth, inside any string. */
  secrets(): readonly string[];
  /** Field names whose values are always scrubbed regardless of content. */
  fields(): readonly string[];
}

const DEFAULT_FIELDS = [
  'password', 'passphrase', 'secret', 'token', 'apiKey', 'api_key',
  'authorization', 'cookie', 'privateKey', 'private_key', 'sessionKey',
];

export function createRedactor(options: { secrets?: readonly string[]; fields?: readonly string[] } = {}): Redactor {
  // Short values are excluded: redacting every occurrence of a two-character
  // secret would shred unrelated text and make the log unreadable.
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 6);
  const fields = [...DEFAULT_FIELDS, ...(options.fields ?? [])].map((f) => f.toLowerCase());
  return { secrets: () => secrets, fields: () => fields };
}

function scrubString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redact(value: unknown, redactor: Redactor): unknown {
  return walk(value, redactor.secrets(), new Set(redactor.fields()));
}

function walk(value: unknown, secrets: readonly string[], fields: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets, fields));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = fields.has(key.toLowerCase()) ? REDACTED : walk(item, secrets, fields);
    }
    return out;
  }
  return value;
}

export function redactPayload(payload: Record<string, unknown>, redactor: Redactor): Record<string, unknown> {
  return redact(payload, redactor) as Record<string, unknown>;
}
