import type { Logger } from '../../src/substrate/ports.js';

export interface CapturedLine {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

/** A logger that records instead of printing, so a test can assert on output. */
export class FakeLogger implements Logger {
  readonly lines: CapturedLine[] = [];

  constructor(private readonly base: Record<string, unknown> = {}) {}

  private push(level: string, message: string, fields?: Record<string, unknown>): void {
    this.lines.push({ level, message, fields: { ...this.base, ...fields } });
  }

  debug(m: string, f?: Record<string, unknown>): void { this.push('debug', m, f); }
  info(m: string, f?: Record<string, unknown>): void { this.push('info', m, f); }
  warn(m: string, f?: Record<string, unknown>): void { this.push('warn', m, f); }
  error(m: string, f?: Record<string, unknown>): void { this.push('error', m, f); }

  child(fields: Record<string, unknown>): Logger {
    const child = new FakeLogger({ ...this.base, ...fields });
    // Share the buffer so assertions see child output too.
    Object.defineProperty(child, 'lines', { value: this.lines });
    return child;
  }

  has(level: string, substring: string): boolean {
    return this.lines.some((l) => l.level === level && l.message.includes(substring));
  }
}
