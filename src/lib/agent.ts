/**
 * The browser's side of the agent.
 *
 * Veo talks to the ARISH runtime (`/agent/*`) over the same HTTP + SSE
 * surface any other client would use — §29, no private back door. Two
 * consequences worth stating, because they are design decisions and not
 * accidents:
 *
 * - **The browser never holds the agent token.** The dev server attaches it
 *   on the way through (see `vite.config.ts`). A token in `localStorage` is
 *   a token in every XSS report for the rest of the project's life.
 * - **Streaming is read with `fetch`, not `EventSource`.** `EventSource`
 *   cannot send headers, cannot be cancelled cleanly, and silently
 *   reconnects in a way that would replay a run. The protocol here is
 *   simple enough to parse in forty lines, and those forty lines are
 *   testable without a browser.
 */

/* ─────────────────────────── §22.8: memory ──────────────────────────────── */

export interface MemoryFact {
  id: string;
  text: string;
  predicate: string;
  basis: 'observed' | 'inferred' | 'asserted_by_user' | 'imported';
  confidence: number;
  sourceCount: number;
  observationCount: number;
  status: 'active' | 'disputed' | 'quarantined' | 'retired';
  pinned: boolean;
  sensitivity: 'normal' | 'private' | 'secret';
  trust: string;
  recordedAt: number;
  validTo: number | null;
}

export interface MemoryCounts {
  active: number;
  disputed: number;
  quarantined: number;
  retired: number;
  pinned: number;
}

export interface MemoryExplanation {
  fact: MemoryFact;
  sources: Array<{ eventId: string; quote?: string }>;
  history: Array<{ text: string; recordedAt: number; confidence: number; status: string }>;
  explanation: string[];
}

export interface MemoryFilter {
  q?: string;
  basis?: string;
  minConfidence?: number;
  status?: string;
  pinned?: boolean;
}

/* ─────────────────────────── §25: the constitution ──────────────────────── */

export interface ConstitutionArticle {
  id: string;
  text: string;
  origin: 'founding' | 'user' | 'proposed';
  kind: string;
  /** How the article is kept: said, screened, or enforced in code elsewhere. */
  enforcement: 'advisory' | 'checked' | 'structural';
  check: string | null;
  /** What the check cannot see. Shown in the UI; honesty is the point. */
  checkMisses: string | null;
  checkDescribes: string | null;
  remedy: string;
  enforcedBy: string;
  entrenched: boolean;
  subject: string;
  stance: string;
  cites: string;
  supersededBy: string | null;
  addedVersion: number;
}

export interface ConstitutionDoc {
  version: number;
  hash: string;
  ratifiedAt: number;
  articles: ConstitutionArticle[];
  conflicts: Array<{ winner: string; loser: string; subject: string; reason: string }>;
  proposals: Array<{ id: string; article: ConstitutionArticle; rationale: string }>;
}

export interface Amendment {
  version: number;
  hash: string;
  at: number;
  change: string;
  articleId: string;
  author: string;
}

export interface Compliance {
  windowDays: number;
  articles: Array<{
    articleId: string;
    check: string;
    upheld: number;
    violated: number;
    unverifiable: number;
  }>;
  recentViolations: Array<{ at: number; article_id: string; detail: string; remedy: string }>;
}

export interface CalibrationView {
  calibration: {
    brier: number;
    resolved: number;
    unresolved: number;
    meaningful: boolean;
    withinThreshold: boolean;
    buckets: Array<{ from: number; to: number; count: number; predicted: number; observed: number }>;
  };
  probes: { budget: { perDay: number; perSession: number }; askedToday: number; pending: number; declined: number; unresolvable: number };
  bias: {
    agreementRate: number;
    positionFlipRate: number;
    sourceDiversity: number;
    staleness: number;
    protectedAttributeHits: string[];
    regressions: string[];
    turns: number;
  };
}

/* ──────────────────────── §28: time and proactivity ─────────────────────── */

export type CatchUp = 'fire-all' | 'fire-once' | 'skip';

