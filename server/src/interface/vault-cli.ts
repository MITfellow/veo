import { createInterface } from 'node:readline';
import { Vault, VaultError, type SecretRef, type VaultEvents } from '../security/vault.js';
import type { Clock, Storage } from '../substrate/ports.js';

import type { Config } from '../substrate/config.js';
import type { EventLog } from '../substrate/events/log.js';

/**
 * `arish vault …` (§53, M1's runnable demo).
 *
 * Shipped now because M1's central claim — that forgetting is cryptographic
 * and irreversible — is only believable if you can do it by hand and then go
 * looking for the data with a SQLite shell. A green test proves it to me; a
 * command proves it to the user.
 *
 * Passphrases are read from a TTY, never from `argv`. A passphrase in `argv`
 * is in the process list, the shell history and every `ps` any other user on
 * the machine runs — which would make §23 ceremonial.
 */

/**
 * No `unlock` command.
 *
 * Each CLI invocation is its own process, so an `arish vault unlock` would
 * unlock a vault and then exit, discarding the key — ceremony that looks
 * like a feature. Commands that need the vault prompt for the passphrase and
 * lock again in a `finally`. A persistent unlocked session belongs with the
 * daemon in M7, and is absent rather than stubbed (§61).
 */
export type VaultCommand = 'init' | 'status' | 'set' | 'get' | 'list' | 'forget' | 'panic';

export interface VaultCliIo {
  out(line: string): void;
  err(line: string): void;
  /** Injected so tests never need a TTY. */
  prompt(label: string): Promise<string>;
}

interface LineReader {
  rl: ReturnType<typeof createInterface>;
  /** Lines received but not yet asked for. */
  pending: string[];
  /** Askers waiting for a line that has not arrived. */
  waiting: Array<(line: string) => void>;
  ended: boolean;
}

let reader: LineReader | null = null;

function openReader(): LineReader {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  const r: LineReader = { rl, pending: [], waiting: [], ended: false };
  // readline emits every buffered line as soon as the chunk arrives, so a
  // `question` registered after the fact never sees its line. Piping two
  // lines into `vault init` lost the confirmation and hung the process on an
  // unsettled await (Node exit code 13). Queue the lines instead.
  rl.on('line', (line: string) => {
    const next = r.waiting.shift();
    if (next) next(line);
    else r.pending.push(line);
  });
  rl.on('close', () => {
    r.ended = true;
    // Never leave an asker hanging on EOF; an empty answer fails validation
    // loudly, which is the right outcome for a truncated script.
    while (r.waiting.length > 0) r.waiting.shift()?.('');
  });
  return r;
}

/**
 * Read one answer from stdin.
 *
 * The prompt goes to stderr so `arish vault set x | …` pipes the reference
 * and not the prompt, and so the same binary works interactively and under a
 * pipe without branching on `isTTY` anywhere but the echo.
 */
export function ttyPrompt(label: string): Promise<string> {
  reader ??= openReader();
  const r = reader;
  if (process.stdin.isTTY === true) process.stderr.write(`${label}: `);

  const buffered = r.pending.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (r.ended) return Promise.resolve('');
  return new Promise((resolve) => r.waiting.push(resolve));
}

/** Release stdin so the process can exit after the last prompt. */
export function closePrompt(): void {
  reader?.rl.close();
  reader = null;
}

/** The vault emits to the event log; values are structurally absent (§23). */
function vaultEvents(log: EventLog): VaultEvents {
  const append = (type: string, payload: Record<string, unknown>): void => {
    log.append({ type: type as never, actor: 'user:cli', trust: 'USER', payload });
  };
  return {
    secretCreated: (ref) => append('vault.secret.created', { reference: ref.uri, name: ref.name, version: ref.version }),
    secretRead: (ref, ctx) => append('vault.secret.read', { reference: ref.uri, principal: ctx.principal, runId: ctx.runId ?? null, tool: ctx.tool ?? null }),
    unlocked: () => append('vault.unlocked', { reason: 'explicit' }),
    locked: (_at, reason) => append('vault.locked', { reason }),
    destroyed: () => append('vault.secret.destroyed', { keyId: 'vault', scope: 'vault' }),
    itemShredded: (keyId) => append('vault.secret.destroyed', { keyId, scope: 'item' }),
  };
}

