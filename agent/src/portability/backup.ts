/**
 * §13.5: "an untested backup is a rumor."
 *
 * So the test is a route, not a paragraph in a README. `verifyBackup()`
 * takes the live database file, copies it, opens the copy as a fresh
 * substrate, and then does the three things that distinguish a backup
 * from a file of the right size:
 *
 *   1. verifies the hash chain end to end;
 *   2. drops every projection and rebuilds from the events alone,
 *      comparing the digest to the live one;
 *   3. reads something real back out — the fact count, the constitution
 *      version, the schedule count — because a database can satisfy every
 *      integrity check and still be empty.
 *
 * It never touches the live file. SQLite's online backup API is used
 * rather than `cp`, so it is safe while the agent is running: a plain
 * copy of a database with a hot WAL is the classic way to produce a
 * backup that verifies in the lab and fails in the fire.
 */
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubstrate, type Substrate } from '../substrate/index.js';
import { snapshotDigest } from '../substrate/projections/snapshot.js';

export interface BackupReport {
  ok: boolean;
  checkedAt: number;
  sourcePath: string;
  bytes: number;
  events: number;
  chain: { ok: boolean; checked: number; problems: Array<{ seq: number; problem: string }> };
  projections: { rebuilt: boolean; digestMatches: boolean; liveDigest: string; copyDigest: string };
  contents: { facts: number; sessions: number; schedules: number; constitutionVersion: number };
  /** Plain sentences, in the order a person would want to read them. */
  notes: string[];
  elapsedMs: number;
}

export interface VerifyOptions {
  /** The live substrate, read for its digest and left strictly alone. */
  live: Substrate;
  /** Path of the database file the live substrate is using. */
  dbPath: string;
  now: number;
}

export function verifyBackup(options: VerifyOptions): BackupReport {
  const started = Date.now();
  const notes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'arish-backup-'));
  const copyPath = join(dir, 'backup.db');

  let copy: Substrate | null = null;
  try {
    // SQLite's own backup API: consistent while the agent is writing.
    options.live.storage.backupTo(copyPath);
    notes.push(`copied the live database to a temporary file (${statSync(copyPath).size} bytes)`);

    copy = createSubstrate({ dbPath: copyPath });

    const chain = copy.events.verifyChain();
    notes.push(
      chain.ok
        ? `the hash chain verifies across all ${copy.events.count()} events`
        : `THE HASH CHAIN IS BROKEN at seq ${chain.problems[0]?.seq ?? '?'} — ` +
          `${chain.problems[0]?.problem ?? 'unknown problem'}`,
    );

    const liveDigest = snapshotDigest(options.live.storage, options.live.hashing);
    copy.events.rebuild();
    const copyDigest = snapshotDigest(copy.storage, copy.hashing);
    const digestMatches = liveDigest === copyDigest;
    notes.push(
      digestMatches
        ? 'every projection rebuilds from the events alone, byte-identically'
        : 'the rebuilt projections DIFFER from the live ones',
    );

    const count = (sql: string): number =>
      copy!.storage.get<{ n: number }>(sql)?.n ?? 0;
    const contents = {
      facts: count(`SELECT COUNT(*) AS n FROM facts WHERE status = 'active'`),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
      schedules: count('SELECT COUNT(*) AS n FROM schedules'),
      constitutionVersion:
        copy.storage.get<{ v: number | null }>(
          'SELECT MAX(version) AS v FROM constitution_versions',
        )?.v ?? 0,
    };
    notes.push(
      `read back from the copy: ${contents.facts} active fact(s), ` +
        `${contents.sessions} session(s), ${contents.schedules} schedule(s), ` +
        `constitution v${contents.constitutionVersion}`,
    );

    const ok = chain.ok && digestMatches;
    if (!ok) notes.push('this backup should NOT be relied on — investigate before you need it');

    return {
      ok,
      checkedAt: options.now,
      sourcePath: options.dbPath,
      bytes: existsSync(copyPath) ? statSync(copyPath).size : 0,
      events: copy.events.count(),
      chain: {
        ok: chain.ok,
        checked: chain.checked,
        problems: chain.problems.map((p) => ({ seq: p.seq, problem: p.problem })),
      },
      projections: { rebuilt: true, digestMatches, liveDigest, copyDigest },
      contents,
      notes,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    notes.push(`verification failed: ${(error as Error).message}`);
    return {
      ok: false,
      checkedAt: options.now,
      sourcePath: options.dbPath,
      bytes: 0,
      events: 0,
      chain: { ok: false, checked: 0, problems: [] },
      projections: { rebuilt: false, digestMatches: false, liveDigest: '', copyDigest: '' },
      contents: { facts: 0, sessions: 0, schedules: 0, constitutionVersion: 0 },
      notes,
      elapsedMs: Date.now() - started,
    };
  } finally {
    copy?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
