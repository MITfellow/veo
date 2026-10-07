import type { TrustLevel } from '../../substrate/events/types.js';
import type { Scope } from '../world/contracts.js';

/**
 * Phase 8 — connector semantic manifests.
 *
 * The existing catalogue (`capability/connectors.ts`) answers "what can the
 * user switch on". It is a good answer to that question and this file does
 * not replace it. What it cannot answer is the question the harness needs:
 * *given an objective, can this connector pursue it, with which identity,
 * at what risk, and how would we know it worked?*
 *
 * One rule governs this file (§19): **model-facing descriptions are
 * generated from here, never written twice.** A connector described once in
 * a manifest and again in a prompt is a connector that will be described
 * two different ways within a month, and the prompt copy will be the stale
 * one because nothing tests prose.
 */

export type HealthState =
  /** Authenticated, permitted, responding. */
  | 'AVAILABLE'
  /** Reachable but impaired — partial scopes, slow, or recently failing. */
  | 'DEGRADED'
  /** Needs the user to sign in again. */
  | 'AUTH_REQUIRED'
  /** Signed in, but the account lacks the scope this needs. */
  | 'PERMISSION_REQUIRED'
  /** Provider is refusing for now. */
  | 'RATE_LIMITED'
  /** Not configured in this build at all. */
  | 'UNAVAILABLE';

/** Health states from which work may actually be attempted. */
export const USABLE: readonly HealthState[] = ['AVAILABLE', 'DEGRADED'];

export interface ImplementedCapability {
  /** The objective this implements, from the ontology. */
  capabilityId: string;
  /** The provider's own operation, for the audit trail and for debugging. */
  operation: string;
  /** Provider scopes an identity must hold. */
  scopes: readonly string[];
  /**
   * How this implementation verifies its own postcondition (§60).
   * Named here rather than in the ontology because verification is a
   * property of the provider: Gmail can read a sent message back by id,
   * and a webhook-only provider cannot.
   */
  verifyBy: 'read-back-by-id' | 'list-and-match' | 'status-code-only' | 'none';
  /** Honest ranking input: how strong that verification actually is (§196). */
  verificationStrength: 'STRONG' | 'MODERATE' | 'WEAK' | 'UNVERIFIED';
  /** Cheap hint for routing; not a promise. */
  typicalLatencyMs: number;
}

export interface ConnectorManifest {
  /** Matches an id in the connector catalogue. */
  connectorId: string;
  /** What this connector *is*, in the user's world, not the vendor's words. */
  represents: string;
  /** World-model node kinds it can populate (§26). */
  readableEntities: readonly string[];
  writableEntities: readonly string[];
  /** Stated plainly, because an absent capability is as useful to know as a present one. */
  cannotDo: readonly string[];
  /** Provider ids whose identities can drive it. */
  identityProviders: readonly string[];
  /** Scopes of the user's life this connector usually carries. */
  typicalScopes: readonly Scope[];
  /** Trust of anything it yields. Never better than FOREIGN for external content. */
  yieldsTrust: TrustLevel;
  implements: readonly ImplementedCapability[];
  /** Effects on the outside world a user would care about. */
  sideEffects: readonly string[];
  failureModes: readonly string[];
  /** Other connectors that could pursue the same objectives (§18, §147). */
  alternatives: readonly string[];
  /** Incremental sync support (§180), so the world is not rebuilt from scratch. */
  sync: { incremental: boolean; cursor: string | null; note: string };
}

/**
 * The manifests.
 *
 * `notes`, `files` and `calendar-local` are implemented today. `gmail`,
 * `gcal` and `github` have real contracts, real policy paths and real
 * verification strategies, and are inert until credentials exist — the
 * same honesty `http.fetch` has carried since M3: a declared contract with
 * nothing behind it is useful; a pretended one is not.
 */