export interface VaultCliDeps {
  storage: Storage;
  clock: Clock;
  config: Config;
  log: EventLog;
}

function makeVault(deps: VaultCliDeps): Vault {
  return new Vault({
    storage: deps.storage,
    clock: deps.clock,
    argon2: deps.config.argon2,
    idleLockMinutes: deps.config.idleLockMinutes,
    events: vaultEvents(deps.log),
  });
}

async function unlockInteractive(vault: Vault, io: VaultCliIo): Promise<boolean> {
  if (!vault.isInitialized()) {
    io.err('Vault not initialised. Run: arish vault init');
    return false;
  }
  await vault.unlock(await io.prompt('Passphrase'));
  return true;
}

async function cmdInit(vault: Vault, io: VaultCliIo, json: boolean): Promise<number> {
  if (vault.isInitialized()) {
    io.err('Vault already initialised. Refusing to overwrite it.');
    return 1;
  }
  const passphrase = await io.prompt('Choose a passphrase');
  if (passphrase.length < 8) {
    io.err('Passphrase must be at least 8 characters.');
    return 2;
  }
  if (await io.prompt('Confirm passphrase') !== passphrase) {
    io.err('Passphrases did not match.');
    return 2;
  }
  const { recoveryCode } = await vault.init(passphrase);
  if (json) io.out(JSON.stringify({ initialized: true, recoveryCode }, null, 2));
  else {
    io.out('Vault initialised.');
    io.out('');
    io.out(`  Recovery code: ${recoveryCode}`);
    io.out('');
    io.out('Write it down now. It unlocks the vault without the passphrase,');
    io.out('it is not stored anywhere, and it cannot be shown again.');
  }
  return 0;
}

function cmdStatus(vault: Vault, io: VaultCliIo, json: boolean): number {
  const state = !vault.isInitialized() ? 'uninitialized' : vault.locked ? 'locked' : 'unlocked';
  if (json) io.out(JSON.stringify({ state }, null, 2));
  else io.out(`vault: ${state}`);
  return 0;
}

async function cmdSet(vault: Vault, io: VaultCliIo, name: string, json: boolean): Promise<number> {
  if (!await unlockInteractive(vault, io)) return 1;
  const ref = await vault.put(name, await io.prompt(`Value for '${name}'`));
  if (json) io.out(JSON.stringify({ ref: ref.uri }, null, 2));
  else io.out(ref.uri);
  return 0;
}

async function cmdGet(vault: Vault, io: VaultCliIo, uri: string, reveal: boolean): Promise<number> {
  if (!await unlockInteractive(vault, io)) return 1;
  if (!reveal) {
    // The default is deliberately useless for exfiltration. You asked
    // whether it resolves; that is what you get.
    await vault.resolve(uri, { principal: 'user:cli', tool: 'vault.get' }, (v) => v.length);
    io.out(`${uri} resolves (use --reveal to print it)`);
    return 0;
  }
  await vault.resolve(uri, { principal: 'user:cli', tool: 'vault.reveal' }, (value) => void io.out(value));
  return 0;
}

async function cmdList(vault: Vault, io: VaultCliIo, json: boolean): Promise<number> {
  // Listing needs the vault open: the names are themselves sensitive, and
  // "which services does this person hold credentials for" is a profile.
  if (!await unlockInteractive(vault, io)) return 1;
  const items = vault.list();
  if (json) io.out(JSON.stringify({ secrets: items }, null, 2));
  else if (items.length === 0) io.out('(no secrets)');
  else for (const s of items) io.out(`${s.name}  v${s.version}`);
  return 0;
}

