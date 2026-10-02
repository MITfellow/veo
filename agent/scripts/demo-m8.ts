/**
 * M8 demo — time, and what survives it.
 *
 *   npm run demo:m8
 *
 * The milestone's done-when is one sentence: "every weekday 9am" survives
 * restarts, a timezone change and a three-day outage, with correct
 * catch-up. This script is that sentence, executed, on a fake clock so it
 * finishes in a second instead of a week.
 *
 * Five acts: a schedule that keeps meaning 9am across a daylight-saving
 * change; the same schedule surviving a process restart; a laptop shut for
 * three days and the three catch-up policies that disagree about what to
 * do; a job failing, backing off deterministically and dead-lettering; and
 * the degradation ladder saying out loud what the agent cannot do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/substrate/clock.js';
import { createTestSubstrate } from '../src/substrate/index.js';
import { JobQueue } from '../src/orchestration/queue.js';
import { ScheduleStore } from '../src/orchestration/schedule.js';
import { Degradation } from '../src/orchestration/degradation.js';
import { instantOfLocal, nextFireAfter, parseCron } from '../src/orchestration/cron.js';

const line = (s = '') => console.log(s);
const rule = (t: string) => {
  line();
  line(`\x1b[1m${t}\x1b[0m`);
  line('─'.repeat(t.length));
};
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const dim = (s: string) => line(`  \x1b[2m${s}\x1b[0m`);

const PRINCIPAL = 'user:ara';
const NY = 'America/New_York';
const dir = mkdtempSync(join(tmpdir(), 'arish-demo-m8-'));

const wall = (at: number | null, tz: string): string =>
  at === null
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
        hour12: false,
      }).format(new Date(at));

/** A fresh stack over the same database file — i.e. a restart. */
function open(now: number, timezone = NY) {
  const clock = new FakeClock(now, timezone);
  const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'demo.db') });
  const { storage, events, ids } = substrate;
  const queue = new JobQueue({ storage, events, clock, ids, leaseMs: 60_000, baseBackoffMs: 1_000 });
  const schedules = new ScheduleStore({ storage, events, clock, ids, queue });
  return { substrate, clock, queue, schedules };
}

/* ── 1. 9am is a wall clock, not an offset ──────────────────────────────── */

rule('1. "Every weekday at 9am" across a daylight-saving change');

const march7 = instantOfLocal({ year: 2026, month: 3, day: 7, hour: 12, minute: 0 }, NY)!;
let app = open(march7);

const schedule = app.schedules.create(PRINCIPAL, {
  name: 'Morning briefing',
  spec: '0 9 * * 1-5',
  timezone: NY,
  payload: { prompt: 'What is on today?' },
});

dim(`created: ${schedule.spec} in ${schedule.timezone}`);
const cron = parseCron('0 9 * * 1-5');
let cursor = march7;
for (let i = 0; i < 4; i += 1) {
  cursor = nextFireAfter(cron, cursor, NY)!;
  const offset = -new Date(cursor).getTimezoneOffset();
  ok(`${wall(cursor, NY)}  (UTC instant ${new Date(cursor).toISOString()}, host offset ${offset})`);
}
dim('DST moved on Sunday 8 March. The UTC instants shift by an hour; the');
dim('wall clock does not. An offset-based scheduler would now be at 10am.');

/* ── 2. Restart ─────────────────────────────────────────────────────────── */

rule('2. It survives the process going away');

const before = app.schedules.get(schedule.id)!;
app.substrate.close();
dim('process exited');

app = open(march7 + 60_000);
const after = app.schedules.get(schedule.id)!;
ok(`reloaded "${after.name}" from SQLite, next fire unchanged: ${wall(after.nextFireAt, NY)}`);
dim(`(the same instant as before the restart: ${before.nextFireAt === after.nextFireAt})`);

/* ── 3. The laptop was shut for three days ──────────────────────────────── */

rule('3. Three days offline, and three opinions about what to do');

