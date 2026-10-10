import { z } from 'zod';
import { allConnectors, combinationRisk, getConnector, type Connector } from '../capability/connectors.js';
import { describeJobs, modelAttached } from '../cognition/registry.js';
import { JOB_NAMES } from '../cognition/types.js';
import type { Config } from '../substrate/config.js';
import type { Storage } from '../substrate/ports.js';
import { CURRENT_SCHEMA_VERSION } from '../substrate/storage/migrations.js';

/**
 * The JSON API behind the Get Started surface.
 *
 * Pure functions of (state, request) → response, with the HTTP plumbing
 * next door in `http.ts`. Written this way because the interesting part is
 * the policy — what a connector is allowed to claim, what the model page is
 * permitted to store — and policy should be testable without a socket.
 */

export interface ApiResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const badRequest = (message: string, detail?: unknown): ApiResponse => ({
  status: 400,
  body: { error: message, detail: detail ?? null },
});
const notFound = (message: string): ApiResponse => ({ status: 404, body: { error: message } });

/**
 * Connector enablement is durable state, not a projection.
 *
 * Same reasoning as decision 006: a rebuild drops projections, and a
 * rebuild that silently disconnected every connector would be
 * indistinguishable from a factory reset.
 */
export function ensureConnectorTable(storage: Storage): void {
  storage.exec(`
    CREATE TABLE IF NOT EXISTS connector_state (
      id          TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 0,
      enabled_at  INTEGER
    )
  `);
}

function enabledIds(storage: Storage): Set<string> {
  const rows = storage.prepare('SELECT id FROM connector_state WHERE enabled = 1').all<{ id: string }>();
  return new Set(rows.map((r) => r.id));
}

export interface ConnectorView extends Connector {
  enabled: boolean;
  /** Sensitive capabilities, surfaced so the UI can explain the cost. */
  grants: string[];
}

export function listConnectors(storage: Storage): ApiResponse {
  const on = enabledIds(storage);
  const items: ConnectorView[] = allConnectors().map((c) => ({
    ...c,
    enabled: on.has(c.id),
    grants: c.capabilities,
  }));
  const active = allConnectors().filter((c) => on.has(c.id));
  return ok({
    connectors: items,
    counts: {
      available: items.filter((c) => c.status === 'available').length,
      blocked: items.filter((c) => c.status === 'blocked').length,
      enabled: active.length,
    },
    risk: combinationRisk(active),
  });
}

const ToggleBody = z.object({ enabled: z.boolean() }).strict();

export function setConnector(storage: Storage, id: string, rawBody: unknown, now: number): ApiResponse {
  const connector = getConnector(id);
  if (connector === undefined) return notFound(`No connector '${id}'.`);

  const parsed = ToggleBody.safeParse(rawBody);
  if (!parsed.success) return badRequest('Body must be {"enabled": boolean}.', parsed.error.issues);

  const { enabled } = parsed.data;
  // A blocked connector may still be *chosen*. Recording the intent is
  // useful — it is what the platform will enable first when the missing
  // capability lands — but it must never report itself as working.
  storage
    .prepare('INSERT INTO connector_state (id, enabled, enabled_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at')
    .run(id, enabled ? 1 : 0, enabled ? now : null);

  const active = allConnectors().filter((c) => enabledIds(storage).has(c.id));
  return ok({
    id,
    enabled,
    effective: enabled && connector.status === 'available',
    note: connector.status === 'blocked' ? connector.blockedBecause : '',
    risk: combinationRisk(active),
  });
}

/** Everything the model page shows. Never includes a key, only a reference. */
export function modelStatus(config: Config): ApiResponse {
  const attached = modelAttached(config);
  return ok({
    attached,
    provider: config.model.provider,
    name: config.model.name,
    apiKeyRef: config.model.apiKeyRef,
    baseUrl: config.model.baseUrl,
    maxOutputTokens: config.model.maxOutputTokens,
    temperature: config.model.temperature,
    degradation: attached ? 'L2' : 'L1',
    // The honest sentence, repeated wherever the model is discussed.
    statement: attached
      ? 'A model is configured. No provider transport is compiled into this build, so jobs routed to it will fail loudly rather than silently falling back.'
      : 'No model configured — L1, the intended state of this build. All eleven cognitive jobs are served by deterministic baselines.',
    jobs: describeJobs(config),
    jobCount: JOB_NAMES.length,
  });
}

/**
 * Validate a proposed model configuration without applying it.
 *
 * The page cannot actually attach a model — there is no provider — so the
 * useful thing it can do is tell the user precisely what they would need,
 * and prove the config they typed would parse. Writing a config that would
 * later fail to load is worse than refusing it now.
 */
const ProposedModel = z
  .object({
    provider: z.enum(['none', 'openai', 'anthropic', 'ollama', 'openai-compatible']),
    name: z.string().default(''),
    apiKeyRef: z.string().default(''),
    baseUrl: z.string().default(''),
  })
  .strict();

const SECRET_REF = /^secret:\/\/[^/]+\/\d+$/;

/**
 * Does this look like somebody pasted the actual credential?
 *
 * Worth detecting specifically. The field asks for a reference, so a raw
 * key here is a user mistake we can catch at the moment it happens —
 * before it reaches a config file, a log line or a screenshot.
 */
