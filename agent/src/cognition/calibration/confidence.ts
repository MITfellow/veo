/**
 * Confidence that means something (§24.1, L4).
 *
 * > "Confidence is a number with a definition: the expected probability the
 * > fact is still true and correctly attributed."
 *
 * Two words in that sentence do the work. *Expected* makes it a prediction,
 * which makes it scoreable. *And correctly attributed* folds in the thing
 * people forget: a true statement remembered about the wrong person is a
 * wrong memory, so misattribution risk belongs inside the same number
 * rather than in a separate field nobody reads.
 *
 * This file owns the only arithmetic allowed to move a confidence value.
 * Everything else — the extractor, the gate, the API — either passes a
 * number through or calls one of these functions. Confidence literals
 * scattered across the codebase are how you end up with a 0.9 that means
 * "the regex matched", and a test in `calibration-confidence.test.ts`
 * asserts that no module outside this one invents one.
 */

/** Never 1.0: certainty is not available to a system that infers. */
export const CONFIDENCE_CEILING = 0.97;
/** Never 0: a belief at exactly zero should have been forgotten, not kept. */
export const CONFIDENCE_FLOOR = 0.02;

/**
 * How much a single independent confirmation closes the gap to the ceiling.
 *
 * 0.4 means two confirmations take 0.5 → 0.69 → 0.80, which is roughly how
 * a careful person updates on hearing the same thing twice from the same
 * source: more sure, not certain. The curve saturates by construction, so
 * no amount of repetition manufactures certainty — which matters because
 * the most-repeated facts are often the ones the user says out of habit.
 */
export const CONFIRMATION_GAIN = 0.4;

/** A contradiction costs more than a confirmation gains. Asymmetric on purpose. */
export const CONTRADICTION_LOSS = 0.55;

/** Brier score above this, over enough resolutions, is a calibration failure. */
export const BRIER_THRESHOLD = 0.2;

/** Minimum resolutions before the score is reported as meaningful. */
export const MIN_RESOLUTIONS = 20;

function clamp(x: number): number {
  return Math.min(CONFIDENCE_CEILING, Math.max(CONFIDENCE_FLOOR, x));
}

/** An independent observation of the same fact. */
export function confirm(current: number, gain = CONFIRMATION_GAIN): number {
  return clamp(current + (CONFIDENCE_CEILING - current) * gain);
}

/** Something credible disagreed. */
export function contradict(current: number, loss = CONTRADICTION_LOSS): number {
  return clamp(current - (current - CONFIDENCE_FLOOR) * loss);
}

/**
 * Time passing is evidence too.
 *
 * Exponential decay toward the floor with a per-fact half-life (§22.2's
 * stability field supplies it). "Lives in Berlin" has a half-life measured
 * in years; "is working on the Q3 deck" in days. Decay is computed, never
 * stored incrementally, so a fact's confidence does not depend on how often
 * the consolidation job happened to run.
 */
export function decay(current: number, elapsedMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0 || elapsedMs <= 0) return clamp(current);
  const halvings = elapsedMs / halfLifeMs;
  return clamp(CONFIDENCE_FLOOR + (current - CONFIDENCE_FLOOR) * Math.pow(0.5, halvings));
}

/* ──────────────────────────────── scoring ───────────────────────────────── */

export interface Resolution {
  factId: string | null;
  /** What the agent believed, 0..1. */
  predicted: number;
  /** What turned out to be the case. */
  outcome: 0 | 1;
  resolvedAt: number;
  source: 'probe' | 'correction' | 'tool';
}

export interface ReliabilityBucket {
  /** Lower edge of the decile, e.g. 0.7 for the 0.7–0.8 bucket. */
  from: number;
  to: number;
  count: number;
  /** Mean predicted probability in this bucket. */
  predicted: number;
  /** Observed frequency of `outcome === 1`. */
  observed: number;
}

export interface CalibrationReport {
  brier: number;
  resolved: number;
  unresolved: number;
  withinThreshold: boolean;
  /** False when there is not yet enough data to make the claim. */
  meaningful: boolean;
  buckets: ReliabilityBucket[];
  windowFrom: number;
  windowTo: number;
}

/**
 * Mean squared error of the probabilities. Lower is better; 0.25 is what
 * you get by saying 0.5 to everything, which is the number to beat before
 * claiming the agent knows anything about its own reliability.
 */
export function brier(resolutions: readonly Resolution[]): number {
  if (resolutions.length === 0) return 0;
  const total = resolutions.reduce((sum, r) => sum + (r.predicted - r.outcome) ** 2, 0);
  return total / resolutions.length;
}

/**
 * The reliability table: ten buckets, each with its count.
 *
 * The counts are the point. A mean alone hides the case that matters —
 * perfect calibration in the 0.5 bucket and wild overconfidence in the 0.9
 * bucket averages out to something respectable, and the 0.9 bucket is the
 * one the agent speaks from.
 */
export function reliability(resolutions: readonly Resolution[]): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = [];
  for (let i = 0; i < 10; i += 1) {
    const from = i / 10;
    const to = (i + 1) / 10;
    const inBucket = resolutions.filter(
      (r) => r.predicted >= from && (i === 9 ? r.predicted <= to : r.predicted < to),
    );
    buckets.push({
      from,
      to,
      count: inBucket.length,
      predicted:
        inBucket.length === 0
          ? 0
          : inBucket.reduce((s, r) => s + r.predicted, 0) / inBucket.length,
      observed:
        inBucket.length === 0 ? 0 : inBucket.reduce((s, r) => s + r.outcome, 0) / inBucket.length,
    });
  }
  return buckets;
}

export function report(
  resolutions: readonly Resolution[],
  unresolved: number,
  window: { from: number; to: number },
): CalibrationReport {
  const score = brier(resolutions);
  return {
    brier: score,
    resolved: resolutions.length,
    unresolved,
    meaningful: resolutions.length >= MIN_RESOLUTIONS,
    // An unmeaningful sample is not "within threshold" by default; claiming
    // calibration from six data points is the same error the score exists
    // to catch.
    withinThreshold: resolutions.length >= MIN_RESOLUTIONS && score <= BRIER_THRESHOLD,
    buckets: reliability(resolutions),
    windowFrom: window.from,
    windowTo: window.to,
  };
}
