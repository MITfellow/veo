import { createSubstrate } from '../substrate/index.js';
import { configFromEnv, ConfigError, type Config } from '../substrate/config.js';
import { dbPathFor } from '../substrate/files.js';
import type { CliIo } from './cli.js';

/**
 * The vault's door into the CLI.
 *
 * It lives here rather than in `cli.ts` because it is the only command
 * that needs an interactive prompt, a passphrase and its own teardown —
 * three concerns the router has no business knowing about, and sixty
 * lines that pushed the router past its 400-line ceiling.
 */
export async function vaultDoor(argv: readonly string[], io: CliIo): Promise<number> {
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