function looksLikeRawKey(value: string): boolean {
  if (value.length === 0 || SECRET_REF.test(value)) return false;
  return /^(sk-|pk-|ghp_|gho_|xox[abprs]-|AIza|hf_)/.test(value) || value.length > 24;
}

/** What this provider still needs. Pure, so the rules are readable at a glance. */
function missingFor(p: z.infer<typeof ProposedModel>): string[] {
  if (p.provider === 'none') return [];
  const missing: string[] = [];
  if (p.name.trim().length === 0) missing.push('a model name');
  if ((p.provider === 'openai' || p.provider === 'anthropic') && !SECRET_REF.test(p.apiKeyRef)) {
    missing.push(
      looksLikeRawKey(p.apiKeyRef)
        ? 'That looks like the key itself, not a reference to it. Store it with "arish vault set <name>" and paste the secret:// reference you get back — a credential must never sit in configuration (§23).'
        : 'an API key stored in the vault (run: arish vault set <name>, then paste the secret:// reference)',
    );
  }
  if ((p.provider === 'ollama' || p.provider === 'openai-compatible') && p.baseUrl.trim().length === 0) {
    missing.push('a base URL');
  }
  return missing;
}

export function checkModel(rawBody: unknown): ApiResponse {
  const parsed = ProposedModel.safeParse(rawBody);
  if (!parsed.success) return badRequest('Invalid model settings.', parsed.error.issues);
  const { provider, name, apiKeyRef, baseUrl } = parsed.data;
  const missing = missingFor(parsed.data);

  return ok({
    valid: missing.length === 0,
    missing,
    // The part people need to hear twice.
    wouldWork: false,
    blockers: [
      'This build compiles no provider transport and makes no network calls (§2).',
      'Attaching one is a configuration change plus a provider function — the prompts, parsers, schemas and budgets for all eleven jobs already exist and are tested.',
    ],
    // The example never echoes a value that is not already a reference.
    // Reflecting a pasted credential back would put it in the response
    // body, the browser's memory and any log that captured either.
    envExample: provider === 'none'
      ? ''
      : [
          `ARISH_MODEL_PROVIDER=${provider}`,
          `ARISH_MODEL_NAME=${name || '<model-name>'}`,
          SECRET_REF.test(apiKeyRef) ? `ARISH_MODEL_API_KEY_REF=${apiKeyRef}` : '',
          baseUrl ? `ARISH_MODEL_BASE_URL=${baseUrl}` : '',
        ].filter(Boolean).join('\n'),
  });
}

export function platformStatus(storage: Storage, config: Config, eventCount: number): ApiResponse {
  const on = enabledIds(storage);
  return ok({
    name: 'ARISH',
    tagline: 'A personal agent that runs on your machine and forgets when you tell it to.',
    schema: CURRENT_SCHEMA_VERSION,
    events: eventCount,
    autonomy: config.autonomy,
    degradation: modelAttached(config) ? 'L2' : 'L1',
    dataDir: config.dataDir,
    connectorsEnabled: on.size,
    jobs: JOB_NAMES.length,
    principles: [
      {
        title: 'Everything is an event',
        body: 'Every change is an append-only, hash-chained event. Projections are derived and can be dropped and rebuilt byte-identically — proven against ten thousand events on every test run.',
      },
      {
        title: 'Forgetting is cryptographic',
        body: 'Content is encrypted under per-item keys. Forgetting deletes the key, so the data is unreadable even with the database, the passphrase and an unlocked vault.',
      },
      {
        title: 'Untrusted content cannot act',
        body: 'Anything from outside enters a quarantine and reaches the rest of the system as a reference with no bytes in it. Twelve real injection attacks are in the test suite and fail with no prompt defences at all.',
      },
      {
        title: 'The Rule of Two',
        body: 'Private data, untrusted content, and the ability to change the outside world: any two are fine, all three need you. Proven exhaustively across 891 cases.',
      },
      {
        title: 'No model, on purpose',
        body: 'Eleven cognitive jobs each have a deterministic baseline that works today and a model strategy that is written, tested and inert. Attaching a model is configuration, not surgery.',
      },
    ],
  });
}

export { badRequest, notFound, ok };

/**
 * §13 — the outbox, as the UI sees it.
 *
 * Read-only, deliberately. Reconciling is a decision with consequences in
 * the outside world and belongs behind `arish effects reconcile`, where a
 * person has typed something rather than clicked something on a page that
 * might have been left open.
 */
export function effectsStatus(storage: Storage): ApiResponse {
  const rows = storage
    .prepare(`SELECT key, tool, status, summary, detail, remote_ref AS remoteRef, intended_at AS intendedAt
                FROM outbox ORDER BY intended_at DESC LIMIT 100`)
    .all<Record<string, unknown>>();
  const count = (status: string): number =>
    storage.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get<{ n: number }>(status)?.n ?? 0;

  return ok({
    pending: count('intended'),
    needsAttention: count('needs_attention'),
    committed: count('committed'),
    effects: rows,
    explain:
      'An effect is recorded before it is attempted and again after it succeeds. Anything still unsettled is something we cannot prove either way — and nothing is ever retried on a guess.',
  });
}