export const MANIFESTS: readonly ConnectorManifest[] = [
  {
    connectorId: 'notes',
    represents: 'What the user has told the agent directly. The spine of everything personal.',
    readableEntities: ['person', 'project', 'commitment', 'preference'],
    writableEntities: ['person', 'project', 'commitment', 'preference'],
    cannotDo: ['reach anyone', 'see anything the user did not say'],
    identityProviders: [],
    typicalScopes: ['PERSONAL', 'WORK'],
    yieldsTrust: 'USER',
    implements: [
      { capabilityId: 'REMEMBER_FACT', operation: 'memory.assert', scopes: [], verifyBy: 'read-back-by-id', verificationStrength: 'STRONG', typicalLatencyMs: 2 },
      { capabilityId: 'RECALL_KNOWLEDGE', operation: 'memory.recall', scopes: [], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 4 },
      { capabilityId: 'RELATE_ENTITIES', operation: 'world.relate', scopes: [], verifyBy: 'read-back-by-id', verificationStrength: 'STRONG', typicalLatencyMs: 3 },
      { capabilityId: 'SEARCH_PERSONAL', operation: 'memory.recall', scopes: [], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 6 },
    ],
    sideEffects: ['the user sees a new entry in their memory'],
    failureModes: ['the trust floor refuses a write derived from untrusted content'],
    alternatives: [],
    sync: { incremental: true, cursor: 'event seq', note: 'It is the event log; nothing to sync.' },
  },
  {
    connectorId: 'files',
    represents: 'Documents in folders the user chose. Local, never uploaded.',
    readableEntities: ['document', 'file'],
    writableEntities: [],
    cannotDo: ['write files', 'read outside the allowed roots', 'see a file the user did not grant'],
    identityProviders: [],
    typicalScopes: ['PERSONAL', 'WORK', 'UNKNOWN'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'READ_FILE_CONTENT', operation: 'file.read', scopes: [], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 3 },
    ],
    sideEffects: [],
    failureModes: ['path outside the allowed roots', 'file removed between listing and reading'],
    alternatives: [],
    sync: { incremental: false, cursor: null, note: 'Read on demand; no index is maintained yet.' },
  },
  {
    connectorId: 'web',
    represents: 'The open internet, as pages fetched on request.',
    readableEntities: ['website', 'document'],
    writableEntities: [],
    cannotDo: ['sign in anywhere', 'keep a session', 'be trusted'],
    identityProviders: [],
    typicalScopes: ['PUBLIC'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'READ_CURRENT_STATE', operation: 'http.fetch', scopes: [], verifyBy: 'status-code-only', verificationStrength: 'WEAK', typicalLatencyMs: 400 },
    ],
    sideEffects: ['an outbound request, logged by origin'],
    failureModes: ['no transport configured', 'origin not on the allow-list', 'redirect off the allow-list'],
    alternatives: [],
    sync: { incremental: false, cursor: null, note: 'Nothing is synced; a page is read when asked for.' },
  },
  {
    connectorId: 'gmail',
    represents: 'The user\u2019s mail: people, threads, attachments, commitments made in writing.',
    readableEntities: ['message', 'conversation', 'person', 'document'],
    writableEntities: ['message'],
    cannotDo: ['delete mail', 'change another person\u2019s mailbox', 'unsend'],
    identityProviders: ['google'],
    typicalScopes: ['PERSONAL', 'WORK'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'SEARCH_PERSONAL', operation: 'users.messages.list', scopes: ['gmail.readonly'], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 700 },
      { capabilityId: 'READ_CURRENT_STATE', operation: 'users.messages.get', scopes: ['gmail.readonly'], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 350 },
      { capabilityId: 'SEND_EXTERNAL_MESSAGE', operation: 'users.messages.send', scopes: ['gmail.send'], verifyBy: 'read-back-by-id', verificationStrength: 'STRONG', typicalLatencyMs: 900 },
    ],
    sideEffects: ['a person receives mail', 'the thread appears in Sent', 'it cannot be unsent'],
    failureModes: ['token expired', 'send quota exceeded', 'recipient rejected', 'sent but the read-back failed'],
    alternatives: ['slack'],
    sync: { incremental: true, cursor: 'historyId', note: 'Gmail history API gives a true incremental cursor.' },
  },
  {
    connectorId: 'gcal',
    represents: 'Where the user\u2019s attention is committed: meetings, who is in them, what they are about.',
    readableEntities: ['meeting', 'event', 'person'],
    writableEntities: ['meeting', 'event'],
    cannotDo: ['make someone attend', 'see a calendar that was not shared'],
    identityProviders: ['google'],
    typicalScopes: ['PERSONAL', 'WORK'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'READ_CURRENT_STATE', operation: 'events.list', scopes: ['calendar.readonly'], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 500 },
      { capabilityId: 'SCHEDULE_COMMITMENT', operation: 'events.insert', scopes: ['calendar.events'], verifyBy: 'read-back-by-id', verificationStrength: 'STRONG', typicalLatencyMs: 800 },
    ],
    sideEffects: ['attendees are notified', 'the user\u2019s availability changes for everyone who can see it'],
    failureModes: ['token expired', 'conflicting event', 'created but the read-back failed'],
    alternatives: ['calendar-local'],
    sync: { incremental: true, cursor: 'syncToken', note: 'Calendar sync tokens expire; a full resync must be handled.' },
  },
  {
    connectorId: 'calendar-local',
    represents: 'An exported calendar file: what the week looks like, without reaching anywhere.',
    readableEntities: ['meeting', 'event'],
    writableEntities: [],
    cannotDo: ['create an event', 'notify anyone', 'see changes made after the export'],
    identityProviders: [],
    typicalScopes: ['PERSONAL', 'WORK'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'READ_CURRENT_STATE', operation: 'ics.read', scopes: [], verifyBy: 'none', verificationStrength: 'MODERATE', typicalLatencyMs: 5 },
    ],
    sideEffects: [],
    // The honest one, and the reason verification is MODERATE: a file is a
    // snapshot, and a snapshot of a calendar is stale the moment it is made.
    failureModes: ['the export is older than the question being asked'],
    alternatives: ['gcal'],
    sync: { incremental: false, cursor: null, note: 'Re-read the file; there is no cursor.' },
  },
  {
    connectorId: 'github',
    represents: 'Technical work: repositories, issues, pull requests, and the decisions inside them.',
    readableEntities: ['project', 'task', 'person', 'document'],
    writableEntities: ['task'],
    cannotDo: ['merge without review', 'act outside the granted repositories'],
    identityProviders: ['github'],
    typicalScopes: ['WORK', 'PROJECT', 'PUBLIC'],
    yieldsTrust: 'FOREIGN',
    implements: [
      { capabilityId: 'SEARCH_PERSONAL', operation: 'search.issues', scopes: ['repo'], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 600 },
      { capabilityId: 'READ_CURRENT_STATE', operation: 'repos.get', scopes: ['repo'], verifyBy: 'none', verificationStrength: 'STRONG', typicalLatencyMs: 400 },
    ],
    sideEffects: [],
    failureModes: ['token expired', 'rate limited', 'repository not granted to the token'],
    alternatives: [],
    sync: { incremental: true, cursor: 'updated_at', note: 'Poll by updated_at; no push without a webhook endpoint.' },
  },
];

