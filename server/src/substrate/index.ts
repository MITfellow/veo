import { systemClock } from './clock.js';
import { nodeCrypto } from './crypto.js';
import { createEventLog, type EventLog } from './events/log.js';
import { createRedactor, type Redactor } from './events/redact.js';
import { createIds } from './ids.js';
import { createLogger, silentLogger } from './log.js';
import type { Clock, CryptoPort, Ids, Logger, Ports, Storage } from './ports.js';
import { allProjectors } from './projections/index.js';
import { openStorage } from './storage/sqlite.js';

/**
 * The substrate composition root.
 *
 * §14 requires the whole platform to be constructible with fakes in under
 * twenty lines. That is only achievable if assembly lives in one place and
 * takes every port as an override, so a test supplies three fakes and gets
 * real wiring for everything else.
 */
export interface Substrate extends Ports {
  events: EventLog;
  close(): void;
}

export interface SubstrateOptions {
  dbPath: string;
  clock?: Clock;
  ids?: Ids;
  crypto?: CryptoPort;
  log?: Logger;
  storage?: Storage;
  redactor?: Redactor;
  timeZone?: string;
}

export function createSubstrate(options: SubstrateOptions): Substrate {
  const crypto = options.crypto ?? nodeCrypto();
  const clock = options.clock ?? systemClock(options.timeZone);
  const ids = options.ids ?? createIds({ now: () => clock.now(), crypto });
  const log = options.log ?? createLogger({ now: () => clock.now() });
  const storage = options.storage ?? openStorage({ path: options.dbPath });

  const events = createEventLog({
    storage,
    clock,
    ids,
    crypto,
    redactor: options.redactor ?? createRedactor(),
  });
  for (const projector of allProjectors()) events.register(projector);

  return { clock, ids, crypto, log, storage, events, close: () => storage.close() };
}

export { silentLogger };