// Fire Monday's so there is a known last-fired, then jump the clock.
app.substrate.close();
const monday = instantOfLocal({ year: 2026, month: 3, day: 9, hour: 9, minute: 0 }, NY)!;
app = open(monday);
app.schedules.due();
ok(`Monday 09:00 fired. ${app.queue.counts().pending} job queued.`);
const first = app.queue.lease()!;
app.queue.complete(first.id, first.leaseToken);

const friday = instantOfLocal({ year: 2026, month: 3, day: 13, hour: 15, minute: 0 }, NY)!;
app.substrate.close();

for (const policy of ['fire-once', 'fire-all', 'skip'] as const) {
  app.substrate.close?.();
  rmSync(join(dir, 'policy.db'), { force: true });
  const clock = new FakeClock(monday, NY);
  const substrate = createTestSubstrate({ clock, dbPath: join(dir, 'policy.db') });
  const queue = new JobQueue({
    storage: substrate.storage,
    events: substrate.events,
    clock,
    ids: substrate.ids,
  });
  const schedules = new ScheduleStore({
    storage: substrate.storage,
    events: substrate.events,
    clock,
    ids: substrate.ids,
    queue,
  });
  schedules.create(PRINCIPAL, {
    name: 'Morning briefing',
    spec: '0 9 * * 1-5',
    timezone: NY,
    catchUp: policy,
    payload: { prompt: 'What is on today?' },
  });
  clock.set(friday);
  const result = schedules.due();
  ok(
    `${policy.padEnd(9)} → ran ${result.fired}, reported ${result.missed} missed, ` +
      `${queue.counts().pending} job(s) queued`,
  );
  substrate.close();
}
dim('Default is fire-once: you get this morning\'s briefing, and you are told');
dim('the other mornings happened without you. Four identical briefings at');
dim('once is noise; silence is a lie.');

/* ── 4. A job that keeps failing ────────────────────────────────────────── */

rule('4. Retry, deterministic backoff, dead letter');

app.substrate.close();
app = open(friday);
app.queue.enqueue({ kind: 'demo.flaky', principal: PRINCIPAL, payload: {}, maxAttempts: 3 });
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const leased = app.queue.lease()!;
  const outcome = app.queue.fail(leased.id, leased.leaseToken, 'the provider returned 503');
  if (outcome.retryAt !== null) {
    ok(`attempt ${attempt} failed → retry in ${Math.round((outcome.retryAt - app.clock.now()) / 1000)}s`);
    app.clock.set(outcome.retryAt);
  } else {
    ok(`attempt ${attempt} failed → dead-lettered: ${outcome.dead}`);
  }
}
const dead = app.queue.deadLetters();
ok(`dead letters: ${dead.length} — "${dead[0]?.error ?? ''}"`);
dim('The backoff is a hash of jobId:attempt, not Math.random — replaying the');
dim('log reproduces the same delays, which is what makes §8 true for time.');
// Replay takes the *dead letter's* id, not the job's: the dead row is the
// record, and the replay is a new job with the same intent.
const replayed = app.queue.replay(dead[0]!.id);
ok(`replayed by hand → new job ${replayed === null ? 'none' : replayed.slice(0, 12)}…`);

/* ── 5. Saying what it cannot do ────────────────────────────────────────── */

rule('5. The degradation ladder');

const ladder = new Degradation({ events: app.substrate.events, clock: app.clock, principal: PRINCIPAL });
ok(`start: ${ladder.current()} — ${ladder.state().meaning}`);
ladder.report('embedder', 'the embedding model is not responding');
ok(`embedder down: ${ladder.current()} — ${ladder.state().meaning}`);
ladder.report('model', 'the provider is returning 503');
ok(`model down too: ${ladder.current()} — ${ladder.state().meaning}`);
dim('The level is the max of what is wrong, not the latest thing that broke.');
ladder.clear('model');
ok(`model recovered: back to ${ladder.current()}`);
ladder.clear('embedder');
ok(`all clear: ${ladder.current()}`);

line();
dim('Every number above came from a fake clock. Nothing slept.');
line();

app.substrate.close();
rmSync(dir, { recursive: true, force: true });
