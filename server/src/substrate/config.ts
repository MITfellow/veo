import { z } from 'zod';

/**
 * Configuration is parsed once, at the edge, into typed values (§8).
 *
 * Two rules shape this file:
 *
 *   * **Unknown keys are an error.** A typo in a config file that silently
 *     does nothing is worse than a crash, because the user believes they
 *     changed the setting. `.strict()` everywhere.
 *   * **Every problem is reported at once.** zod already collects all issues;
 *     the job here is not to throw away that list by surfacing `issues[0]`.
 */

const LOG_LEVEL = z.enum(['debug', 'info', 'warn', 'error']);

export const ConfigSchema = z
  .object({
    /** Directory holding the database, artifacts and the vault. */
    dataDir: z.string().min(1).default('.arish'),
    /** IANA zone the user lives in. Not sniffed from the host (see clock.ts). */
    timeZone: z.string().min(1).default('UTC'),
    logLevel: LOG_LEVEL.default('info'),
    /** Loopback only. §D.1 pins 8787. */
    port: z.number().int().min(1).max(65_535).default(8787),
    host: z.string().min(1).default('127.0.0.1'),
    /** §30 autonomy ladder. L0 means the agent proposes and never acts. */
    autonomy: z.number().int().min(0).max(4).default(0),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parse a config object, reporting every problem rather than the first. */
export function loadConfig(input: unknown): Config {
  const parsed = ConfigSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  throw new ConfigError(problems);
}

/**
 * The single legal reader of the environment.
 *
 * Takes the environment as an argument so that the only `process.env` in the
 * platform is the one the CLI passes in, where lint can see it and a test can
 * replace it with an object literal.
 */
export function configFromEnv(env: Record<string, string | undefined>, overrides: Partial<Config> = {}): Config {
  const fromEnv: Record<string, unknown> = {};
  const set = (key: keyof Config, raw: string | undefined, coerce?: (v: string) => unknown): void => {
    if (raw === undefined || raw === '') return;
    fromEnv[key] = coerce ? coerce(raw) : raw;
  };
  const int = (v: string): unknown => (/^-?\d+$/.test(v) ? Number(v) : v);

  set('dataDir', env['ARISH_DATA_DIR']);
  set('timeZone', env['ARISH_TIME_ZONE']);
  set('logLevel', env['ARISH_LOG_LEVEL']);
  set('port', env['ARISH_PORT'], int);
  set('host', env['ARISH_HOST']);
  set('autonomy', env['ARISH_AUTONOMY'], int);

  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return loadConfig({ ...fromEnv, ...defined });
}
