import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, AgentUnavailableError, parseFrame, type RunHandlers } from './agent';

/** A body that yields the given SSE text in arbitrary byte-sized pieces. */
function streamOf(text: string, pieces = 3): ReadableStream<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let at = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size) as Uint8Array<ArrayBuffer>);
      at += size;
    },
  });
}

function mockFetch(response: Partial<Response> & { body?: ReadableStream<Uint8Array<ArrayBuffer>> }) {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, ...response });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseFrame', () => {
  it('reads the event name and the JSON payload', () => {
    expect(parseFrame('id: 4\nevent: delta\ndata: {"text":"hi"}')).toEqual({
      event: 'delta',
      data: { text: 'hi' },
    });
  });

  it('survives a payload that is not JSON rather than throwing mid-stream', () => {
    expect(parseFrame('event: delta\ndata: not json')).toEqual({
      event: 'delta',
      data: { text: 'not json' },
    });
  });

  it('rejoins a multi-line data field', () => {
    expect(parseFrame('event: message\ndata: {"text":\ndata: "two lines"}')).toEqual({
      event: 'message',
      data: { text: 'two lines' },
    });
  });
});

describe('following a run', () => {
  const sse = [
    'id: 1\nevent: step\ndata: {"index":0,"effectiveTrust":"USER"}',
    'id: 2\nevent: delta\ndata: {"text":"Hel"}',
    'id: 3\nevent: delta\ndata: {"text":"lo"}',
    'id: 4\nevent: tool\ndata: {"tool":"clock.now"}',
    'id: 5\nevent: message\ndata: {"text":"Hello."}',
    'id: 6\nevent: done\ndata: {"reason":"stop","steps":1,"tokens":42}',
  ].join('\n\n') + '\n\n';

  it('reports every frame to the handler that asked for it', async () => {
    mockFetch({ body: streamOf(sse, 7) });
    const seen: string[] = [];
    const handlers: RunHandlers = {
      onDelta: (t) => seen.push(`delta:${t}`),
      onStep: (i, trust) => seen.push(`step:${i}:${trust}`),
      onTool: (tool) => seen.push(`tool:${tool}`),
      onMessage: (t) => seen.push(`message:${t}`),
      onDone: (s) => seen.push(`done:${s.reason}:${s.tokens}`),
    };

    await agent.follow('run-1', handlers);

    // The frames arrive split across byte boundaries; the order must survive.
    expect(seen).toEqual([
      'step:0:USER',
      'delta:Hel',
      'delta:lo',
      'tool:clock.now',
      'message:Hello.',
      'done:stop:42',
    ]);
  });

  it('surfaces an approval request as a decision the UI has to render', async () => {
    mockFetch({
      body: streamOf(
        'event: approval\ndata: {"approvalId":"ap1","tool":"notes.write","preview":"name: todo","risk":"irreversible"}\n\n',
      ),
    });
    const onApproval = vi.fn();
    await agent.follow('run-1', { onApproval });
    expect(onApproval).toHaveBeenCalledWith({
      id: 'ap1',
      tool: 'notes.write',
      preview: 'name: todo',
      risk: 'irreversible',
    });
  });

  it('turns a dropped connection into an error the user can read, not a crash', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    const onError = vi.fn();
    await expect(agent.follow('run-1', { onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('connection reset');
  });

  it('stays silent when the caller is the one who hung up', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('aborted')));
    const onError = vi.fn();
    await agent.follow('run-1', { onError }, controller.signal);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('talking to the runtime', () => {
  it('posts a turn and hands back the run id before the run finishes', async () => {
    const spy = mockFetch({ json: async () => ({ runId: 'r1', sessionId: 's1' }) });
    await expect(agent.send('s1', 'hello')).resolves.toEqual({ runId: 'r1', sessionId: 's1' });
    expect(spy).toHaveBeenCalledWith('/agent/sessions/s1/messages', expect.objectContaining({ method: 'POST' }));
  });

  it('never puts a bearer token in the browser', async () => {
    const spy = mockFetch({ json: async () => ({ approvals: [] }) });
    await agent.approvals();
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // The dev server attaches it. If this ever fails, a token has leaked
    // into the bundle, which is the whole thing this test exists to stop.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('says how to start the agent when nothing is listening', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(agent.createSession('x')).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(agent.createSession('x')).rejects.toThrow('npm run agent');
  });

  it('reports an HTTP failure with the status and the body', async () => {
    mockFetch({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(agent.createSession('x')).rejects.toThrow('agent returned 401: unauthorized');
  });
});