export interface ScheduleView {
  id: string;
  name: string;
  kind: 'cron' | 'once';
  spec: string;
  timezone: string;
  prompt: string;
  catchUp: CatchUp;
  enabled: boolean;
  lastFiredAt: number | null;
  nextFireAt: number | null;
  fireCount: number;
  /** Slots that passed while nothing was running. Shown, never hidden. */
  missedCount: number;
}

export interface JobView {
  id: string;
  kind: string;
  status: 'pending' | 'leased' | 'done' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lastError: string | null;
  scheduleId: string | null;
  enqueuedAt: number;
}

/** §28 — a job that used every retry and was kept rather than dropped. */
export interface DeadLetterView {
  id: string;
  kind: string;
  principal: string;
  attempts: number;
  error: string;
  scheduleId: string | null;
  diedAt: number;
  replayedAt: number | null;
}

export interface DegradationView {
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
  meaning: string;
  signals: Array<{ signal: string; level: string; detail: string; since: number }>;
}

export interface PersonaView {
  agentName: string;
  addressUser: string;
  formality: 'plain' | 'warm' | 'formal';
  length: 'brief' | 'normal' | 'thorough';
  emoji: boolean;
  language: string;
  notes: string;
}

export interface MetricsView {
  runs: { total: number; finished: number; failed: number; byTrigger: Record<string, number> };
  latency: {
    modelMs: { p50: number | null; p95: number | null };
    contextAssemblyMs: { p95: number | null; budgetMs: number; met: boolean | null };
    memoryRecallMs: { p95: number | null; budgetMs: number; met: boolean | null };
  };
  tokens: { input: number; output: number; perRun: number | null };
  cost: { cents: number };
  tools: { succeeded: number; failed: number; denied: number; successRate: number | null };
  memory: { facts: number; pinned: number; hitRate: number | null };
  context: { utilization: number | null; evictions: number };
  honesty: { agreementRate: number | null; calibrationError: number | null };
  approvals: { requested: number; granted: number; denied: number };
  degradation: { current: string };
}

export interface BackupReport {
  ok: boolean;
  events: number;
  chain: { ok: boolean };
  projections: { digestMatches: boolean };
  contents: { facts: number; sessions: number; schedules: number; constitutionVersion: number };
  notes: string[];
  elapsedMs: number;
}

/**
 * §13's vault, as much of it as is safe to describe.
 *
 * There is no `value` field and there will not be one: the server never
 * sends plaintext out of the vault, and the client type is written so
 * that a server that started doing so would not compile into the UI.
 */
export interface SecretView {
  name: string;
  version: number;
  label: string | null;
  createdAt: number;
  rotatedAt: number | null;
  destroyedAt: number | null;
  lastReadAt: number | null;
  readCount: number;
}

export interface VaultView {
  state: 'uninitialized' | 'locked' | 'unlocked';
  secrets: SecretView[];
}

/** §30 — one row of the log, as the inspector shows it. */
export interface EventView {
  seq: number;
  id: string;
  type: string;
  ts: number;
  trust: string;
  sessionId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
}

export interface EventFilter {
  types?: string[];
  sessionId?: string;
  runId?: string;
  limit?: number;
  /**
   * The cursor, exclusive: "everything after the last row I saw".
   * Omitted means the newest page, which is what a reader opening the
   * log for the first time wants.
   */
  sinceSeq?: number;
}

export interface EventPage {
  events: EventView[];
  total: number;
  /** Pass this back as `sinceSeq` to continue. Safe on an empty page. */
  nextSeq: number;
  hasMore: boolean;
}

/**
 * §30's structured trace. A faithful subset of the agent's `Trace`: the
 * fields the UI renders, named exactly as the server names them, so a
 * rename on either side is a type error rather than an empty panel.
 */
