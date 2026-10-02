import { describe, expect, it } from 'vitest';
import { createTestSubstrate } from '../../src/substrate/index.js';
import {
  Compactor,
  CompactionSummarySchema,
  extractiveSummarizer,
  type SourceTurn,
} from '../../src/cognition/compaction.js';

const SESSION = 'ses-compaction';

function world() {
  const substrate = createTestSubstrate();
  substrate.events.append({
    type: 'session.created',
    payload: { title: 'Lisbon' },
    principal: 'user:ara',
    trust: 'USER',
    sessionId: SESSION,
  });
  return substrate;
}

function say(
  substrate: ReturnType<typeof createTestSubstrate>,
  role: 'user' | 'assistant',
  text: string,
): void {
  substrate.events.append({
    type: role === 'user' ? 'message.user' : 'message.agent',
    payload: { text },
    principal: role === 'user' ? 'user:ara' : 'system',
    trust: role === 'user' ? 'USER' : 'DERIVED',
    sessionId: SESSION,
  });
}

function conversation(substrate: ReturnType<typeof createTestSubstrate>, count: number): void {
  for (let i = 0; i < count; i++) {
    say(substrate, i % 2 === 0 ? 'user' : 'assistant', `turn ${i} about the move and the flat`);
  }
}

describe('the extractive summarizer', () => {
  const turns: SourceTurn[] = [
    { eventId: 'e1', role: 'user', text: "Let's go with Alfama. I will sign the lease Friday.", at: 1 },
    { eventId: 'e2', role: 'assistant', text: 'Noted. Do you want me to remind you Thursday?', at: 2 },
    { eventId: 'e3', role: 'user', text: 'Yes. Still need to tell Priya about the dates.', at: 3 },
    { eventId: 'e4', role: 'assistant', text: 'What dates should I use?', at: 4 },
  ];

  it('produces a structured summary, not prose soup (§23)', () => {
    const summary = extractiveSummarizer(turns);
    expect(() => CompactionSummarySchema.parse(summary)).not.toThrow();
    expect(summary.decisions.join(' ')).toContain('Alfama');
    expect(summary.openThreads.join(' ')).toContain('Priya');
    expect(summary.entities).toContain('Priya');
    // The last question had nobody to answer it.
    expect(summary.unresolvedQuestions.join(' ')).toContain('What dates');
  });

  it('only ever emits text that was actually said', () => {
    // The whole reason the default summarizer is extractive: it cannot
    // invent a fact about someone's life, because every string it returns is
    // a substring of a real turn.
    const summary = extractiveSummarizer(turns);
    const spoken = turns.map((turn) => turn.text).join(' ');
    for (const line of [...summary.decisions, ...summary.openThreads, ...summary.unresolvedQuestions]) {
      expect(spoken).toContain(line.replace(/^(user|assistant): /, ''));
    }
  });

  it('is deterministic', () => {
    expect(extractiveSummarizer(turns)).toEqual(extractiveSummarizer(turns));
  });

  it('carries pointers back to the originals', () => {
    const summary = extractiveSummarizer(turns);
    expect(summary.span).toEqual({
      fromEventId: 'e1',
      toEventId: 'e4',
      turnCount: 4,
      fromTime: 1,
      toTime: 4,
    });
  });
});

