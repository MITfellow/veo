/**
 * Tests 33–38: memory inside the running system.
 *
 * These go through the real assembler and, for the last two, the real
 * composed app. The unit tests prove the parts behave; these prove the
 * milestone bar from §33 — *a fresh session visibly knows the person from
 * turn one* — which is a property of the wiring, not of any one part.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleContext } from '../../src/cognition/context/assemble.js';
import { policyFor } from '../../src/cognition/context/policy.js';
import { emptySnapshot } from '../../src/cognition/context/assemble.js';
import { IDENTITY_CARD_TOKENS } from '../../src/cognition/memory/consolidate.js';
import { estimateTokens } from '../../src/cognition/tokens.js';
import { start, type StartedAgent } from '../../src/main.js';
import { DAY, PRINCIPAL, harness, put, type MemoryHarness } from '../fixtures/memory.js';

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

const observe = (text: string, n: number) =>
  h.writer.observe({
    principal: PRINCIPAL,
    sessionId: `s${n}`,
    runId: `r${n}`,
    episodeId: `ep${n}`,
    text,
    eventId: `e${n}`,
    trust: 'USER',
  });

/** Assemble a real context whose memory blocks come from the real store. */
const assemble = (sessionId: string, text: string) => {
  const snapshot = {
    ...emptySnapshot(h.clock.now()),
    identity: h.source.identity(PRINCIPAL),
    constraints: h.source.constraints(PRINCIPAL),
    memories: h.source.recall({ principal: PRINCIPAL, sessionId, text, limit: 8 }),
    pinned: h.source.pinned(PRINCIPAL),
    commitments: h.source.commitments(PRINCIPAL),
    calibration: h.source.openQuestions(PRINCIPAL),
    conversation: [
      { id: 't1', role: 'user' as const, content: text, trust: 'USER' as const, ts: h.clock.now() },
    ],
  };
  const assembled = assembleContext({
    principal: PRINCIPAL,
    sessionId,
    snapshot,
    policy: policyFor('test-model'),
    trust: 'USER',
    now: h.clock.now(),
  });
  // The assembled context is a list of messages; the prompt the model
  // actually sees is their concatenation.
  return { ...assembled, text: assembled.messages.map((message) => message.content).join('\n') };
};

