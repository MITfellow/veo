import { z } from 'zod';
import type { TrustLevel } from '../substrate/events/types.js';
import { SENSITIVE_CAPABILITIES } from './ruleoftwo.js';

/**
 * The connector catalogue (§24).
 *
 * A connector is a source of data or a place to act. Two things about this
 * file matter more than the list itself:
 *
 *   **Every connector declares its trust level**, and anything reaching the
 *   outside world declares FOREIGN. That is not a label — it is what routes
 *   the data into the quarantine and what makes the Rule of Two refuse to
 *   combine it with private data and an external effect (§19, §21).
 *
 *   **It is honest about what works.** Nothing here claims to be connected.
 *   A connector whose requirements are unmet is shown with the requirement
 *   named, because "coming soon" that looks identical to "working" is how a
 *   user ends up trusting an integration that does nothing.
 */

export type ConnectorFamily = 'local' | 'saas';

/**
 * Why a connector cannot be used yet. Each value is a missing *capability
 * of this build*, not a missing credential of the user's.
 */
export type Requirement = 'network' | 'oauth' | 'filesystem' | 'none';

export type ConnectorStatus =
  /** Everything it needs exists; adding it genuinely enables it. */
  | 'available'
  /** Shipped and inert: the platform lacks something it needs. */
  | 'blocked';

export interface Connector {
  id: string;
  name: string;
  blurb: string;
  family: ConnectorFamily;
  /** Inline SVG path data, drawn in a 24×24 box. */
  icon: string;
  accent: string;
  /** Trust of anything this connector yields (§20). */
  yieldsTrust: TrustLevel;
  /** Capabilities it needs, checked against the Rule of Two (§19). */
  capabilities: string[];
  requires: Requirement;
  status: ConnectorStatus;
  /** Shown verbatim when the connector is blocked. */
  blockedBecause: string;
}

