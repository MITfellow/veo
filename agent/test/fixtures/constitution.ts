/**
 * Shared fixtures for the M7 suite.
 *
 * Same stance as the memory fixtures: a real substrate on a temp file. The
 * constitution's load-bearing properties — replay produces the same
 * document, an amendment is an event, `at(ts)` answers a historical
 * question — are all properties of the log, and a mock would assert them
 * against a reimplementation of itself.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../src/substrate/clock.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { ConstitutionStore } from '../../src/cognition/constitution/store.js';
import { AskBudget } from '../../src/cognition/calibration/probe.js';
import { BiasAuditor } from '../../src/cognition/calibration/audit.js';

export const PRINCIPAL = 'user:ara';
export const DAY = 86_400_000;

export interface ConstitutionHarness {
  substrate: Substrate;
  clock: FakeClock;
  store: ConstitutionStore;
  probes: AskBudget;
  auditor: BiasAuditor;
  dir: string;
  close(): void;
}

export function harness(options: { founding?: boolean } = {}): ConstitutionHarness {
  const dir = mkdtempSync(join(tmpdir(), 'arish-constitution-'));
  const clock = new FakeClock();
  const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'constitution.db') });
  const { storage, events, ids } = substrate;

  const store = new ConstitutionStore({ storage, events, clock, ids });
  if (options.founding !== false) store.ensureFounding(PRINCIPAL);

  return {
    substrate,
    clock,
    store,
    probes: new AskBudget({ storage, events, clock, ids }),
    auditor: new BiasAuditor({ storage, events, clock, ids }),
    dir,
    close() {
      substrate.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A plain user article: advisory, which is what the API can create. */
export function userArticle(text: string, subject = 'general', stance: 'require' | 'forbid' = 'require') {
  return {
    text,
    origin: 'user' as const,
    kind: 'directive' as const,
    enforcement: 'advisory' as const,
    subject,
    stance,
    cites: 'written by the principal',
  };
}
