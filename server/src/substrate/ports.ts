/**
 * §8 — Ports, not globals.
 *
 * Every source of nondeterminism in the platform is declared here as an
 * interface. Nothing above this file may read the wall clock, generate a
 * random byte, touch the filesystem, open a socket or read the environment
 * except through one of these.
 *
 * The payoff is §16: a test can advance time by six months, replay ten
 * thousand events, and get the same bytes twice. The lint rule in
 * `eslint.config.js` is what keeps the payoff from decaying.
 */

/** Wall-clock time. The only legal source of "now". */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** IANA zone name the user lives in, e.g. `Asia/Kolkata`. */
  timeZone(): string;
}

/** Identifier generation. Monotonic within a millisecond (see `ids.ts`). */
export interface Ids {
  /** A new ULID: 26 Crockford base32 characters, lexicographically sortable. */
  ulid(): string;
}

/** Cryptographic primitives. Hashing is deterministic; `randomBytes` is not. */
export interface CryptoPort {
  /** Lowercase hex SHA-256 of the given UTF-8 string. */
  sha256(input: string): string;
  /** `n` cryptographically random bytes. */
  randomBytes(n: number): Uint8Array;
}

/** Structured logging. Never `console.log`. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger that stamps `fields` onto everything it writes. */
  child(fields: Record<string, unknown>): Logger;
}

/** A prepared, reusable statement. Mirrors the subset of better-sqlite3 we use. */
export interface Statement {
  run(...params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(...params: readonly unknown[]): T | undefined;
  all<T>(...params: readonly unknown[]): T[];
  iterate<T>(...params: readonly unknown[]): IterableIterator<T>;
}

/**
 * Durable storage. The platform assumes SQLite semantics — in particular that
 * `transaction()` is synchronous and genuinely atomic — because the append
 * path in §15 depends on an event and its projections committing together.
 */
export interface Storage {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** Runs `fn` inside a transaction. Any throw rolls back. Not reentrant-safe across async. */
  transaction<T>(fn: () => T): T;
  /** Current user_version, used by the migration runner. */
  userVersion(): number;
  setUserVersion(version: number): void;
  close(): void;
}

/** Filesystem access for artifacts and attachments. Never `node:fs` directly. */
export interface FileStore {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/**
 * Outbound network. Declared in M0 and deliberately unimplemented: §2 forbids
 * an inference call, and no M0..M6 subsystem has any other reason to leave the
 * machine. It exists so that the one place a future egress could happen is
 * already named, typed, and lint-visible.
 */
export interface Net {
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}

/**
 * The full set of ports. Composition roots take this; nothing else constructs
 * an implementation. §14: the platform is constructible with fakes in under
 * twenty lines, and `test/integration/constructible.test.ts` proves it.
 */
export interface Ports {
  clock: Clock;
  ids: Ids;
  crypto: CryptoPort;
  log: Logger;
  storage: Storage;
}
