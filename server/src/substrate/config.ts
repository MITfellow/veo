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

    /**
     * §D.4 vault settings.
     *
     * The Argon2 cost factor is duplicated here rather than imported from
     * `security/kdf.ts`: the layer rule (§12) forbids substrate importing
     * security, and inverting that for one constant would invert it forever.
     * `kdf.test.ts` asserts the two definitions have not drifted.
     */
    argon2: z
      .object({
        memMiB: z.number().int().min(8).max(4096),
        iterations: z.number().int().min(1).max(64),
        parallelism: z.number().int().min(1).max(16),
      })
      .strict()
      .default({ memMiB: 64, iterations: 3, parallelism: 1 }),

    /** Minutes of inactivity before the vault locks itself. 0 disables it. */
    idleLockMinutes: z.number().int().min(0).max(1440).default(60),

    /**
     * The model (§2, §59.17). **This is the entire attachment surface.**
     *
     * Attaching a model later must be configuration and nothing else, so
     * this object is the one place the rest of the platform consults. No
     * call site anywhere asks "is there a model?" — the job runner asks,
     * once, and selects a strategy.
     *
     * `provider: 'none'` is not a disabled state waiting to be enabled. It
     * is the shipped state, and every one of the eleven cognitive jobs has
     * a deterministic baseline that works in it. See decision 008.
     *
     * The API key is a `secret://` reference, never a value: §23 forbids a
     * credential in config, and the vault already exists to hold it.
     */
    model: z
      .object({
        provider: z.enum(['none', 'openai', 'anthropic', 'ollama', 'openai-compatible']).default('none'),
        /** Provider's model identifier, e.g. a chat model name. */
        name: z.string().default(''),
        /** `secret://openai-key/1`. Resolved at call time, never stored here. */
        apiKeyRef: z.string().default(''),
        /** For self-hosted or compatible endpoints. */
        baseUrl: z.string().default(''),
        /** Per-request ceiling, enforced before the request is built. */
        maxOutputTokens: z.number().int().min(1).max(32_000).default(2048),
        /** 0 keeps a model as reproducible as a model gets. */
        temperature: z.number().min(0).max(2).default(0),
        /**
         * Jobs the model is allowed to serve. Empty means all of them.
         * Listed explicitly so a model can be attached to summarisation
         * without also being handed turn generation.
         */
        jobs: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
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

  // The model's env surface. Present so a deployment can attach a model
  // without editing a file, absent from everything else (§59.17).
  const model: Record<string, unknown> = {};
  const setModel = (key: string, raw: string | undefined, coerce?: (v: string) => unknown): void => {
    if (raw === undefined || raw === '') return;
    model[key] = coerce ? coerce(raw) : raw;
  };
  setModel('provider', env['ARISH_MODEL_PROVIDER']);
  setModel('name', env['ARISH_MODEL_NAME']);
  setModel('apiKeyRef', env['ARISH_MODEL_API_KEY_REF']);
  setModel('baseUrl', env['ARISH_MODEL_BASE_URL']);
  setModel('maxOutputTokens', env['ARISH_MODEL_MAX_OUTPUT_TOKENS'], int);
  if (Object.keys(model).length > 0) fromEnv['model'] = model;

  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return loadConfig({ ...fromEnv, ...defined });
}
