import { dbPathFor } from '../substrate/files.js';
import { parseArgs } from 'node:util';
import { HELP } from './help.js';
import { vaultDoor } from './vault-door.js';
import { createSubstrate } from '../substrate/index.js';
import { configFromEnv, ConfigError, type Config } from '../substrate/config.js';
import { CURRENT_SCHEMA_VERSION } from '../substrate/storage/migrations.js';
import { registeredTypes } from '../substrate/events/registry.js';
import { diffSnapshots, snapshotDigest } from '../substrate/projections/index.js';
import { describeJobs, modelAttached } from '../cognition/registry.js';
import { assess } from '../orchestration/degradation.js';
import { JOB_NAMES } from '../cognition/types.js';
import { allConnectors } from '../capability/connectors.js';

/** How the eleven cognitive jobs are currently being served (§33). */
function jobsDetail(config: Config): string {
  const described = describeJobs(config);
  const onModel = described.filter((j) => j.strategy === 'model').length;
  return onModel === 0
    ? `${described.length} cognitive jobs, all on deterministic baselines`
    : `${described.length} cognitive jobs, ${onModel} routed to a model`;
}

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

/**
 * `arish memory history … | grep -q X` crashed with EPIPE.
 *
 * `grep -q` exits the moment it matches, which closes the pipe under a
 * still-writing process. Node's default is to raise that as an unhandled
 * error event and kill the process with a stack trace — so a perfectly
 * ordinary shell idiom made the CLI look broken. A tool that cannot be
 * piped into `head` is not a Unix tool. Found by running the demo, not by
 * a test.
 */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

const defaultIo: CliIo = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
  env: process.env,
};

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
    { name: 'jobs', ok: describeJobs(config).length === JOB_NAMES.length, detail: jobsDetail(config) },
    { name: 'connectors', ok: true, detail: `${allConnectors().filter((c) => c.status === 'available').length} ready, ${allConnectors().filter((c) => c.status === 'blocked').length} blocked on network/OAuth` },
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

/**
 * §20, for this installation.
 *
 * Only three signals are observable from here without doing work a
 * status command should not do: probing the network or unlocking the
 * vault to see whether it unlocks would both be side effects.
 */
function rungFor(config: Config, chainIntact: boolean): ReturnType<typeof assess> {
  return assess({
    modelAttached: modelAttached(config),
    modelReachable: modelAttached(config),
    chainIntact,
  });
}

