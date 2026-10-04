import type { Logger } from './ports.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON lines on stderr.
 *
 * stderr rather than stdout because the CLI writes machine-readable output on
 * stdout (§D.5), and a log line interleaved into a JSON result is the kind of
 * bug that only shows up in a pipeline.
 */
export function createLogger(options: {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => number;
  base?: Record<string, unknown>;
}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = options.now;
  const base = options.base ?? {};

  function emit(at: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[at] < ORDER[level]) return;
    const record: Record<string, unknown> = { level: at, msg: message, ...base, ...fields };
    if (now) record['ts'] = now();
    write(JSON.stringify(record));
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything. For tests that do not assert on output. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const self: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => self };
  return self;
}
