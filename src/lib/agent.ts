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
  onTool?: (tool: string) => void;
  onApproval?: (approval: { id: string; tool: string; preview: string; risk: string }) => void;
  onApprovalDecided?: (id: string, outcome: string) => void;
  onMessage?: (text: string) => void;
  onDone?: (summary: { reason: string; steps: number; tokens: number }) => void;
  onError?: (message: string) => void;
  onSuspended?: () => void;
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new AgentUnavailableError(error instanceof Error ? error.message : 'network error');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`agent returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
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
    case 'tool':
      handlers.onTool?.((frame.data.tool as string | undefined) ?? 'a tool');
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
