import { type Config, loadConfig, testConfig } from './config.js';
import { FakeClock, SystemClock } from './clock.js';
import { EventLog, type Projector } from './events/log.js';
import { Redactor } from './events/redact.js';
import { NodeHashing } from './hash.js';
import { UlidIds, fakeIds } from './ids.js';
import { JsonLogger, NullLogger } from './log.js';
import type { Clock, Hashing, Ids, Logger, Storage } from './ports.js';
import { CORE_PROJECTORS } from './projections/core.js';
import { factsProjector } from './projections/facts.js';
import { personaProjector } from './projections/persona.js';
import { calendarProjector } from './projections/calendar.js';
import { tasksProjector } from './projections/tasks.js';
import { schedulingProjector } from './projections/scheduling.js';
import { constitutionProjector } from './projections/constitution.js';
import { SqliteStorage } from './storage/sqlite.js';
import { migrate } from './storage/migrate.js';

/**
 * The composition root for L1.
 *
 * §8 asks that building the whole thing from fakes fit in about twenty lines.
 * It does: `createSubstrate({ clock: new FakeClock() })`. Everything above this
 * layer receives a `Substrate` and never constructs an adapter itself, which
 * is what keeps `Date.now()` out of the kernel by construction rather than by
 * discipline.
 */
export interface Substrate {
  config: Config;
  clock: Clock;
  ids: Ids;
  storage: Storage;
  hashing: Hashing;
  logger: Logger;
  redactor: Redactor;
  events: EventLog;
  close(): void;
}

export interface SubstrateOptions {
  config?: Config;
  clock?: Clock;
  ids?: Ids;
  storage?: Storage;
  logger?: Logger;
  redactor?: Redactor;
  /** Defaults to the core set plus facts. */
  projectors?: readonly Projector[];
  dbPath?: string;
}

export const ALL_PROJECTORS: readonly Projector[] = Object.freeze([
  ...CORE_PROJECTORS,
  factsProjector,
  constitutionProjector,
  schedulingProjector,
  personaProjector,
  calendarProjector,
  tasksProjector,
]);

export function createSubstrate(options: SubstrateOptions = {}): Substrate {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? new SystemClock();
  const hashing = new NodeHashing();
  const ids = options.ids ?? new UlidIds(clock);
  const storage =
    options.storage ??
    new SqliteStorage({ path: options.dbPath ?? resolveDbPath(config) });
  const redactor = options.redactor ?? new Redactor();
  // The logger is built *after* the redactor and wired to it: log lines are a
  // leak surface just like event payloads (§13.2).
  const logger =
    options.logger ??
    new JsonLogger(
      {},
      { level: config.logging.level, clock, pretty: config.logging.pretty, redactor },
    );

  migrate(storage, (sql) => hashing.sha256Hex(sql), clock.now());

  const events = new EventLog(storage, clock, ids, hashing, redactor, logger);
  for (const p of options.projectors ?? ALL_PROJECTORS) events.register(p);

  return {
    config,
    clock,
    ids,
    storage,
    hashing,
    logger,
    redactor,
    events,
    close: () => storage.close(),
  };
}

/** The in-memory substrate every test starts from: deterministic clock, seeded ids. */
export function createTestSubstrate(
  options: {
    clock?: FakeClock;
    seed?: number;
    projectors?: readonly Projector[];
    /**
     * On-disk path instead of `:memory:`.
     *
     * Needed by any test that simulates a process restart: with `:memory:`
     * the "second process" silently gets an empty database and the test
     * passes while proving nothing. One did exactly that until this existed.
     */
    dbPath?: string;
  } = {},
): Substrate & { clock: FakeClock } {
  const clock = options.clock ?? new FakeClock();
  const substrate = createSubstrate({
    config: testConfig(),
    clock,
    ids: fakeIds(clock, options.seed ?? 1),
    storage: new SqliteStorage({ path: options.dbPath ?? ':memory:' }),
    logger: new NullLogger(),
    ...(options.projectors ? { projectors: options.projectors } : {}),
  });
  return { ...substrate, clock };
}

function resolveDbPath(config: Config): string {
  if (config.dataDir === ':memory:') return ':memory:';
  return `${config.dataDir.replace(/\/+$/, '')}/${config.dbFile}`;
}

export * from './ports.js';
export { FakeClock, SystemClock } from './clock.js';
export { UlidIds, fakeIds, seededRandom, decodeTime } from './ids.js';
export { canonicalJson, NodeHashing } from './hash.js';
export { JsonLogger, NullLogger } from './log.js';
export { Redactor, DEFAULT_PATTERNS, placeholder } from './events/redact.js';
export { EventLog } from './events/log.js';
export type { Projector, AppendInput, ReadQuery, ChainVerification } from './events/log.js';
export * from './events/types.js';
export * from './events/envelope.js';
export { upcast, registerUpcaster, withUpcasters, UPCASTERS } from './events/migrations/index.js';
export { SqliteStorage } from './storage/sqlite.js';
export { migrate, MIGRATIONS } from './storage/migrate.js';
export { CORE_PROJECTORS } from './projections/core.js';
export * from './projections/facts.js';
export { snapshotProjections, snapshotDigest } from './projections/snapshot.js';
export { ConfigSchema, loadConfig, testConfig } from './config.js';
export type { Config } from './config.js';