describe('the compactor', () => {
  it('does nothing until there is enough history to be worth it', () => {
    const substrate = world();
    conversation(substrate, 10);
    const compactor = new Compactor(substrate);
    expect(compactor.compact(SESSION)).toBeNull();
    expect(substrate.events.read({ types: ['history.compacted'] })).toHaveLength(0);
    substrate.close();
  });

  it('summarizes the OLDEST chunk and leaves the newest verbatim (§23)', () => {
    const substrate = world();
    conversation(substrate, 50);
    const compactor = new Compactor(substrate);

    const chunk = compactor.compact(SESSION);
    expect(chunk).not.toBeNull();
    const turns = substrate.events.read({ sessionId: SESSION, types: ['message.user', 'message.agent'] });
    expect(chunk!.summary.span.fromEventId).toBe(turns[0]!.id);
    // Never the newest: the last turns stay verbatim whatever the pressure.
    expect(chunk!.summary.span.toEventId).not.toBe(turns.at(-1)!.id);
    expect(chunk!.summary.span.turnCount).toBe(20);
    substrate.close();
  });

  it('appends; it never destroys an original (invariant 2)', () => {
    const substrate = world();
    conversation(substrate, 50);
    const before = substrate.events.read({ sessionId: SESSION, types: ['message.user', 'message.agent'] });

    new Compactor(substrate).compact(SESSION);

    const after = substrate.events.read({ sessionId: SESSION, types: ['message.user', 'message.agent'] });
    expect(after).toEqual(before);
    substrate.close();
  });

  it('is idempotent — a second pass over the same turns adds nothing', () => {
    const substrate = world();
    conversation(substrate, 50);
    const compactor = new Compactor(substrate);

    expect(compactor.compact(SESSION)).not.toBeNull();
    const afterFirst = substrate.events.read({ types: ['history.compacted'] }).length;
    // Nothing new has been said, so there is nothing new to summarize.
    expect(compactor.compact(SESSION)).toBeNull();
    expect(substrate.events.read({ types: ['history.compacted'] })).toHaveLength(afterFirst);
    substrate.close();
  });

  it('starts the next chunk after the last one, never re-summarizing', () => {
    const substrate = world();
    conversation(substrate, 50);
    const compactor = new Compactor(substrate);
    const first = compactor.compact(SESSION)!;

    conversation(substrate, 40);
    const second = compactor.compact(SESSION)!;

    const turns = substrate.events.read({ sessionId: SESSION, types: ['message.user', 'message.agent'] });
    const indexOf = (id: string): number => turns.findIndex((turn) => turn.id === id);
    expect(indexOf(second.summary.span.fromEventId)).toBeGreaterThan(
      indexOf(first.summary.span.toEventId),
    );
    expect(compactor.chunks(SESSION)).toHaveLength(2);
    substrate.close();
  });

  it('round-trips through expand(): the pointers reach the real turns', () => {
    const substrate = world();
    conversation(substrate, 50);
    const compactor = new Compactor(substrate);
    const chunk = compactor.compact(SESSION)!;

    const expanded = compactor.expand(
      SESSION,
      chunk.summary.span.fromEventId,
      chunk.summary.span.toEventId,
    );
    expect(expanded).toHaveLength(chunk.summary.span.turnCount);
    expect(expanded[0]!.text).toBe('turn 0 about the move and the flat');
    expect(expanded.at(-1)!.eventId).toBe(chunk.summary.span.toEventId);
    substrate.close();
  });

  it('records which summarizer produced a summary', () => {
    const substrate = world();
    conversation(substrate, 50);
    new Compactor({ ...substrate, summarizerName: 'extractive-1' }).compact(SESSION);
    const event = substrate.events.read({ types: ['history.compacted'] })[0]!;
    // Two summarizers will coexist eventually (a model one, this one). You
    // cannot read a summary without knowing which wrote it.
    expect((event.payload as { summarizer: string }).summarizer).toBe('extractive-1');
    expect((event.payload as { tokensBefore: number }).tokensBefore).toBeGreaterThan(
      (event.payload as { tokensAfter: number }).tokensAfter,
    );
    substrate.close();
  });

  it('accepts an injected summarizer and logs it under its own name', () => {
    const substrate = world();
    conversation(substrate, 50);
    const compactor = new Compactor({
      ...substrate,
      summarizerName: 'pretend-model-1',
      summarize: (turns) => ({
        decisions: ['they decided something'],
        openThreads: [],
        entities: [],
        unresolvedQuestions: [],
        span: {
          fromEventId: turns[0]!.eventId,
          toEventId: turns.at(-1)!.eventId,
          turnCount: turns.length,
          fromTime: turns[0]!.at,
          toTime: turns.at(-1)!.at,
        },
      }),
    });
    const chunk = compactor.compact(SESSION)!;
    expect(chunk.summary.decisions).toEqual(['they decided something']);
    const event = substrate.events.read({ types: ['history.compacted'] })[0]!;
    expect((event.payload as { summarizer: string }).summarizer).toBe('pretend-model-1');
    substrate.close();
  });
});
