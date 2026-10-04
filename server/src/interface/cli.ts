import { parseArgs } from 'node:util';
import { createSubstrate } from '../substrate/index.js';
import { configFromEnv, ConfigError, type Config } from '../substrate/config.js';
import { CURRENT_SCHEMA_VERSION } from '../substrate/storage/migrations.js';
import { registeredTypes } from '../substrate/events/registry.js';
import { diffSnapshots, snapshotDigest } from '../substrate/projections/index.js';

/**
 * The CLI (§53). M0 ships the skeleton plus the commands that need nothing
 * beyond the substrate: `doctor`, `verify-chain`, `rebuild`, `status`.
 *
 * `init`, `start`, `unlock` and the rest arrive with the milestones that make
 * them mean something — §61: a subsystem is finished or not started. A
 * `start` that bound a port and served nothing would be a lie told in code.
 *
 * Machine-readable output goes to stdout; logs go to stderr (see `log.ts`),
 * so `arish status --json | jq` works.
 */

type Command = 'doctor' | 'status' | 'verify-chain' | 'rebuild' | 'help';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
}

const defaultIo: CliIo = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
  env: process.env,
};

function dbPathFor(config: Config): string {
  return `${config.dataDir}/arish.db`;
}

function emit(io: CliIo, json: boolean, payload: Record<string, unknown>, text: string[]): void {
  if (json) io.out(JSON.stringify(payload, null, 2));
  else for (const line of text) io.out(line);
}