const BY_CONNECTOR = new Map(MANIFESTS.map((m) => [m.connectorId, m]));

export function manifest(connectorId: string): ConnectorManifest | undefined {
  return BY_CONNECTOR.get(connectorId);
}

/** Every manifest that implements an objective. The broker's search space. */
export function implementorsOf(capabilityId: string): Array<{ manifest: ConnectorManifest; impl: ImplementedCapability }> {
  return MANIFESTS.flatMap((m) => {
    const impl = m.implements.find((i) => i.capabilityId === capabilityId);
    return impl === undefined ? [] : [{ manifest: m, impl }];
  });
}

/**
 * The model-facing description of a connector, generated.
 *
 * §19's rule in one function: there is no second copy of this prose
 * anywhere, so it cannot drift from the manifest it describes.
 */
export function describeForModel(m: ConnectorManifest, health: HealthState): string {
  const can = m.implements.map((i) => i.capabilityId).join(', ');
  const lines = [
    `${m.connectorId} — ${m.represents}`,
    `  status: ${health}${USABLE.includes(health) ? '' : ' (do not plan work that needs it)'}`,
    `  can: ${can === '' ? 'nothing yet' : can}`,
    `  cannot: ${m.cannotDo.join('; ')}`,
    `  yields: ${m.yieldsTrust} content`,
  ];
  if (m.alternatives.length > 0) lines.push(`  instead, if unavailable: ${m.alternatives.join(', ')}`);
  return lines.join('\n');
}
