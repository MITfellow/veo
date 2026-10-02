/**
 * Every seam in the system, in one file.
 *
 * Kernel code depends on these interfaces and never on an implementation. The
 * rule from §8 is absolute: no `Date.now()`, `Math.random()`, `randomUUID()` or
 * `fetch` anywhere inside `src/` outside the adapters that implement these
 * ports. That is what makes a run reproducible three years later.
 */

/* ────────────────────────────── time & identity ───────────────────────────── */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** IANA zone the principal lives in; scheduling in M8 needs it. */
  timezone(): string;
}

export interface Ids {
  /** ULID: lexicographically sortable, monotonic within a millisecond. */
  ulid(): string;
  /** Opaque random token (device tokens, idempotency salts). */
  token(bytes?: number): string;
}

/* ───────────────────────────────── storage ────────────────────────────────── */

export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlParams = Record<string, SqlValue> | SqlValue[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * A typed SQL executor, not a repository layer (D-002).
 *
 * SQL text lives in the modules that own each table; the port owns execution,
 * parameter binding and transactions. Swapping to Postgres means writing one
 * adapter plus one `Dialect`, not rewriting every caller.
 */
export interface Storage {
  exec(sql: string): void;
  all<T>(sql: string, params?: SqlParams): T[];
  get<T>(sql: string, params?: SqlParams): T | undefined;
  run(sql: string, params?: SqlParams): RunResult;
  /**
   * Synchronous, serialisable transaction. Nested calls join the outer
   * transaction — the event log relies on this so that an append and the
   * projection writes it triggers commit together or not at all.
   */
  transaction<T>(fn: () => T): T;
  /** True while inside `transaction`. */
  inTransaction(): boolean;
  close(): void;
}

/* ─────────────────────────────── hashing/crypto ───────────────────────────── */

/**
 * Split from `Crypto` deliberately: the event chain needs a *synchronous*
 * digest inside a transaction (D-004), while encryption (M1) is async webcrypto.
 */
export interface Hashing {
  sha256Hex(input: string | Uint8Array): string;
}

export interface CryptoPort {
  randomBytes(n: number): Uint8Array;
  /** AEAD encrypt with a raw 32-byte key. Returns nonce||ciphertext||tag. */
  encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>;
  decrypt(key: Uint8Array, payload: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>;
  /** Argon2id in M1; the interface is declared now so wiring does not change. */
  deriveKey(passphrase: string, salt: Uint8Array, iterations?: number): Promise<Uint8Array>;
  hkdf(key: Uint8Array, info: string, length?: number): Promise<Uint8Array>;
}

/* ──────────────────────────────── logging ─────────────────────────────────── */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  correlationId?: string;
  runId?: string;
  stepId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface Logger {
  child(fields: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/* ───────────────────────── model, embedder, files, net ────────────────────── */
/* Declared at M0 so the layering is visible; implemented at M2/M6/M3/M3. */

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  vision: boolean;
  caching: boolean;
  maxContext: number;
  maxOutput: number;
}

export interface ModelProvider {
  id: string;
  capabilities: ModelCapabilities;
  generate(req: unknown, signal: AbortSignal): AsyncIterable<unknown>;
  countTokens(input: unknown): Promise<number>;
}

export interface Embedder {
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface FileStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface NetRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface Net {
  fetch(req: NetRequest): Promise<NetResponse>;
}

/* ─────────────────────────────── the bundle ───────────────────────────────── */

/**
 * Everything the kernel is allowed to reach. Constructing the harness in a test
 * means building one of these from fakes — §8 requires that to fit in 20 lines.
 */
export interface Ports {
  clock: Clock;
  ids: Ids;
  storage: Storage;
  hashing: Hashing;
  logger: Logger;
}
