import type { Clock, LogFields, LogLevel, Logger } from './ports.js';

/**
 * Operational logging — *not* the event log.
 *
 * The distinction matters and is easy to blur: the event log is history and is
 * durable, hashed and replayable; this is a debugging aid that can be thrown
 * away. If something belongs in an audit trail, it is an event, not a log line.
 *
 * Lines are JSON (one object per line) because the thing you do with logs at
 * 2am is grep and jq them, and carry `correlationId` so a single user request
 * can be followed across a suspend, a resume and a background run.
 */

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  level?: LogLevel;
  clock?: Clock;
  sink?: (line: string) => void;
  pretty?: boolean;
  /**
   * Applied to the fully serialized line, immediately before it is written.
   *
   * Logs are a surface (§13.2: a secret value never enters "a log line"), and
   * the adversarial fuzz found this gap: the event log redacted faithfully
   * while `logger.error('failed', { authorization: token })` wrote the token
   * straight to stderr. Redacting the *serialized* line rather than each field
   * is deliberate — a secret nested three levels into a `fields` object, used
   * as a key, or embedded in a stack trace is all one string by that point.
   */
  redactor?: { redactString(input: string): string };
}

export class JsonLogger implements Logger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly clock: Clock | undefined;
  private readonly pretty: boolean;

  constructor(
    private readonly fields: LogFields = {},
    private readonly options: JsonLoggerOptions = {},
  ) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.clock = options.clock;
    this.pretty = options.pretty ?? false;
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({ ...this.fields, ...fields }, this.options);
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (RANK[level] < RANK[this.level]) return;
    const record = {
      level,
      msg,
      // Falls back to Date.now only when no clock was injected, which is only
      // ever process bootstrap — kernel code always passes one.
      ts: this.clock?.now() ?? Date.now(),
      ...this.fields,
      ...fields,
    };
    const line = this.pretty ? prettyLine(record) : JSON.stringify(record);
    this.sink(this.options.redactor ? this.options.redactor.redactString(line) : line);
  }
}

function prettyLine(record: Record<string, unknown>): string {
  const { level, msg, ts, ...rest } = record;
  const time = new Date(Number(ts)).toISOString().slice(11, 23);
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${time} ${String(level).toUpperCase().padEnd(5)} ${String(msg)}${extra}`;
}

/** Discards everything. Tests assert on events, not on log lines. */
export class NullLogger implements Logger {
  child(): Logger {
    return this;
  }
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
