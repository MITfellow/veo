/**
 * §20 — the degradation ladder.
 *
 * A personal agent spends most of its life partly broken: no network, a
 * locked vault, an expired token, a provider that is down. The failure
 * mode to avoid is the one where it pretends otherwise and produces a
 * confident answer built on nothing.
 *
 * So capability is a **rung, not a boolean**, it is computed from
 * observable signals rather than asserted, and every rung names what it
 * has lost in words a person can act on.
 *
 * L0 is the top. The ladder descends into safety: a lower rung can always
 * do strictly less than the one above, never something different. That
 * property is what lets a caller check `rung <= L2` and know exactly what
 * it is promised.
 */

export type Rung = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

export const RUNGS: readonly Rung[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

/** What the platform can observe about itself. All of it is cheap to read. */
export interface Signals {
  /** A model provider is configured *and* reachable. */
  modelAttached: boolean;
  modelReachable: boolean;
  /** Outbound network is permitted and working. */
  networkUp: boolean;
  /** The vault is unlocked, so encrypted items can be read. */
  vaultUnlocked: boolean;
  /** At least one connector holds a valid credential. */
  credentialsValid: boolean;
  /** The database accepts writes. */
  storageWritable: boolean;
  /** The event log's hash chain verifies. */
  chainIntact: boolean;
}

export interface Assessment {
  rung: Rung;
  /** One line for a status bar. */
  label: string;
  /** Why this rung and not the one above. Always the *binding* reason. */
  reason: string;
  /** What is unavailable here, in the user's terms. */
  lost: readonly string[];
  /** What still works, so the user is not told only bad news. */
  kept: readonly string[];
}

export const DEFAULT_SIGNALS: Signals = {
  modelAttached: false,
  modelReachable: false,
  networkUp: true,
  vaultUnlocked: true,
  credentialsValid: true,
  storageWritable: true,
  chainIntact: true,
};

/**
 * The ladder, worst first.
 *
 * Evaluated in order, and **the first match wins**, so the binding
 * constraint is always the most severe one. Writing it worst-first is
 * deliberate: a reader sees the catastrophic cases before the ordinary
 * ones, which is the opposite of how the system spends its time and
 * exactly how someone debugging it reads the file.
 */
interface Step {
  rung: Rung;
  when(s: Signals): boolean;
  label: string;
  reason: string;
  lost: readonly string[];
  kept: readonly string[];
}

const LADDER: readonly Step[] = [
  {
    rung: 'L6',
    when: (s) => !s.chainIntact,
    label: 'Read-only — the record is damaged',
    reason: 'the event log hash chain does not verify',
    lost: ['Writing anything new', 'Running any tool', 'Trusting what is already stored'],
    kept: ['Reading the log', 'Exporting it for inspection'],
  },
  {
    rung: 'L5',
    when: (s) => !s.storageWritable,
    label: 'Read-only — the database will not accept writes',
    reason: 'the data directory is not writable',
    lost: ['Remembering anything new', 'Running tools that record', 'Approvals'],
    kept: ['Answering from what is already known'],
  },
  {
    rung: 'L4',
    when: (s) => !s.vaultUnlocked,
    label: 'Locked — encrypted material is unavailable',
    reason: 'the vault is locked',
    lost: ['Reading encrypted items', 'Any connector that needs a token', 'Sending anything'],
    kept: ['Unencrypted memory', 'Reading the log', 'Everything deterministic'],
  },
  {
    rung: 'L3',
    when: (s) => !s.networkUp,
    label: 'Offline — this machine only',
    reason: 'no outbound network',
    lost: ['Connectors', 'Browsing', 'Anything that reaches another computer'],
    kept: ['All memory', 'All fifteen cognitive baselines', 'Local tools'],
  },
  {
    rung: 'L2',
    when: (s) => !s.credentialsValid,
    label: 'Degraded — connectors need attention',
    reason: 'no connector holds a valid credential',
    lost: ['Calendar, mail and anything else behind a sign-in'],
    kept: ['Memory', 'Browsing', 'Everything local'],
  },
  {
    rung: 'L1',
    when: (s) => !s.modelAttached || !s.modelReachable,
    label: 'Baselines — no model attached',
    reason: 'no model provider configured',
    lost: ['Paraphrasing', 'Open-ended composition', 'Anything needing fluency'],
    kept: ['Every cognitive job, on its deterministic baseline', 'Memory', 'Tools', 'Connectors'],
  },
  {
    rung: 'L0',
    when: () => true,
    label: 'Full capability',
    reason: 'everything the platform depends on is available',
    lost: [],
    kept: ['Everything'],
  },
];

/**
 * Where are we on the ladder?
 *
 * Pure, so the UI, the CLI and a test all compute the same answer from
 * the same facts and there is no second opinion anywhere in the system.
 */
export function assess(signals: Partial<Signals> = {}): Assessment {
  const full: Signals = { ...DEFAULT_SIGNALS, ...signals };
  // `at(-1)` is L0, which matches everything, so this cannot be undefined —
  // but the type system does not know that and will not be told with a `!`.
  const step = LADDER.find((candidate) => candidate.when(full)) ?? LADDER[LADDER.length - 1];
  if (step === undefined) throw new Error('The degradation ladder is empty.');
  return { rung: step.rung, label: step.label, reason: step.reason, lost: step.lost, kept: step.kept };
}

/** Is the platform at or above a required rung? `L0` is the highest. */
export function atLeast(current: Rung, required: Rung): boolean {
  return RUNGS.indexOf(current) <= RUNGS.indexOf(required);
}

/**
 * The one sentence a user should see when something is refused.
 *
 * Phrased as the state of the machine rather than a rejection of them:
 * "the vault is locked" is actionable, "permission denied" is not.
 */
export function explain(assessment: Assessment): string {
  if (assessment.rung === 'L0') return 'Everything is available.';
  return `${assessment.label} — ${assessment.reason}. Unavailable: ${assessment.lost.join('; ')}.`;
}
