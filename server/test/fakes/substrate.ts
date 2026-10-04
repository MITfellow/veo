import { createSubstrate, type Substrate } from '../../src/substrate/index.js';
import { FakeClock } from './clock.js';
import { FakeCrypto } from './crypto.js';
import { FakeLogger } from './logger.js';

/**
 * §14's twenty-line constructibility, made into one line.
 *
 * In-memory SQLite by default: a test that wants durability across a reopen
 * passes a path, and everything else gets a database that vanishes with the
 * process.
 */
export interface TestSubstrate extends Substrate {
  clock: FakeClock;
  fakeLog: FakeLogger;
}

export function createTestSubstrate(options: { dbPath?: string; start?: string } = {}): TestSubstrate {
  const clock = new FakeClock(options.start ?? '2026-01-01T00:00:00.000Z');
  const crypto = new FakeCrypto();
  const fakeLog = new FakeLogger();
  const substrate = createSubstrate({
    dbPath: options.dbPath ?? ':memory:',
    clock,
    crypto,
    log: fakeLog,
  });
  return Object.assign(substrate, { clock, fakeLog });
}
