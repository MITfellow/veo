/**
 * `npm run verify-chain -- <path-to-db>`
 *
 * Recomputes the hash chain over an existing log and reports anything that
 * does not add up. Exits non-zero on a problem so it can run from cron.
 *
 * This is deliberately a separate entry point from the running agent: you want
 * to be able to check the integrity of a backup, on a different machine, with
 * the agent switched off.
 */
import { SystemClock } from '../src/substrate/clock.js';
import { NodeHashing } from '../src/substrate/hash.js';
import { NullLogger } from '../src/substrate/log.js';
import { UlidIds } from '../src/substrate/ids.js';
import { Redactor } from '../src/substrate/events/redact.js';
import { EventLog } from '../src/substrate/events/log.js';
import { SqliteStorage } from '../src/substrate/storage/sqlite.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: npm run verify-chain -- <path-to-db>');
  process.exit(2);
}

const clock = new SystemClock();
const hashing = new NodeHashing();
const storage = new SqliteStorage({ path, readonly: true });
const log = new EventLog(storage, clock, new UlidIds(clock), hashing, new Redactor(), new NullLogger());

const started = performance.now();
const result = log.verifyChain();
const elapsed = Math.round(performance.now() - started);

if (result.ok) {
  console.log(`✓ chain intact — ${result.checked} events verified in ${elapsed}ms`);
  console.log(`  head: seq ${log.head().seq} · ${log.head().hash}`);
  storage.close();
  process.exit(0);
}

console.error(`✗ chain BROKEN — ${result.problems.length} problem(s) across ${result.checked} events\n`);
for (const p of result.problems) {
  console.error(`  seq ${p.seq} (${p.id}): ${p.problem}`);
}
console.error(
  `\nThe log is the only source of truth, so this is not a cosmetic failure.\n` +
    `Restore from the last backup whose chain verifies, then replay anything after it.`,
);
storage.close();
process.exit(1);