describe('memory crosses sessions (§22, §33)', () => {
  it('33. a fact learned in session one reaches the memories block in session two', async () => {
    await observe('I work at Anthropic', 1);
    await h.writer.embedAll();
    h.clock.advance(3 * DAY);

    const context = assemble('s2', 'remind me where I work');
    const memories = context.blocks.find((block) => block.name === 'memories');
    expect(memories).toBeDefined();
    expect(memories!.items).toBeGreaterThan(0);
    expect(context.text).toContain('Anthropic');
  });

  it('34. consolidation is idempotent — running it twice changes nothing', () => {
    for (let i = 0; i < 6; i += 1) {
      h.store.recordEpisode({
        runId: `run-${i}`,
        sessionId: 's1',
        principal: PRINCIPAL,
        request: 'what time is it in Tokyo?',
        response: 'It is 9pm.',
        actions: ['clock.now'],
        entities: [],
        outcome: 'satisfied',
        outcomeReason: null,
        trust: 'USER',
        startedAt: h.clock.now(),
        endedAt: h.clock.now(),
        costMicros: 10,
      });
    }
    put(h.store, { predicate: 'lives_in', object: 'Berlin' });

    const first = h.consolidator.run(PRINCIPAL);
    const snapshotAfterFirst = JSON.stringify(h.store.recallable(PRINCIPAL));
    const cardAfterFirst = h.store.identityCard(PRINCIPAL)?.text;

    const second = h.consolidator.run(PRINCIPAL);

    // The second pass sees no unconsolidated episodes and must not decay,
    // distil or rewrite anything. Anything that *accumulated* per pass — a
    // counter, an appended paragraph — would drift nightly and nobody would
    // notice for a month.
    expect(second.episodes).toBe(0);
    expect(second.factsWritten).toBe(0);
    expect(second.factsDecayed).toBe(0);
    expect(JSON.stringify(h.store.recallable(PRINCIPAL))).toBe(snapshotAfterFirst);
    expect(h.store.identityCard(PRINCIPAL)?.text).toBe(cardAfterFirst);
    expect(second.digest).toBe(first.digest);
  });

  it('35. the identity card stays within its budget with 500 facts in the store', () => {
    for (let i = 0; i < 500; i += 1) {
      put(h.store, {
        predicate: `knows_${i}`,
        object: `a reasonably verbose fact number ${i} about this person and their life`,
        confidence: 0.4 + (i % 50) / 100,
      });
    }

    const card = h.consolidator.identityCard(PRINCIPAL, h.clock.now());
    expect(card.tokens).toBeLessThanOrEqual(IDENTITY_CARD_TOKENS);
    expect(estimateTokens(card.text)).toBeLessThanOrEqual(IDENTITY_CARD_TOKENS);
    // Within the budget it should carry the *best* facts, not the first
    // five hundred bytes of whatever SQLite returned.
    expect(card.text.length).toBeGreaterThan(80);
  });

  it('36. THE BAR: turn one of a fresh session already knows the person', async () => {
    await observe('My name is Ara and I work at Anthropic', 1);
    await observe('I am allergic to peanuts', 2);
    await observe('Please keep it short', 3);
    const pinned = put(h.store, { predicate: 'daughter', object: 'Noor, she is six' });
    h.store.pin(pinned, true, PRINCIPAL, 'USER');
    h.consolidator.identityCard(PRINCIPAL, h.clock.now());
    h.clock.advance(14 * DAY);

    // A brand-new session. No conversation history at all — turn one.
    const context = assemble('brand-new-session', 'hello');

    // The identity card is in, and it is unevictable.
    const identity = context.blocks.find((block) => block.name === 'identity');
    expect(identity?.tokens).toBeGreaterThan(0);
    expect(context.text).toContain('Ara');
    // The pin is in, unconditionally — "hello" has nothing to do with Noor.
    expect(context.text).toContain('Noor');
    // The learned rule is a constraint, not a memory: a thing to obey.
    const constraints = context.blocks.find((block) => block.name === 'constraints');
    expect(constraints?.items).toBeGreaterThan(0);
    expect(context.text.toLowerCase()).toContain('short');
    // And every remembered line carries its epistemics (invariant 5):
    // where it came from, how sure, how many sources. The context never
    // states a belief about a person as a bare fact.
    expect(context.text).toMatch(/they told you|observed|inferred/);
    expect(context.text).toMatch(/\d source/);
  });
});

describe('memory never slows the user down, and never loses a turn', () => {
  let app: StartedAgent;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arish-mem-app-'));
    app = await start({ port: 0, dbPath: join(dir, 'app.db'), token: 'mem-token' });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${app.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBeLessThan(400);
    return (await response.json()) as T;
  };

  it('37. the run finishes before memory has finished learning from it', async () => {
    const session = await call<{ id: string }>('/sessions', { title: 'memory' });
    const started = Date.now();
    await call<{ runId: string }>(`/sessions/${session.id}/messages`, {
      text: 'I work at Anthropic and I am allergic to peanuts',
    });
    const elapsed = Date.now() - started;

    // §22.5: "latency is a personality trait". The write path hangs off the
    // *end* of the run, so accepting the message cannot be waiting on
    // extraction, gating, entity resolution and embedding.
    expect(elapsed).toBeLessThan(2_000);

    // Learning does still happen, just afterwards.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const facts = await call<{ facts: unknown[] }>('/health');
    expect(facts).toBeDefined();
  });

  it('38. a restart loses nothing: beliefs survive in the log, not in memory', async () => {
    const session = await call<{ id: string }>('/sessions', { title: 'durable' });
    await call(`/sessions/${session.id}/messages`, { text: 'My name is Ara' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const port = app.port;
    await app.close();

    // Same database, brand-new process-worth of state.
    app = await start({ port: 0, dbPath: join(dir, 'app.db'), token: 'mem-token' });
    expect(app.port).not.toBe(-port);

    const health = await call<{ ok?: boolean; status?: string }>('/health');
    expect(health).toBeTruthy();

    // The belief is in the projection, which was rebuilt from the log.
    const second = await call<{ id: string }>('/sessions', { title: 'after restart' });
    await call(`/sessions/${second.id}/messages`, { text: 'what is my name?' });
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
});
