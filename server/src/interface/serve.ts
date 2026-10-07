import { createSubstrate } from '../substrate/index.js';
import { configFromEnv, ConfigError, type Config } from '../substrate/config.js';
import type { CliIo } from './cli.js';

/**
 * `arish serve`, lifted out of the dispatcher.
 *
 * Not a cosmetic split: `cli.ts` passed 400 lines because every subsystem
 * added a door to it, and the one file that routes every command is the
 * worst place for the body of any of them.
 */

function dbPathFor(config: Config): string {
  return `${config.dataDir}/arish.db`;
}

/** `arish serve` — the Get Started surface and the local JSON API. */
export async function serve(argv: readonly string[], io: CliIo): Promise<number> {
  const { createHttpServer, listen } = await import('./http.js');
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
  const hostIndex = argv.indexOf('--host');
  const portIndex = argv.indexOf('--port');
  const host = hostIndex >= 0 ? (argv[hostIndex + 1] ?? config.host) : config.host;
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : config.port;

  const server = createHttpServer({
    storage: substrate.storage,
    config,
    now: () => substrate.clock.now(),
    eventCount: () => substrate.events.count(),
    digest: (input) => substrate.crypto.sha256(input),
    nextId: () => substrate.ids.ulid(),
    appendEvent: (event) => {
      substrate.events.append(event);
    },
  });

  const bound = await listen(server, host, port);
  io.out(`arish is listening on http://${bound.host}:${bound.port}`);
  io.out('model: none configured — L1, the intended state of this build');
  io.err('Press Ctrl+C to stop.');

  // Resolve only when the server closes, so the process stays alive.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
      substrate.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