export interface TraceView {
  runId: string;
  sessionId: string | null;
  trigger: string | null;
  startedAt: number | null;
  endedAt: number | null;
  status: 'finished' | 'failed' | 'cancelled' | 'suspended' | 'running';
  reason: string | null;
  context: {
    digest: string;
    totalTokens: number;
    policyVersion: string;
    blocks: Array<{ name: string; tokens: number; items: number }>;
    drops: Array<{ block: string; dropped: number; reason: string }>;
  } | null;
  modelCalls: Array<{
    at: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number | null;
    latencyMs: number | null;
    finishReason: string | null;
    failed: string | null;
  }>;
  toolCalls: Array<{ at: number; tool: string; outcome: string; durationMs: number | null; detail: string }>;
  recalls: Array<{ at: number; query: string; candidates: number; selected: string[] }>;
  approvals: Array<{ at: number; tool: string; risk: string; decision: string | null }>;
  governance: Array<{ at: number; articleId: string; verdict: string; detail: string }>;
  degradation: Array<{ at: number; level: string; reason: string }>;
  totals: { steps: number; tokens: number; costCents: number; toolMs: number; wallMs: number };
}

export interface AgentSession {
  id: string;
  title: string | null;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
  trust: string;
}

export interface PendingApproval {
  id: string;
  runId: string;
  tool: string;
  preview: string;
  risk: string;
  requestedAt: number;
  expiresAt: number;
}

/** What a caller can learn from a run, in the order the runtime learns it. */
export interface RunHandlers {
  onDelta?: (text: string) => void;
  onStep?: (index: number, trust: string) => void;
  onStepDone?: (index: number, outcome: string, durationMs: number) => void;
  onTool?: (tool: string) => void;
  /**
   * §27's ladder moved while this run was in flight. The run is still
   * going; it is going with less. A UI that drops this frame is telling
   * the user a comfortable lie about what just answered them.
   */
  onDegraded?: (level: string, reason: string) => void;
  /** The run stopped because someone asked it to, not because it failed. */
  onCancelled?: () => void;
  /** Came back from an approval suspension. */
  onResumed?: () => void;
  onApproval?: (approval: { id: string; tool: string; preview: string; risk: string }) => void;
  onApprovalDecided?: (id: string, outcome: string) => void;
  onMessage?: (text: string) => void;
  onDone?: (summary: { reason: string; steps: number; tokens: number }) => void;
  onError?: (message: string) => void;
  onSuspended?: () => void;
}

/** §13 — the vault is sealed. Recoverable, and the panel says how. */
export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock it with your passphrase to see or change secrets.');
    this.name = 'VaultLockedError';
  }
}

export class AgentUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The agent is not reachable (${cause}). Start it with \`npm run agent\`, or ` +
        `run \`npm run dev\` which starts both.`,
    );
    this.name = 'AgentUnavailableError';
  }
}

const BASE = '/agent';

/**
 * The exact sentence `POST /vault/panic` demands. Irreversible actions
 * get a literal rather than a boolean: a dialog can be clicked through,
 * a sentence has to be typed.
 */
