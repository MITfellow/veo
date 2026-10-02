import { z } from 'zod';

/**
 * Configuration: one schema, parsed once, frozen (§8).
 *
 * Nothing in the system reads `process.env` directly. Every knob is declared
 * here with a default and a type, so "what can this system be configured to
 * do" has a single answer you can read in a minute, and a typo in an env var
 * fails at boot rather than at 3am inside a tool call.
 */

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

export const ConfigSchema = z.object({
  env: z.enum(['development', 'test', 'production']).default('development'),

  /** Everything the agent owns lives under one directory; backup is `cp -r`. */
  dataDir: z.string().default('./.arish'),
  dbFile: z.string().default('arish.db'),

  http: z.object({
    host: z.string().default('127.0.0.1'),
    port: port.default(7777),
  }).default({}),

  budgets: z.object({
    maxStepsPerRun: positiveInt.default(24),
    maxTokensPerRun: positiveInt.default(200_000),
    maxWallClockMs: positiveInt.default(300_000),
    maxCostCentsPerRun: z.coerce.number().nonnegative().default(100),
    maxCostCentsPerDay: z.coerce.number().nonnegative().default(1000),
  }).default({}),

  context: z.object({
    /** Total budget for assembled context; blocks are dropped to fit (§21). */
    tokenBudget: positiveInt.default(24_000),
    recentMessages: positiveInt.default(12),
  }).default({}),

  memory: z.object({
    /** Below this, a candidate fact is not written at all. */
    minConfidenceToWrite: z.coerce.number().min(0).max(1).default(0.35),
    /** Half-life in days for recency scoring, per stability class. */
    halfLifeVolatileDays: positiveInt.default(7),
    halfLifeSlowDays: positiveInt.default(180),
    halfLifeStableDays: positiveInt.default(3650),
    recallLimit: positiveInt.default(20),
  }).default({}),

  security: z.object({
    /** Argon2id cost, tuned at M1; declared now so it is not forgotten. */
    kdfMemoryKib: positiveInt.default(65_536),
    kdfIterations: positiveInt.default(3),
    kdfParallelism: positiveInt.default(1),
    /** Approvals expire; a grant from last March is not consent today. */
    approvalTtlMs: positiveInt.default(15 * 60 * 1000),
  }).default({}),

  queue: z.object({
    pollIntervalMs: positiveInt.default(250),
    maxAttempts: positiveInt.default(5),
    baseBackoffMs: positiveInt.default(1000),
    leaseMs: positiveInt.default(60_000),
  }).default({}),

  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    pretty: z.coerce.boolean().default(false),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Env vars map to nested keys with `__` as the separator: `ARISH_HTTP__PORT`.
 * Explicit rather than clever — a flat `ARISH_PORT` would start colliding the
 * moment two sections both want a "port".
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ARISH_') || value === undefined) continue;
    const path = key
      .slice('ARISH_'.length)
      .toLowerCase()
      .split('__')
      .map(snakeToCamel);
    setPath(raw, path, value);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`invalid configuration:\n${detail}`);
  }
  return deepFreeze(parsed.data);
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = ConfigSchema.parse({ env: 'test', dataDir: ':memory:' });
  return deepFreeze({ ...base, ...overrides });
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = node[key];
    if (typeof next !== 'object' || next === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
