import { describe, expect, it } from 'vitest';
import { formatSse, heartbeat, parseLastEventId, replayRun, toFrame } from '../../src/interface/stream.js';
import { createTestSubstrate } from '../../src/substrate/index.js';

describe('SSE framing', () => {
  it('produces a well-formed frame', () => {
    expect(formatSse({ id: 7, event: 'delta', data: { text: 'hi' } })).toBe(
      'id: 7\nevent: delta\ndata: {"text":"hi"}\n\n',
    );
  });

  it('cannot be broken by a newline in the payload', () => {
    const frame = formatSse({ id: 1, event: 'delta', data: { text: 'line one\nline two' } });
    // A raw newline inside data would split the frame and corrupt the stream.
    // JSON encoding is what prevents it, which is why data is always JSON.
    expect(frame.split('\n\n')).toHaveLength(2);
    expect(frame).toContain('\\n');
  });

  it('survives payloads containing the frame delimiter itself', () => {
    const frame = formatSse({ id: 1, event: 'delta', data: { text: 'a\n\ndata: evil' } });
    expect(frame.split('\n\n')).toHaveLength(2);
  });

  it('emits a heartbeat as a comment, which is not a data event', () => {
    expect(heartbeat().startsWith(':')).toBe(true);
    expect(heartbeat()).not.toContain('data:');
  });
});

describe('Last-Event-ID', () => {
  it('defaults to zero when absent or junk', () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId('nonsense')).toBe(0);
    expect(parseLastEventId('-5')).toBe(0);
  });

  it('parses a valid id, including from an array header', () => {
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId(['42'])).toBe(42);
  });
});

describe('replay from the log', () => {
  it('returns frames after the given seq, with no gap and no repeat', () => {
    const substrate = createTestSubstrate();
    const runId = 'run-1';
    for (let i = 0; i < 5; i++) {
      substrate.events.append({
        type: 'step.started',
        payload: { index: i, effectiveTrust: 'USER' },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId: 's',
        runId,
        stepId: `step-${i}`,
      });
    }
    const all = replayRun(substrate.events, runId, 0);
    expect(all).toHaveLength(5);

    const resumed = replayRun(substrate.events, runId, all[1]!.id);
    expect(resumed).toHaveLength(3);
    // The resume boundary is exact: the client already has frame 2.
    expect(resumed[0]?.id).toBeGreaterThan(all[1]!.id);
    expect(resumed.map((f) => f.id)).toEqual(all.slice(2).map((f) => f.id));
    substrate.close();
  });

  it('ids are monotonic, because they are the event log sequence', () => {
    const substrate = createTestSubstrate();
    for (let i = 0; i < 4; i++) {
      substrate.events.append({
        type: 'step.started',
        payload: { index: i, effectiveTrust: 'USER' },
        principal: 'system',
        trust: 'SYSTEM',
        sessionId: 's',
        runId: 'r',
        stepId: `s${i}`,
      });
    }
    const ids = replayRun(substrate.events, 'r', 0).map((f) => f.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    substrate.close();
  });

  it('hides kernel bookkeeping from the client', () => {
    expect(toFrame('model.requested', {}, 1)).toBeNull();
    expect(toFrame('message.agent', { text: 'x' }, 1)?.event).toBe('message');
    expect(toFrame('run.finished', {}, 1)?.event).toBe('done');
  });
});
