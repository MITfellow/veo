/**
 * Token counting, and the one optimisation that makes §33's 100ms bar
 * reachable without giving up purity (L4).
 *
 * A 200-turn session assembled 200 times counts the same 199 strings 200
 * times. The fix is a memo keyed by **content**, not by position — but a
 * module-level cache would make assembly stateful, and a pure function is the
 * whole point of §21. So the cache is an *argument*: callers thread one
 * through, and `assembleContext` produces byte-identical output with a cold
 * cache, a warm cache, or no cache at all. There is a test for exactly that.
 */

/** Characters per token. Stable, not exact — decision 014. */
const CHARS_PER_TOKEN = 4;

export type TokenCounter = (text: string) => number;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A content-keyed memo for token counts.
 *
 * Bounded, because an unbounded cache in a process meant to run for ten years
 * is a leak with a long fuse. Eviction is insertion-ordered and wholesale: at
 * the limit the oldest half goes. A cache miss costs a `length` read, so a
 * cheap, predictable policy beats a clever one.
 */
export class TokenCache {
  private readonly memo = new Map<string, number>();

  constructor(
    private readonly counter: TokenCounter = estimateTokens,
    private readonly limit = 20_000,
  ) {}

  count(text: string): number {
    const hit = this.memo.get(text);
    if (hit !== undefined) return hit;

    const value = this.counter(text);
    if (this.memo.size >= this.limit) {
      let drop = Math.floor(this.limit / 2);
      for (const key of this.memo.keys()) {
        if (drop-- <= 0) break;
        this.memo.delete(key);
      }
    }
    this.memo.set(text, value);
    return value;
  }

  /** Exposed for the perf test, which asserts the cache is actually used. */
  get size(): number {
    return this.memo.size;
  }

  clear(): void {
    this.memo.clear();
  }
}

/**
 * A stable, synchronous content digest (FNV-1a, 64-bit, hex).
 *
 * **Not** cryptographic, and deliberately not `Hashing.sha256Hex`: that port
 * is async, and `assembleContext` is a pure synchronous function by §21. The
 * digest exists to answer "is this the same context as that one?" in a trace
 * months later — a collision costs a confusing debugging session, not a
 * security property. Anywhere a digest is load-bearing (the event chain,
 * the outbox key) still uses sha256 through the port.
 */
export function digestOf(parts: readonly string[]): string {
  let hi = 0x811c9dc5;
  let lo = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      hi = Math.imul(hi ^ code, 0x01000193) >>> 0;
      lo = Math.imul(lo ^ (code + i), 0x01000193) >>> 0;
    }
    hi = Math.imul(hi ^ 0x1f, 0x01000193) >>> 0;
    lo = Math.imul(lo ^ 0x2f, 0x01000193) >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}