async function cmdForget(vault: Vault, io: VaultCliIo, keyId: string, json: boolean): Promise<number> {
  if (!await unlockInteractive(vault, io)) return 1;
  const shredded = vault.shred(keyId);
  if (json) io.out(JSON.stringify({ keyId, shredded }, null, 2));
  else io.out(shredded ? `Shredded ${keyId}. The ciphertext remains and is now undecryptable.` : `${keyId} was already gone.`);
  return 0;
}

async function cmdPanic(vault: Vault, io: VaultCliIo): Promise<number> {
  io.err('This destroys every key in the vault. All encrypted content becomes');
  io.err('permanently unreadable. There is no recovery, including with the');
  io.err('recovery code.');
  if (await io.prompt("Type 'destroy everything' to confirm") !== 'destroy everything') {
    io.err('Aborted.');
    return 1;
  }
  vault.panic();
  io.out('Vault destroyed.');
  return 0;
}

const USAGE = [
  'usage: arish vault <command>',
  '',
  '  init                 create the vault and print a recovery code',
  '  status               uninitialized | locked | unlocked',
  '  set <name>           store a secret, print its secret:// reference',
  '  get <ref> [--reveal] check a reference resolves; --reveal prints it',
  '  list                 names and versions, never values',
  '  forget <keyId>       crypto-shred one item, irreversibly',
  '  panic                destroy every key in the vault',
].join('\n');

/**
 * One handler per command, so dispatch stays a lookup rather than a switch
 * that grows a branch every milestone.
 */
type Handler = (vault: Vault, io: VaultCliIo, ctx: { arg: string | undefined; json: boolean; reveal: boolean }) => Promise<number> | number;

const HANDLERS: Record<VaultCommand, Handler> = {
  init: (v, io, c) => cmdInit(v, io, c.json),
  status: (v, io, c) => cmdStatus(v, io, c.json),
  list: (v, io, c) => cmdList(v, io, c.json),
  panic: (v, io) => cmdPanic(v, io),
  set: (v, io, c) => (c.arg === undefined ? usageError(io, 'set needs a name') : cmdSet(v, io, c.arg, c.json)),
  get: (v, io, c) => (c.arg === undefined ? usageError(io, 'get needs a secret:// reference') : cmdGet(v, io, c.arg, c.reveal)),
  forget: (v, io, c) => (c.arg === undefined ? usageError(io, 'forget needs a key id') : cmdForget(v, io, c.arg, c.json)),
};

function isVaultCommand(name: string): name is VaultCommand {
  return Object.prototype.hasOwnProperty.call(HANDLERS, name);
}

/** Dispatch. Returns a process exit code; never calls `process.exit`. */
export async function runVault(
  argv: readonly string[],
  deps: VaultCliDeps,
  io: VaultCliIo,
  json = false,
): Promise<number> {
  const [command, arg] = argv;
  if (command === undefined || command === 'help') {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (!isVaultCommand(command)) {
    io.err(`Unknown vault command: ${command}`);
    io.err(USAGE);
    return 1;
  }

  const vault = makeVault(deps);
  try {
    return await HANDLERS[command](vault, io, { arg, json, reveal: argv.includes('--reveal') });
  } catch (error: unknown) {
    if (error instanceof VaultError) {
      // The kind is the useful part and is safe to print; the message never
      // contains a secret value (§23, asserted in the M1 suite).
      io.err(`${error.kind}: ${error.message}`);
      return error.kind === 'locked' || error.kind === 'bad_passphrase' ? 1 : 2;
    }
    throw error;
  } finally {
    vault.lock();
  }
}

function usageError(io: VaultCliIo, message: string): number {
  io.err(message);
  io.err(USAGE);
  return 2;
}

export type { SecretRef };
