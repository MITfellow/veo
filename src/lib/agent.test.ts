import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agent,
  AgentUnavailableError,
  parseFrame,
  VaultLockedError,
  type RunHandlers,
} from './agent';

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

/**
 * The surfaces M0–M9 built and the UI could not reach.
 *
 * Each of these is a route that existed, was tested on the server, and
 * had no client method — which from the user's seat is the same as not
 * existing. The tests are deliberately shallow: the behaviour is the
 * server's and is tested there. What is being asserted here is that the
 * client asks for the right URL with the right verb, because that is the
 * exact thing that was wrong.
 */
describe('the rest of the harness', () => {
  const json = (data: unknown) => mockFetch({ json: () => Promise.resolve(data) });

  it('events() builds the query from the filter and drops the empty parts', async () => {
    const spy = json({ events: [], total: 0 });
    await agent.events({ types: ['model.requested', 'model.failed'], runId: 'r-9', limit: 50 });
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('/agent/events?');
    expect(url).toContain('types=model.requested%2Cmodel.failed');
    expect(url).toContain('runId=r-9');
    expect(url).toContain('limit=50');
    expect(url).not.toContain('sessionId');
  });

  it('events() defaults to a bounded page rather than the whole log', async () => {
    const spy = json({ events: [], total: 0 });
    await agent.events();
    expect(spy.mock.calls[0]![0]).toContain('limit=100');
    // No cursor means "the newest page", which is not the same request
    // as "everything after 0" and must not be sent as one.
    expect(spy.mock.calls[0]![0]).not.toContain('sinceSeq');
  });

  it('events() sends a zero cursor, because 0 is a real starting point', async () => {
    const spy = json({ events: [], total: 0, nextSeq: 0, hasMore: false });
    await agent.events({ sinceSeq: 0 });
    expect(spy.mock.calls[0]![0]).toContain('sinceSeq=0');
  });

  it('events() hands back the cursor the server returned', async () => {
    json({ events: [], total: 9, nextSeq: 42, hasMore: true });
    await expect(agent.events({ sinceSeq: 40 })).resolves.toMatchObject({
      nextSeq: 42,
      hasMore: true,
    });
  });

  it('trace() unwraps the structured trace', async () => {
    json({ trace: { runId: 'r-1', status: 'finished' } });
    await expect(agent.trace('r-1')).resolves.toMatchObject({ runId: 'r-1' });
  });

  it('deadLetters() unwraps the list the queue calls `dead`', async () => {
    json({ dead: [{ id: 'd-1', kind: 'run', attempts: 5 }] });
    await expect(agent.deadLetters()).resolves.toHaveLength(1);
  });

  it('replayJob() posts to the replay route', async () => {
    const spy = json({ jobId: 'j-2' });
    await agent.replayJob('d-1');
    expect(spy.mock.calls[0]![0]).toBe('/agent/jobs/d-1/replay');
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('vault() reads the state and the metadata', async () => {
    json({ state: 'unlocked', secrets: [] });
    await expect(agent.vault()).resolves.toEqual({ state: 'unlocked', secrets: [] });
  });

  it('putSecret() sends the value exactly once, to the create route', async () => {
    const spy = json({ ref: 'secret://api_key#1' });
    await agent.putSecret('api_key', 'sk-live-xyz');
    expect(spy.mock.calls[0]![0]).toBe('/agent/vault/secrets');
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'api_key', value: 'sk-live-xyz' });
  });

  it('rotateSecret() escapes the name into the path', async () => {
    const spy = json({ ref: 'secret://a%2Fb#2' });
    await agent.rotateSecret('a/b', 'next');
    expect(spy.mock.calls[0]![0]).toBe('/agent/vault/secrets/a%2Fb/rotate');
  });

  it('deleteSecret() uses DELETE, not a POST that pretends', async () => {
    const spy = json({ destroyed: 1 });
    await agent.deleteSecret('api_key');
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('unlockVault() surfaces the one-time recovery code when the vault is new', async () => {
    json({ state: 'unlocked', recoveryCode: 'abcd-efgh' });
    await expect(agent.unlockVault('hunter2')).resolves.toMatchObject({
      recoveryCode: 'abcd-efgh',
    });
  });

  it('lockVault() posts to lock', async () => {
    const spy = json({ state: 'locked' });
    await agent.lockVault();
    expect(spy.mock.calls[0]![0]).toBe('/agent/vault/lock');
  });

  it('panicVault() sends the literal sentence, which no caller can shorten', async () => {
    const spy = json({ state: 'uninitialized', destroyed: true });
    await agent.panicVault();
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ confirm: 'destroy my secrets' });
  });

  it('a 423 from any vault route is a locked vault, not a mystery number', async () => {
    mockFetch({ ok: false, status: 423, text: () => Promise.resolve('locked') });
    await expect(agent.vault()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(agent.vault()).rejects.toThrow('Unlock it with your passphrase');
  });
});

/**
 * Four frames the server has always sent and the client silently threw
 * away. `degraded` is the one that mattered: §27's entire argument is
 * that the agent says so when it is working with less, and a UI that
 * drops the frame turns that into a comfortable lie.
 */
describe('the frames the client used to drop', () => {
  const follow = async (frame: string, handlers: RunHandlers) => {
    mockFetch({ body: streamOf(`${frame}\n\n`, 2) });
    await agent.follow('run-1', handlers);
  };

  it('reports a degradation that happened mid-run', async () => {
    const seen: string[] = [];
    await follow('event: degraded\ndata: {"level":"L2","reason":"no model configured"}', {
      onDegraded: (level, reason) => seen.push(`${level}:${reason}`),
    });
    expect(seen).toEqual(['L2:no model configured']);
  });

  it('distinguishes a cancelled run from a finished one', async () => {
    const seen: string[] = [];
    await follow('event: cancelled\ndata: {}', { onCancelled: () => seen.push('cancelled') });
    expect(seen).toEqual(['cancelled']);
  });

  it('reports a step closing, with its outcome and cost', async () => {
    const seen: string[] = [];
    await follow('event: step-done\ndata: {"index":2,"outcome":"tools","durationMs":310}', {
      onStepDone: (index, outcome, ms) => seen.push(`${index}:${outcome}:${ms}`),
    });
    expect(seen).toEqual(['2:tools:310']);
  });

  it('reports a run coming back from an approval suspension', async () => {
    const seen: string[] = [];
    await follow('event: resumed\ndata: {}', { onResumed: () => seen.push('resumed') });
    expect(seen).toEqual(['resumed']);
  });
});
