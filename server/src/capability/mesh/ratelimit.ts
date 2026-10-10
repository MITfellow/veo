/**
 * A per-peer frame budget.
 *
 * The frame size was capped from the start; the *rate* was not, which left
 * a paired device able to spend this one's CPU freely — every frame costs
 * an AEAD open whether or not its contents turn out to be allowed.
 *
 * A token bucket, refilled from the injected clock rather than a timer, so
 * it is testable by advancing time and holds no `setInterval` that would
 * keep a process alive.
 *
 * **Where the limit is applied is a real trade-off.** It runs on the
 * frame's *claimed* sender, before the seal is opened — which is the only
 * way to make flooding cheap to refuse, and which also means a third party
 * who can write to the socket can spend a legitimate peer's budget and
 * lock it out. The alternative, charging the budget only after a
 * successful open, makes the expensive path the unmetered one and defeats
 * the purpose. A device that can inject frames can already deny service by
 * saturating the socket, so this trades a weaker guarantee for a cheaper
 * refusal rather than giving anything away.
 */

/** Steady state: two frames a second, which is far above conversational use. */
export const REFILL_PER_MINUTE = 120;
/** A burst this size covers a sync of a dozen round-trips without stalling. */
export const BUCKET_CAPACITY = 40;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class FrameBudget {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number,
    private readonly capacity: number = BUCKET_CAPACITY,
    private readonly refillPerMinute: number = REFILL_PER_MINUTE,
  ) {}

  /**
   * Spend one frame's budget. `false` means refuse the frame.
   *
   * Refusal is silent to the caller here: the agent decides what to do,
   * and the answer is to drop rather than reply, because replying is
   * itself work and an attacker would happily take a refusal as a service.
   */
  take(peerId: string): boolean {
    const bucket = this.refilled(peerId);
    if (bucket.tokens < 1) {
      this.buckets.set(peerId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(peerId, bucket);
    return true;
  }

  /**
   * Whole frames currently affordable. For `status`, not for decisions.
   *
   * Refills before reading, like `take` does — a reader that saw the
   * stale count would report a peer as throttled long after it was not.
   */
  remaining(peerId: string): number {
    return Math.floor(this.refilled(peerId).tokens);
  }

  /** Bring a bucket up to date with the clock. Pure bookkeeping. */
  private refilled(peerId: string): Bucket {
    const now = this.now();
    const bucket = this.buckets.get(peerId) ?? { tokens: this.capacity, lastRefill: now };
    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / 60_000) * this.refillPerMinute);
    bucket.lastRefill = now;
    this.buckets.set(peerId, bucket);
    return bucket;
  }

  /** Drop the bucket for a peer that has been forgotten. */
  forget(peerId: string): void {
    this.buckets.delete(peerId);
  }
}