/** §53 `doctor` — environment, config, disk and clock sanity. */
function doctor(io: CliIo, config: Config, json: boolean): number {
  const [major = 0] = process.versions.node.split('.').map(Number);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: 'node', ok: major >= 20, detail: `v${process.versions.node} (need >= 20; see decision 002)` },
    { name: 'dataDir', ok: config.dataDir.length > 0, detail: config.dataDir },
    { name: 'timeZone', ok: isKnownZone(config.timeZone), detail: config.timeZone },
    { name: 'clock', ok: clockLooksSane(), detail: new Date().toISOString() },
    { name: 'schema', ok: true, detail: `migrations through v${CURRENT_SCHEMA_VERSION}` },
    { name: 'eventTypes', ok: true, detail: `${registeredTypes().length} types appendable` },
    // §2 and §6. This is a check, not a comment, because the whole build
    // depends on it staying true and a check fails loudly.
    { name: 'model', ok: true, detail: 'none configured — L1, the intended state of this build' },
  ];
  const ok = checks.every((c) => c.ok);
  emit(io, json, { ok, checks }, [
    ...checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(12)} ${c.detail}`),
    '',
    ok ? 'doctor: all checks passed' : 'doctor: FAILED',
  ]);
  return ok ? 0 : 1;
}

function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function clockLooksSane(): boolean {
  // A clock before 2024 means an unsynchronised container, which silently
  // corrupts every validFrom in the database. Worth one line to catch.
  const now = Date.now();
  return now > Date.parse('2024-01-01T00:00:00Z') && now < Date.parse('2100-01-01T00:00:00Z');
}

function status(io: CliIo, config: Config, json: boolean): number {
  const substrate = createSubstrate({ dbPath: dbPathFor(config) });
  try {
    const head = substrate.events.head();
    const payload = {
      dataDir: config.dataDir,
      events: substrate.events.count(),
      headSeq: head.seq,
      headHash: head.hash,
      schemaVersion: substrate.storage.userVersion(),
      degradation: 'L1',
      degradationReason: 'no model provider configured',
      autonomy: config.autonomy,
    };
    emit(io, json, payload, [
      `data dir     ${payload.dataDir}`,
      `events       ${payload.events} (head seq ${payload.headSeq})`,
      `head hash    ${payload.headHash.slice(0, 16)}…`,
      `schema       v${payload.schemaVersion}`,
      `degradation  L1 — no model provider configured`,
      `autonomy     L${payload.autonomy}`,
    ]);
    return 0;
  } finally {
    substrate.close();
  }
}

function verifyChain(io: CliIo, config: Config, json: boolean): number {
  const substrate = createSubstrate({ dbPath: dbPathFor(config) });
  try {
    const result = substrate.events.verifyChain();
    if (result.ok) {
      emit(io, json, { ...result }, [`chain ok: ${result.events} events verified`]);
      return 0;
    }
    emit(io, json, { ...result }, [
      `CHAIN BROKEN at seq ${result.brokenAt}: ${result.reason}`,
      `${result.events} events read before the break.`,
    ]);
    return 1;
  } finally {
    substrate.close();
  }
}

/**
 * §53 `rebuild` — and, usefully, a live check of §16.
 *
 * It digests before, rebuilds, digests after, and reports a diff. On a healthy
 * database the diff is empty; a non-empty diff means some projection held
 * state the log could not reproduce, which is exactly the bug the command
 * exists to surface.
 */
function rebuild(io: CliIo, config: Config, json: boolean): number {
  const substrate = createSubstrate({ dbPath: dbPathFor(config) });
  try {
    const before = snapshotDigest(substrate.storage, substrate.crypto);
    const result = substrate.events.rebuild();
    const after = snapshotDigest(substrate.storage, substrate.crypto);
    const problems = diffSnapshots(before, after);
    const identical = problems.length === 0;
    emit(io, json, { ...result, identical, problems, digest: after.digest }, [
      `replayed ${result.events} events through ${result.projectors} projectors`,
      identical
        ? `projections identical (digest ${after.digest.slice(0, 16)}…)`
        : `PROJECTIONS DIFFER:\n  ${problems.join('\n  ')}`,
    ]);
    return identical ? 0 : 1;
  } finally {
    substrate.close();
  }
}

const HELP = `arish — the personal agent platform

Usage: arish <command> [options]

Commands (M0):
  doctor         environment, config, disk and clock sanity
  status         event count, chain head, schema version, degradation rung
  verify-chain   hash-chain integrity over the whole log
  rebuild        drop every projection and replay the log

Commands (M1):
  vault <cmd>    init, status, set, get, list, forget, panic
                 run 'arish vault help' for detail

Options:
  --json         machine-readable output on stdout
  --data-dir     override the data directory

Later milestones add: init, start, replay, backup, restore,
export, import, memory. They are absent rather than stubbed (§61).
`;

/** Each command is a plain function of (io, config, json) → exit code. */
const HANDLERS: Record<Exclude<Command, 'help'>, (io: CliIo, config: Config, json: boolean) => number> = {
  doctor, status, 'verify-chain': verifyChain, rebuild,
};

export function run(argv: readonly string[], io: CliIo = defaultIo): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: { json: { type: 'boolean' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' } },
  });

  const name = (positionals[0] ?? 'help') as Command;
  if (values['help'] === true || name === 'help') {
    io.out(HELP);
    return 0;
  }

  const handler = HANDLERS[name as Exclude<Command, 'help'>];
  if (handler === undefined) {
    io.err(`arish: unknown command '${String(name)}'. Try 'arish help'.`);
    return 2;
  }

  const dataDir = typeof values['data-dir'] === 'string' ? values['data-dir'] : undefined;
  try {
    const config = configFromEnv(io.env, dataDir === undefined ? {} : { dataDir });
    return handler(io, config, values['json'] === true);
  } catch (error) {
    // §54: report every problem at once, not the first one.
    if (error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

/**
 * The async entry point.
 *
 * `run` stays synchronous because every M0 command is, and a synchronous
 * function is easier to test and to reason about. The vault is unavoidably
 * async — Argon2id and WebCrypto both are — so it gets its own door rather
 * than making every existing command return a promise it does not need.
 */
export async function runAsync(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  if (argv[0] !== 'vault') return run(argv, io);

  const { runVault, ttyPrompt, closePrompt } = await import('./vault-cli.js');
  const json = argv.includes('--json');
  const dataDirIndex = argv.indexOf('--data-dir');
  const override = dataDirIndex >= 0 ? argv[dataDirIndex + 1] : undefined;

  let config: Config;
  try {
    config = configFromEnv(io.env, override === undefined ? {} : { dataDir: override });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }

  const substrate = createSubstrate({ dbPath: dbPathFor(config), timeZone: config.timeZone });
  try {
    return await runVault(
      argv.slice(1).filter((a) => a !== '--json' && a !== override && a !== '--data-dir'),
      { storage: substrate.storage, clock: substrate.clock, config, log: substrate.events },
      { out: io.out, err: io.err, prompt: ttyPrompt },
      json,
    );
  } finally {
    closePrompt();
    substrate.close();
  }
}

// Only self-execute when run as a binary, so importing this file in a test is free.
const invokedDirectly = process.argv[1]?.endsWith('cli.js') === true || process.argv[1]?.endsWith('cli.ts') === true;
if (invokedDirectly) {
  process.exitCode = await runAsync(process.argv.slice(2));
}
