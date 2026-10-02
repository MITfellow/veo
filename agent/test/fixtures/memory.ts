/**
 * Shared fixtures for the M6 suite.
 *
 * Every memory test runs against a real substrate on a temp file — no mocked
 * Storage. Memory's hardest properties (bitemporality, shredding, FTS,
 * idempotent consolidation) are properties of the *database*, and a fake
 * store would assert them against a reimplementation of itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../src/substrate/clock.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { EntityResolver } from '../../src/cognition/memory/entities.js';
import { PatternExtractor } from '../../src/cognition/memory/extract.js';
import { MemoryReader } from '../../src/cognition/memory/read.js';
import { MemoryStore } from '../../src/cognition/memory/store.js';
import { MemoryWriter } from '../../src/cognition/memory/write.js';
import { Consolidator } from '../../src/cognition/memory/consolidate.js';
import { StoredMemorySource } from '../../src/cognition/memory/source.js';
import { HashEmbedder } from '../../src/providers/fake-embedder.js';
import type { Candidate, Fact } from '../../src/cognition/memory/types.js';

export const PRINCIPAL = 'user:ara';
export const DAY = 86_400_000;

export interface MemoryHarness {
  substrate: Substrate;
  clock: FakeClock;
  store: MemoryStore;
  reader: MemoryReader;
  writer: MemoryWriter;
  entities: EntityResolver;
  consolidator: Consolidator;
  source: StoredMemorySource;
  dir: string;
  close(): void;
}

export function harness(options: { embedder?: boolean } = {}): MemoryHarness {
  const dir = mkdtempSync(join(tmpdir(), 'arish-memory-'));
  const clock = new FakeClock();
  const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'memory.db') });
  const { storage, events, ids } = substrate;

  const store = new MemoryStore({ storage, events, clock, ids });
  const entities = new EntityResolver({ storage, events, clock, ids, principal: PRINCIPAL });
  const embedder = options.embedder === false ? undefined : new HashEmbedder();
  const reader = new MemoryReader({ store, ...(embedder === undefined ? {} : { embedder }) });
  const writer = new MemoryWriter({
    store,
    events,
    clock,
    extractor: new PatternExtractor(),
    entities,
    ...(embedder === undefined ? {} : { embedder }),
  });
  const consolidator = new Consolidator({ store, events, clock });
  const source = new StoredMemorySource({ store, reader, clock });

  return {
    substrate,
    clock,
    store,
    reader,
    writer,
    entities,
    consolidator,
    source,
    dir,
    close: () => {
      substrate.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A well-formed candidate; override one field per test to break one thing. */
export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    subject: { id: 'self', kind: 'self', label: 'you' },
    predicate: 'works_at',
    object: 'Anthropic',
    basis: 'asserted_by_user',
    confidence: 0.8,
    sources: [{ eventId: 'evt-1', quote: 'I work at Anthropic', span: [0, 19] }],
    stability: 'slow',
    sensitivity: 'normal',
    transient: false,
    utterance: 'I work at Anthropic',
    ...over,
  } as Candidate;
}

/** Write a fact straight into the store, skipping extraction and the gate. */
export function put(
  store: MemoryStore,
  over: Partial<Parameters<MemoryStore['write']>[0]> = {},
): string {
  return store.write({
    principal: PRINCIPAL,
    subject: { id: 'self', kind: 'self', label: 'you' },
    predicate: 'works_at',
    object: 'Anthropic',
    basis: 'asserted_by_user',
    confidence: 0.8,
    sources: [{ eventId: 'evt-1', quote: 'I work at Anthropic' }],
    trust: 'USER',
    ...over,
  });
}

export const text = (fact: Fact): string => String(fact.object);
