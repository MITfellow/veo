/**
 * Server-Sent Events (§29, L6).
 *
 * The one requirement that shapes this whole file:
 *
 *   > `Last-Event-ID` resume replayed from the event log — **a sleeping
 *   > laptop must never lose output.**
 *
 * That is only cheap because of a decision made at M0: the event log already
 * contains every delta, in order, with a dense `seq`. So the SSE id *is* the
 * event sequence number, and "resume" is a log read. No ring buffer, no
 * per-connection replay cache, nothing to size wrong, and it survives a
 * server restart — which an in-memory buffer never could.
 */
import type { ServerResponse } from 'node:http';
import type { EventLog } from '../substrate/events/log.js';
import type { Clock } from '../substrate/ports.js';

export interface SseEvent {
  /** Monotonic. The event log's `seq`, so a client can resume from it. */
  id: number;
  event: string;
  data: unknown;
}

/** Heartbeat interval. Idle proxies commonly cut at 30–60s; 15s is safe. */
export const HEARTBEAT_MS = 15_000;

export function formatSse(event: SseEvent): string {
  // `data` must never contain a raw newline or the frame splits. JSON.stringify
  // escapes them, which is the main reason data is always JSON here.
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** A comment frame. Clients ignore it; proxies see traffic and stay open. */
export function heartbeat(): string {
  return `: heartbeat\n\n`;
}

export interface SseConnectionOptions {
  res: ServerResponse;
  clock: Clock;
  /** Called when the client goes away, so the producer can stop working. */
  onClose?: () => void;
  heartbeatMs?: number;
}

/**
 * One SSE connection.
 *
 * Backpressure is respected: `write()` returning false means the kernel
 * buffer is full, and continuing to push would grow an unbounded queue in
 * process memory. A slow client must slow the producer, not consume the
 * server.
 */
export class SseConnection {
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: SseConnectionOptions) {
    const { res } = options;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer by default, which silently destroys
      // streaming: the user sees nothing, then everything at once.
      'x-accel-buffering': 'no',
    });

    this.timer = setInterval(() => {
      if (!this.closed) res.write(heartbeat());
    }, options.heartbeatMs ?? HEARTBEAT_MS);
    // Never keep the process alive for a heartbeat.
    this.timer.unref?.();

    res.on('close', () => {
      this.cleanup();
      options.onClose?.();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Queue a frame, honouring backpressure. */
  send(event: SseEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending = this.pending.then(() => this.writeWithBackpressure(formatSse(event)));
    return this.pending;
  }

  private writeWithBackpressure(frame: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const { res } = this.options;
    if (res.write(frame)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      res.once('drain', resolve);
      // If the socket dies while we wait, resolve anyway or the chain stalls
      // forever and the run never finalizes.
      res.once('close', resolve);
    });
  }

  async close(): Promise<void> {
    await this.pending;
    this.cleanup();
    if (!this.options.res.writableEnded) this.options.res.end();
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
  }
}

/**
 * Everything that happened in a run after `afterSeq`, rendered as SSE frames.
 *
 * This is the resume path **and** the replay path — identical code, so a
 * reconnect cannot drift from a live stream. The client sends
 * `Last-Event-ID: 42`; it gets 43 onward; nothing is skipped and nothing is
 * repeated, because `seq` is dense and assigned inside the append
 * transaction.
 */
export function replayRun(events: EventLog, runId: string, afterSeq: number): SseEvent[] {
  const frames: SseEvent[] = [];
  for (const event of events.read({ runId })) {
    if (event.seq <= afterSeq) continue;
    const frame = toFrame(event.type, event.payload, event.seq);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/**
 * Map an event to a client-facing frame.
 *
 * Returning `null` for internal events is deliberate: the client gets the
 * conversation, not the kernel's bookkeeping. It can always fetch
 * `/runs/:id/trace` for the full picture.
 */
export function toFrame(type: string, payload: unknown, seq: number): SseEvent | null {
  switch (type) {
    case 'message.agent':
      return { id: seq, event: 'message', data: payload };
    case 'step.started':
      return { id: seq, event: 'step', data: payload };
    case 'step.finished':
      return { id: seq, event: 'step-done', data: payload };
    case 'tool.requested':
      return { id: seq, event: 'tool', data: payload };
    case 'run.degraded':
      return { id: seq, event: 'degraded', data: payload };
    case 'run.finished':
      return { id: seq, event: 'done', data: payload };
    case 'run.failed':
      return { id: seq, event: 'error', data: payload };
    case 'run.cancelled':
      return { id: seq, event: 'cancelled', data: payload };
    case 'run.suspended':
      return { id: seq, event: 'suspended', data: payload };
    default:
      return null;
  }
}

/** Parse `Last-Event-ID`, tolerating absence and junk. */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
