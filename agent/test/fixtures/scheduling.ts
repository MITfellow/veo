/**
 * Shared fixtures for the M8 suite.
 *
 * A real substrate on a temp file and a `FakeClock`, as everywhere else.
 * Time is the subject of this milestone, so it is the one thing that must
 * not be real: a test that waits for a lease to expire by sleeping is a
 * test that takes a minute and fails on a loaded machine.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../src/substrate/clock.js';
import { createTestSubstrate, type Substrate } from '../../src/substrate/index.js';
import { JobQueue } from '../../src/orchestration/queue.js';
import { ScheduleStore } from '../../src/orchestration/schedule.js';
import { Degradation } from '../../src/orchestration/degradation.js';

export const PRINCIPAL = 'user:ara';
export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const NY = 'America/New_York';

export interface SchedulingHarness {
  substrate: Substrate;
  clock: FakeClock;
  queue: JobQueue;
  schedules: ScheduleStore;
  degradation: Degradation;
  dir: string;
  /** Reopen the same database — the restart cases need a second process. */
  reopen(): SchedulingHarness;
  close(): void;
}

export function harness(options: { dir?: string; now?: number; timezone?: string } = {}): SchedulingHarness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'arish-scheduling-'));
  const clock = new FakeClock(options.now, options.timezone ?? NY);
  const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'scheduling.db') });
  const { storage, events, ids } = substrate;

  const queue = new JobQueue({ storage, events, clock, ids, leaseMs: 60_000 });
  const schedules = new ScheduleStore({ storage, events, clock, ids, queue });
  const degradation = new Degradation({ events, clock });

  return {
    substrate,
    clock,
    queue,
    schedules,
    degradation,
    dir,
    reopen() {
      substrate.close();
      return harness({ dir, now: clock.now(), timezone: clock.timezone() });
    },
    close() {
      substrate.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