export const PANIC_CONFIRMATION = 'destroy my secrets';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      // Every one of these reads mutable state, and some of it changes in
      // response to the click that triggered the read. Chrome was reusing
      // an identical earlier GET from its memory cache — pinning a memory
      // and immediately re-listing returned the pre-pin copy — so the
      // client says what it means rather than trusting the server's
      // `cache-control` to be honoured in every browser.
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new AgentUnavailableError(error instanceof Error ? error.message : 'network error');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // §13: a locked vault answers 423 to every route that would read a
    // secret. That is a state the user can fix, not an error they should
    // have to decode out of a status code.
    if (response.status === 423) throw new VaultLockedError();
    throw new Error(`agent returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/** The same call, for routes that answer in text rather than JSON. */
async function callText(path: string, init?: RequestInit): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, cache: 'no-store' });
  } catch (error) {
    throw new AgentUnavailableError(error instanceof Error ? error.message : 'network error');
  }
  if (!response.ok) throw new Error(`agent returned ${response.status}`);
  return response.text();
}

export const agent = {
  async health(): Promise<{ status: string; degradation: string; events: number }> {
    return call('/health');
  },

  async createSession(title: string): Promise<AgentSession> {
    return call('/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  },

  async history(sessionId: string): Promise<AgentMessage[]> {
    const data = await call<{ messages: AgentMessage[] }>(`/sessions/${sessionId}`);
    return data.messages;
  },

  /** Post a turn. Returns the run id *before* the run finishes, so the
   *  caller can subscribe without missing the start. */
  async send(sessionId: string, text: string): Promise<{ runId: string }> {
    return call(`/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  /* ───────────────── §22.8 — see it, and rip it out ─────────────────────── */

  async memory(filter: MemoryFilter = {}): Promise<{
    facts: MemoryFact[];
    total: number;
    counts: MemoryCounts;
  }> {
    const params = new URLSearchParams();
    if (filter.q !== undefined && filter.q !== '') params.set('q', filter.q);
    if (filter.basis !== undefined && filter.basis !== '') params.set('basis', filter.basis);
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.minConfidence !== undefined) params.set('minConfidence', String(filter.minConfidence));
    if (filter.pinned !== undefined) params.set('pinned', String(filter.pinned));
    const query = params.toString();
    return call(`/memory${query === '' ? '' : `?${query}`}`);
  },

  async explainMemory(id: string): Promise<MemoryExplanation> {
    return call(`/memory/${id}`);
  },

  async pinMemory(id: string, pinned: boolean): Promise<void> {
    await call(`/memory/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
  },

  async correctMemory(id: string, correction: string): Promise<void> {
    await call(`/memory/${id}/correct`, {
      method: 'POST',
      body: JSON.stringify({ correction }),
    });
  },

  async forgetMemory(id: string): Promise<void> {
    await call(`/memory/${id}`, { method: 'DELETE' });
  },

  async forgetEverything(subject = 'self'): Promise<{ forgotten: string[] }> {
    return call(`/memory?subject=${encodeURIComponent(subject)}`, { method: 'DELETE' });
  },

  async memoryDigest(): Promise<{
    entries: Array<{ id: string; text: string; createdAt: number }>;
    identity: { text: string; tokens: number; updatedAt: number } | null;
  }> {
    return call('/memory/digest');
  },

  /**
   * §22's identity card — what the agent would say about you to open a
   * new conversation — with the token cap the context actually applies,
   * so a person reading it knows they are seeing all of it rather than
   * the first 400 tokens of something longer.
   */
  async identityCard(): Promise<{
    card: { text: string; tokens: number; updatedAt: number } | null;
    maxTokens: number;
  }> {
    return call('/memory/identity-card');
  },

  async exportMemory(): Promise<unknown> {
    return call('/memory/export');
  },

  /* ──────────────────────── §25: the constitution ──────────────────────── */

  async constitution(): Promise<ConstitutionDoc> {
    return call('/constitution');
  },

  async constitutionHistory(): Promise<{ history: Amendment[] }> {
    return call('/constitution/history');
  },

  async addArticle(text: string, subject = 'general'): Promise<{ version: number }> {
    return call('/constitution/articles', {
      method: 'POST',
      body: JSON.stringify({ text, subject }),
    });
  },

  async repealArticle(id: string): Promise<void> {
    await call(`/constitution/articles/${id}`, { method: 'DELETE' });
  },

  async dismissProposal(id: string): Promise<void> {
    await call(`/constitution/proposals/${id}/dismiss`, { method: 'POST' });
  },

  async ratifyProposal(id: string): Promise<void> {
    await call(`/constitution/proposals/${id}/ratify`, { method: 'POST' });
  },

  async compliance(days = 14): Promise<Compliance> {
    return call(`/constitution/compliance?days=${days}`);
  },

  async calibration(): Promise<CalibrationView> {
    return call('/calibration');
  },

  /* ─────────────────── §28: schedules, jobs, degradation ───────────────── */

  async schedules(): Promise<{ schedules: ScheduleView[] }> {
    return call('/schedules');
  },

  async createSchedule(input: {
    name: string;
    spec: string;
    prompt: string;
    timezone?: string;
    catchUp?: CatchUp;
  }): Promise<ScheduleView> {
    return call('/schedules', { method: 'POST', body: JSON.stringify(input) });
  },

  async updateSchedule(
    id: string,
    patch: { enabled?: boolean; catchUp?: CatchUp; timezone?: string; spec?: string },
  ): Promise<ScheduleView> {
    return call(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  async deleteSchedule(id: string): Promise<void> {
    await call(`/schedules/${id}`, { method: 'DELETE' });
  },

  async jobs(): Promise<{ counts: Record<string, number>; jobs: JobView[] }> {
    return call('/jobs');
  },

  async degradation(): Promise<DegradationView> {
    return call('/degradation');
  },

  /* ──────────────────── §29/§30: persona, proof, portability ───────────── */

  async persona(): Promise<{ persona: PersonaView; rendered: string[] }> {
    return call('/persona');
  },

  async savePersona(persona: PersonaView): Promise<{ persona: PersonaView; rendered: string[] }> {
    return call('/persona', { method: 'PUT', body: JSON.stringify(persona) });
  },

  async metrics(days = 30): Promise<MetricsView> {
    return call(`/metrics?days=${days}`);
  },

  /** The readable trace — §30's "why did it say that?". */
  async traceText(runId: string): Promise<string> {
    return callText(`/runs/${runId}/trace?format=text`);
  },

  /** The same trace, structured, for a UI that wants to lay it out. */
  async trace(runId: string): Promise<TraceView> {
    const data = await call<{ trace: TraceView }>(`/runs/${runId}/trace`);
    return data.trace;
  },

  /* ───────────────────────── §30: the log itself ────────────────────────── */

  /**
   * The event log, which is the system of record for everything else in
   * this file. Everything the other panels show is a projection of these
   * rows; this is the row.
   */
  async events(filter: EventFilter = {}): Promise<EventPage> {
    const params = new URLSearchParams();
    if (filter.types !== undefined && filter.types.length > 0)
      params.set('types', filter.types.join(','));
    if (filter.sessionId !== undefined && filter.sessionId !== '')
      params.set('sessionId', filter.sessionId);
    if (filter.runId !== undefined && filter.runId !== '') params.set('runId', filter.runId);
    if (filter.sinceSeq !== undefined) params.set('sinceSeq', String(filter.sinceSeq));
    params.set('limit', String(filter.limit ?? 100));
    return call(`/events?${params.toString()}`);
  },

  /* ──────────────────── §28: the jobs that gave up ──────────────────────── */

  async deadLetters(): Promise<DeadLetterView[]> {
    const data = await call<{ dead: DeadLetterView[] }>('/jobs/dead-letter');
    return data.dead;
  },

  /** Put a dead job back on the queue. §28: nothing fails silently. */
  async replayJob(id: string): Promise<{ jobId: string }> {
    return call(`/jobs/${id}/replay`, { method: 'POST' });
  },

  /* ──────────────────────────── §13: the vault ──────────────────────────── */

  async vault(): Promise<VaultView> {
    return call('/vault/secrets');
  },

  /**
   * Store a secret. The value goes up and never comes back down: there is
   * no read route, by design, so this is the only moment the plaintext
   * exists outside the vault.
   */
  async putSecret(name: string, value: string, label?: string): Promise<{ ref: string }> {
    return call('/vault/secrets', {
      method: 'POST',
      body: JSON.stringify({ name, value, ...(label === undefined ? {} : { label }) }),
    });
  },

  async rotateSecret(name: string, value: string): Promise<{ ref: string }> {
    return call(`/vault/secrets/${encodeURIComponent(name)}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ value }),
    });
  },

  async deleteSecret(name: string): Promise<{ destroyed: number }> {
    return call(`/vault/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  /**
   * Unlock, or initialise on first use. A first unlock returns a recovery
   * code that is shown once and stored nowhere — the caller has to put it
   * in front of the user immediately or lose it.
   */
  async unlockVault(passphrase: string): Promise<{ state: string; recoveryCode?: string }> {
    return call('/vault/unlock', { method: 'POST', body: JSON.stringify({ passphrase }) });
  },

  async lockVault(): Promise<{ state: string }> {
    return call('/vault/lock', { method: 'POST' });
  },

  /**
   * Destroy the keyring. Every secret becomes permanently unreadable,
   * including in backups that already exist. The confirmation sentence is
   * a literal the server insists on; it is spelled out here rather than
   * passed in so no caller can reduce it to a boolean.
   */
  async panicVault(): Promise<{ state: string; destroyed: boolean }> {
    return call('/vault/panic', {
      method: 'POST',
      body: JSON.stringify({ confirm: PANIC_CONFIRMATION }),
    });
  },

  /** Decision 038: import refuses a non-empty install rather than merging. */
  async importAll(snapshot: unknown): Promise<{ imported: number }> {
    return call('/import', { method: 'POST', body: JSON.stringify(snapshot) });
  },

  async verifyBackup(): Promise<BackupReport> {
    return call('/backup/verify', { method: 'POST' });
  },

  async exportAll(): Promise<unknown> {
    return call('/export', { method: 'POST' });
  },

  async approvals(): Promise<PendingApproval[]> {
    const data = await call<{ approvals: PendingApproval[] }>('/approvals');
    return data.approvals;
  },

  async decide(id: string, decision: 'approve' | 'deny', scope = 'once'): Promise<void> {
    await call(`/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision, scope }) });
  },

  async cancel(runId: string): Promise<void> {
    await call(`/runs/${runId}/cancel`, { method: 'POST' });
  },

  /**
   * Follow a run. Resolves when the run reaches a terminal frame or the
   * caller aborts; never throws for an ordinary agent failure, because a
   * failed run is data the UI has to show rather than an exception to
   * swallow.
   */
  async follow(runId: string, handlers: RunHandlers, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${BASE}/runs/${runId}/stream`, {
        headers: { accept: 'text/event-stream' },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) return;
      handlers.onError?.(
        error instanceof Error ? error.message : 'the connection to the agent dropped',
      );
      return;
    }

    if (response.body === null) {
      handlers.onError?.('the agent sent no stream');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        // An aborted read is a cancel, not a failure.
        return;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        dispatchFrame(parseFrame(buffer.slice(0, split)), handlers);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
      }
    }
  },
};

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

export function parseFrame(raw: string): Frame {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  const joined = data.join('\n');
  let parsed: Record<string, unknown> = {};
  if (joined !== '') {
    try {
      parsed = JSON.parse(joined) as Record<string, unknown>;
    } catch {
      parsed = { text: joined };
    }
  }
  return { event, data: parsed };
}

function dispatchFrame(frame: Frame, handlers: RunHandlers): void {
  const text = (frame.data.text as string | undefined) ?? '';
  switch (frame.event) {
    case 'delta':
      handlers.onDelta?.(text);
      break;
    case 'step':
      handlers.onStep?.(
        (frame.data.index as number | undefined) ?? 0,
        (frame.data.effectiveTrust as string | undefined) ?? 'USER',
      );
      break;
    case 'step-done':
      handlers.onStepDone?.(
        (frame.data.index as number | undefined) ?? 0,
        (frame.data.outcome as string | undefined) ?? 'finish',
        (frame.data.durationMs as number | undefined) ?? 0,
      );
      break;
    case 'tool':
      handlers.onTool?.((frame.data.tool as string | undefined) ?? 'a tool');
      break;
    case 'degraded':
      handlers.onDegraded?.(
        (frame.data.level as string | undefined) ?? 'L1',
        (frame.data.reason as string | undefined) ?? 'the agent is working with less than usual',
      );
      break;
    case 'cancelled':
      handlers.onCancelled?.();
      break;
    case 'resumed':
      handlers.onResumed?.();
      break;
    case 'approval':
      handlers.onApproval?.({
        id: (frame.data.approvalId as string | undefined) ?? (frame.data.id as string),
        tool: (frame.data.tool as string | undefined) ?? '',
        preview: (frame.data.preview as string | undefined) ?? '',
        risk: (frame.data.risk as string | undefined) ?? 'dangerous',
      });
      break;
    case 'approval-decided':
      handlers.onApprovalDecided?.(
        (frame.data.approvalId as string | undefined) ?? '',
        (frame.data.outcome as string | undefined) ?? '',
      );
      break;
    case 'suspended':
      handlers.onSuspended?.();
      break;
    case 'message':
      handlers.onMessage?.(text);
      break;
    case 'done':
      handlers.onDone?.({
        reason: (frame.data.reason as string | undefined) ?? 'stop',
        steps: (frame.data.steps as number | undefined) ?? 0,
        tokens: (frame.data.tokens as number | undefined) ?? 0,
      });
      break;
    case 'error':
      handlers.onError?.(
        (frame.data.message as string | undefined) ?? 'the run failed, and the agent said why in the log',
      );
      break;
    default:
      break;
  }
}