const CATALOGUE: readonly Connector[] = [
  {
    id: 'files',
    name: 'Files and folders',
    blurb: 'Read documents and notes from folders you choose. Nothing is uploaded anywhere.',
    family: 'local',
    icon: 'M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    accent: '#f2b705',
    yieldsTrust: 'FOREIGN',
    capabilities: ['files:read'],
    requires: 'filesystem',
    status: 'available',
    blockedBecause: '',
  },
  {
    id: 'notes',
    name: 'Notes',
    blurb: 'Things you tell the agent directly. Always on — this is the memory it builds about you.',
    family: 'local',
    icon: 'M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 1v5h5M7 13h10M7 17h7',
    accent: '#5b8def',
    yieldsTrust: 'USER',
    capabilities: ['memory:write'],
    requires: 'none',
    status: 'available',
    blockedBecause: '',
  },
  {
    id: 'clipboard',
    name: 'Clipboard capture',
    blurb: 'Send a selection to the agent on demand. Captured text is treated as untrusted and quarantined.',
    family: 'local',
    icon: 'M9 3h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V4a1 1 0 0 1 1-1z',
    accent: '#8b5cf6',
    yieldsTrust: 'FOREIGN',
    capabilities: ['capture:read'],
    requires: 'none',
    status: 'available',
    blockedBecause: '',
  },
  {
    id: 'calendar-local',
    name: 'Local calendar (.ics)',
    blurb: 'Read an exported calendar file to know what your week looks like.',
    family: 'local',
    icon: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm0 4h16M8 2v4M16 2v4',
    accent: '#e8554e',
    yieldsTrust: 'FOREIGN',
    capabilities: ['calendar:read', 'files:read'],
    requires: 'filesystem',
    status: 'available',
    blockedBecause: '',
  },
  {
    id: 'browser-history',
    name: 'Browser history',
    blurb: 'What you have been reading, so the agent can pick up a thread you left open.',
    family: 'local',
    icon: 'M12 3a9 9 0 1 0 9 9h-9zM12 3v9l6.4 6.4',
    accent: '#0ea5e9',
    yieldsTrust: 'FOREIGN',
    capabilities: ['browser:read', 'files:read'],
    requires: 'filesystem',
    status: 'available',
    blockedBecause: '',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    blurb: 'Read and draft mail. Drafts are never sent without you approving them.',
    family: 'saas',
    icon: 'M3 7l9 6 9-6M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    accent: '#ea4335',
    yieldsTrust: 'FOREIGN',
    capabilities: ['email:read', 'effect:external', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs OAuth and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'gcal',
    name: 'Google Calendar',
    blurb: 'Two-way calendar access, so the agent can see your week and propose changes to it.',
    family: 'saas',
    icon: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm0 4h16M8 2v4M16 2v4M11 14h2',
    accent: '#4285f4',
    yieldsTrust: 'FOREIGN',
    capabilities: ['calendar:read', 'calendar:write', 'effect:external', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs OAuth and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'slack',
    name: 'Slack',
    blurb: 'Catch up on channels and threads you were away from.',
    family: 'saas',
    icon: 'M6 14a2 2 0 1 1-2-2h2zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0zm3-8a2 2 0 1 1 2 2h-2zm0 1a2 2 0 1 1 0 4H5a2 2 0 1 1 0-4z',
    accent: '#4a154b',
    yieldsTrust: 'FOREIGN',
    capabilities: ['chat:read', 'effect:external', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs OAuth and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'notion',
    name: 'Notion',
    blurb: 'Your pages and databases as a source of durable facts.',
    family: 'saas',
    icon: 'M5 4h14v16H5zM9 8v8l6-8v8',
    accent: '#111111',
    yieldsTrust: 'FOREIGN',
    capabilities: ['docs:read', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs OAuth and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'github',
    name: 'GitHub',
    blurb: 'Issues, pull requests and the state of what you are building.',
    family: 'saas',
    icon: 'M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .3.3.7 1 .7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z',
    accent: '#24292f',
    yieldsTrust: 'FOREIGN',
    capabilities: ['code:read', 'effect:external', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs OAuth and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    blurb: 'Messages and the commitments buried in them.',
    family: 'saas',
    icon: 'M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3zm0 2a7 7 0 1 1-3.6 13l-.3-.2-2.2.6.6-2.1-.2-.3A7 7 0 0 1 12 5z',
    accent: '#25d366',
    yieldsTrust: 'FOREIGN',
    capabilities: ['chat:read', 'effect:external', 'net:egress'],
    requires: 'oauth',
    status: 'blocked',
    blockedBecause: 'Needs a linked device session and an outbound network port. This build makes no network calls at all.',
  },
  {
    id: 'web',
    name: 'Web browsing',
    blurb: 'Fetch and read a page you point it at. Page content is the textbook injection vector, so it is always quarantined.',
    family: 'saas',
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 0c2.5 2.3 3.8 5.4 3.8 9s-1.3 6.7-3.8 9c-2.5-2.3-3.8-5.4-3.8-9s1.3-6.7 3.8-9zM3.5 9h17M3.5 15h17',
    accent: '#0f766e',
    yieldsTrust: 'FOREIGN',
    capabilities: ['web:read', 'net:egress'],
    requires: 'network',
    status: 'blocked',
    blockedBecause: 'Needs an outbound network port, which this build does not have. The quarantine that would receive the page content is already built and tested.',
  },
];

export function allConnectors(): readonly Connector[] {
  return CATALOGUE;
}

export function getConnector(id: string): Connector | undefined {
  return CATALOGUE.find((c) => c.id === id);
}

/** Capabilities a connector contributes that the Rule of Two considers sensitive. */
export function sensitiveCapabilitiesOf(connector: Connector): string[] {
  return connector.capabilities.filter((c) => (SENSITIVE_CAPABILITIES as readonly string[]).includes(c));
}

export const ConnectorStateSchema = z
  .object({ id: z.string().min(1), enabled: z.boolean(), enabledAt: z.number().int().nullable().default(null) })
  .strict();

export type ConnectorState = z.infer<typeof ConnectorStateSchema>;

/**
 * Whether enabling this set together would create an unsupervised
 * Rule-of-Two violation (§19).
 *
 * Checked when a connector is added rather than when it is used, because
 * the moment to tell someone that combining their email with web browsing
 * creates an exfiltration path is while they are choosing, not afterwards.
 */
export function combinationRisk(enabled: readonly Connector[]): { risky: boolean; why: string } {
  const privateData = enabled.some((c) => c.capabilities.some((cap) => /^(email|files|calendar|chat|docs|code|browser):read$/.test(cap)));
  const untrusted = enabled.some((c) => c.yieldsTrust === 'FOREIGN' && c.family === 'saas');
  const externalEffect = enabled.some((c) => c.capabilities.includes('effect:external') || c.capabilities.includes('net:egress'));

  if (privateData && untrusted && externalEffect) {
    return {
      risky: true,
      why: 'These connectors together hold all three Rule of Two properties: access to your private data, exposure to untrusted content, and the ability to change something outside this machine. Actions combining all three will require your explicit approval each time.',
    };
  }
  return { risky: false, why: '' };
}
