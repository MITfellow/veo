/**
 * Tests 44–45: golden files for what memory produces (§22.6, §22.7).
 *
 * Both of these are prose a *person* ends up reading — one as the memories
 * block in the prompt, one as the "what I learned recently" digest. Scoring
 * changes reorder them silently, and a reordering of someone's identity is
 * a behavioural change that deserves a diff in review rather than a
 * discovery in production.
 *
 * Regenerate deliberately, and read the diff:
 *
 *     UPDATE_GOLDEN=1 npx vitest run test/golden
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMemory } from '../../src/cognition/context/templates/memory.js';
import { DAY, PRINCIPAL, harness, put, type MemoryHarness } from '../fixtures/memory.js';

const DIR = new URL('./memory/', import.meta.url).pathname;

function golden(name: string, actual: string): void {
  const path = `${DIR}${name}.golden.txt`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

let h: MemoryHarness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  h.close();
});

/** A store with one of everything the renderer has to say something about. */
function populate(): void {
  put(h.store, { predicate: 'name', object: 'Ara', stability: 'stable', confidence: 0.95 });
  put(h.store, { predicate: 'works_at', object: 'Anthropic', confidence: 0.82 });
  const pinned = put(h.store, { predicate: 'daughter', object: 'Noor, six years old' });
  h.store.pin(pinned, true, PRINCIPAL, 'USER');
  put(h.store, {
    predicate: 'allergic_to',
    object: 'peanuts',
    sensitivity: 'private',
    stability: 'stable',
    confidence: 0.9,
  });
  // A guess, labelled as one.
  put(h.store, {
    predicate: 'prefers',
    object: 'morning meetings',
    basis: 'inferred',
    confidence: 0.42,
    trust: 'DERIVED',
  });
  // A belief the agent knows it has contradictory evidence about.
  const disputed = put(h.store, { predicate: 'lives_in', object: 'Berlin', confidence: 0.6 });
  h.store.dispute(disputed, 'Lisbon', 'a later statement conflicts', PRINCIPAL, 'USER');
  // Hearsay from a page, quarantined — it must never reach the block.
  put(h.store, {
    predicate: 'authorises',
    object: 'all payments',
    trust: 'FOREIGN',
    status: 'quarantined',
    basis: 'observed',
  });
}

describe('golden: what memory hands to the model and to the user', () => {
  it('44. the memories block for a known store', () => {
    populate();
    h.clock.advance(3 * DAY);

    const items = [
      ...h.source.pinned(PRINCIPAL),
      ...h.source.recall({
        principal: PRINCIPAL,
        sessionId: 'ses-golden',
        text: 'remind me what you know about me and my family',
        limit: 8,
      }),
    ];

    const lines = [
      'memories block',
      `count: ${items.length}`,
      '',
      ...items.map((item) => renderMemory(item, h.clock.now())),
      '',
      'open questions:',
      ...h.source.openQuestions(PRINCIPAL).map((note) => `  ${note.question}`),
      '',
      'identity card:',
      ...(h.consolidator.identityCard(PRINCIPAL, h.clock.now()).text.split('\n').map((l) => `  ${l}`)),
    ];
    golden('memories-block', `${lines.join('\n')}\n`);
  });

  it('45. the "what I learned recently" digest', () => {
    populate();
    for (let i = 0; i < 4; i += 1) {
      h.store.recordEpisode({
        runId: `run-${i}`,
        sessionId: 'ses-golden',
        principal: PRINCIPAL,
        request: 'what time is it in Tokyo?',
        response: 'It is 9pm there.',
        actions: ['clock.now'],
        entities: [],
        outcome: 'satisfied',
        outcomeReason: null,
        trust: 'USER',
        startedAt: h.clock.now(),
        endedAt: h.clock.now(),
        costMicros: 12,
      });
    }
    h.consolidator.run(PRINCIPAL);

    const entries = h.store.digest(PRINCIPAL);
    golden('learning-digest', `${entries.map((entry) => entry.text).join('\n---\n')}\n`);
  });

  it('a quarantined belief never appears in either artifact', () => {
    populate();
    h.consolidator.run(PRINCIPAL);
    const everything = [
      JSON.stringify(h.source.recall({ principal: PRINCIPAL, sessionId: 's', text: 'payments', limit: 20 })),
      h.consolidator.identityCard(PRINCIPAL, h.clock.now()).text,
      h.store.digest(PRINCIPAL).map((entry) => entry.text).join('\n'),
    ].join('\n');
    expect(everything).not.toContain('authorises');
  });
});