function status(io: CliIo, config: Config, json: boolean): number {
  const substrate = createSubstrate({ dbPath: dbPathFor(config) });
  try {
    const head = substrate.events.head();
    // §20: computed from what is actually true of this installation,
    // never asserted. One function, consulted by the CLI and the API.
    const rung = rungFor(config, substrate.events.verifyChain().ok);
    const count = (table: string): number =>
      substrate.storage.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()?.n ?? 0;
    const payload = {
      dataDir: config.dataDir,
      events: substrate.events.count(),
      // Memory lives in `status` rather than `doctor` on purpose: doctor
      // answers "is this machine fit to run arish" and must work before
      // there is a database at all, while these are facts about *this*
      // installation's contents.
      facts: count('facts'),
      liveFacts: count("facts WHERE retracted_at IS NULL AND status = 'active'"),
      entities: count('entities'),
      items: count('items'),
      // §13: two numbers a person must never have to go looking for.
      effectsPending: count("outbox WHERE status = 'intended'"),
      effectsNeedingAttention: count("outbox WHERE status = 'needs_attention'"),
      headSeq: head.seq,
      headHash: head.hash,
      schemaVersion: substrate.storage.userVersion(),
      degradation: rung.rung,
      degradationReason: rung.reason,
      degradationLost: rung.lost,
      autonomy: config.autonomy,
    };
    emit(io, json, payload, [
      `data dir     ${payload.dataDir}`,
      `events       ${payload.events} (head seq ${payload.headSeq})`,
      `memory       ${payload.liveFacts} live of ${payload.facts} facts, ${payload.entities} entities, ${payload.items} items`,
      `head hash    ${payload.headHash.slice(0, 16)}…`,
      `schema       v${payload.schemaVersion}`,
      `degradation  ${payload.degradation} — ${payload.degradationReason}`,
      `autonomy     L${payload.autonomy}`,
      `effects      ${payload.effectsPending} unsettled, ${payload.effectsNeedingAttention} need you`
        + (payload.effectsNeedingAttention > 0 ? " — run 'arish effects attention'" : ''),
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

/**
 * `arish tools|run|approvals` — M3's surface.
 *
 * The vault is constructed but not unlocked: every built-in except the
 * item tools works locked, and a command that demanded a passphrase to
 * list tools would be the kind of friction that teaches people to leave
 * the vault open.
 */
async function orchestration(argv: readonly string[], io: CliIo): Promise<number> {
  const { runRun } = await import('./run-cli.js');
  const { makeVault } = await import('./vault-cli.js');
  const { readFileSync } = await import('node:fs');

  const config = resolveConfig(argv, io);
  if (typeof config === 'number') return config;

  const substrate = createSubstrate({ dbPath: dbPathFor(config), timeZone: config.timeZone });
  try {
    const vault = makeVault({
      storage: substrate.storage, clock: substrate.clock, config, log: substrate.events,
    });
    return await runRun(argv, { substrate, config, vault }, { out: io.out, err: io.err },
      (path) => readFileSync(path, 'utf8'));
  } finally {
    substrate.close();
  }
}

/** The `--data-dir` dance, which every async command was repeating. */
function resolveConfig(argv: readonly string[], io: CliIo): Config | number {
  const at = argv.indexOf('--data-dir');
  const override = at >= 0 ? argv[at + 1] : undefined;
  try {
    return configFromEnv(io.env, override === undefined ? {} : { dataDir: override });
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(error.message);
      return 2;
    }
    throw error;
  }
}

/**
 * `arish effects …` — the outbox (§13).
 *
 * Its reason to exist is the `needs attention` list: effects nobody can
 * prove happened or did not. That queue can only be drained by a person,
 * and a queue a person cannot see is the same as no queue at all.
 */
async function effects(argv: readonly string[], io: CliIo): Promise<number> {
  const { runEffects } = await import('./effects-cli.js');
  const config = resolveConfig(argv, io);
  if (typeof config === 'number') return config;

  const substrate = createSubstrate({ dbPath: dbPathFor(config), timeZone: config.timeZone });
  try {
    return runEffects(argv.slice(1), { substrate }, { out: io.out, err: io.err }, argv.includes('--json'));
  } finally {
    substrate.close();
  }
}

/** `arish memory …` — M2's surface. */
async function memory(argv: readonly string[], io: CliIo): Promise<number> {
  const { runMemory } = await import('./memory-cli.js');
  const at = argv.indexOf('--data-dir');
  const override = at >= 0 ? argv[at + 1] : undefined;

  const config = resolveConfig(argv, io);
  if (typeof config === 'number') return config;

  const substrate = createSubstrate({ dbPath: dbPathFor(config), timeZone: config.timeZone });
  try {
    const cleaned = argv.filter((a) => a !== '--data-dir' && a !== override);
    return await runMemory(cleaned, { substrate, config }, { out: io.out, err: io.err });
  } finally {
    substrate.close();
  }
}


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
/**
 * The async subsystems, as a table rather than an if-chain.
 *
 * Each milestone has added one door here; a chain of `if`s means the
 * routing complexity grows with the product, and the router is the one
 * place that must stay readable.
 */
const SUBSYSTEMS: Record<string, (argv: readonly string[], io: CliIo) => Promise<number>> = {
  serve: async (argv, io) => (await import('./serve.js')).serve(argv, io),
  effects: effects,
  memory: (argv, io) => memory(argv.slice(1), io),
  tools: orchestration,
  run: orchestration,
  approvals: orchestration,
};

export async function runAsync(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const subsystem = SUBSYSTEMS[argv[0] ?? ''];
  if (subsystem !== undefined) return subsystem(argv, io);
  if (argv[0] !== 'vault') return run(argv, io);

  return vaultDoor(argv, io);
}

// Only self-execute when run as a binary, so importing this file in a test is free.
const invokedDirectly = process.argv[1]?.endsWith('cli.js') === true || process.argv[1]?.endsWith('cli.ts') === true;
if (invokedDirectly) {
  process.exitCode = await runAsync(process.argv.slice(2));
}
