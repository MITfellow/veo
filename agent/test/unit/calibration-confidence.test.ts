/**
 * Tests 25–30: confidence and Brier (§24.1).
 *
 * §24.1: "An uncalibrated confidence number is a lie with a decimal point."
 * These tests are the audit of that claim — they check the update rule
 * cannot manufacture certainty, and that the score refuses to be computed
 * over things that never resolved.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIER_THRESHOLD,
  CONFIDENCE_CEILING,
  CONFIDENCE_FLOOR,
  MIN_RESOLUTIONS,
  brier,
  confirm,
  contradict,
  decay,
  reliability,
  report,
  type Resolution,
} from '../../src/cognition/calibration/confidence.js';

const res = (predicted: number, outcome: 0 | 1): Resolution => ({
  factId: null,
  predicted,
  outcome,
  resolvedAt: 0,
  source: 'probe',
});

describe('the update rule', () => {
  it('25. confirmations raise confidence on a curve that saturates', () => {
    const once = confirm(0.5);
    const twice = confirm(once);
    expect(once).toBeGreaterThan(0.5);
    expect(twice).toBeGreaterThan(once);
    expect(twice - once).toBeLessThan(once - 0.5);

    // Twenty repetitions of the same claim must not become certainty: the
    // most-repeated facts are often the ones said out of habit.
    let v = 0.5;
    for (let i = 0; i < 20; i += 1) v = confirm(v);
    expect(v).toBeLessThanOrEqual(CONFIDENCE_CEILING);
    expect(v).toBeLessThan(1);
  });

  it('26. a contradiction cuts harder than a confirmation lifts, and never goes below the floor', () => {
    const up = confirm(0.5) - 0.5;
    const down = 0.5 - contradict(0.5);
    expect(down).toBeGreaterThan(up);

    let v = 0.9;
    for (let i = 0; i < 20; i += 1) v = contradict(v);
    expect(v).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  it('27. one half-life halves the distance to the floor, deterministically', () => {
    const half = 30 * 86_400_000;
    const after = decay(0.82, half, half);
    expect(after).toBeCloseTo(CONFIDENCE_FLOOR + (0.82 - CONFIDENCE_FLOOR) / 2, 6);
    // Same inputs, same answer — decay is computed, never accumulated, so a
    // fact's confidence does not depend on how often the job ran.
    expect(decay(0.82, half, half)).toBe(after);
    expect(decay(0.82, 0, half)).toBeCloseTo(0.82, 6);
  });
});

describe('scoring', () => {
  it('28. Brier is 0 when perfect, 1 when maximally wrong, 0.25 for all-0.5', () => {
    expect(brier([res(1, 1), res(0, 0)])).toBe(0);
    expect(brier([res(1, 0), res(0, 1)])).toBe(1);
    expect(brier([res(0.5, 1), res(0.5, 0)])).toBe(0.25);
  });

  it('29. the reliability table buckets by tenths and reports counts', () => {
    const buckets = reliability([res(0.95, 1), res(0.92, 0), res(0.1, 0)]);
    expect(buckets).toHaveLength(10);
    const top = buckets[9]!;
    expect(top.count).toBe(2);
    expect(top.observed).toBe(0.5);
    // Counts, not just means: perfect calibration in the 0.5 bucket hides
    // overconfidence in the 0.9 bucket, and the 0.9 bucket is the one the
    // agent speaks from.
    expect(buckets[1]!.count).toBe(1); // 0.1 sits at the bottom edge of the 0.1-0.2 bucket
    expect(buckets[5]!.count).toBe(0);
  });

  it('30. the score refuses to mean anything until enough has resolved', () => {
    const few = report([res(0.9, 1), res(0.8, 1)], 17, { from: 0, to: 1 });
    expect(few.resolved).toBe(2);
    expect(few.unresolved).toBe(17);
    expect(few.meaningful).toBe(false);
    // Six good calls is not calibration, and saying "within threshold" from
    // six is the error the score exists to catch.
    expect(few.withinThreshold).toBe(false);

    const many = report(
      Array.from({ length: MIN_RESOLUTIONS }, () => res(0.9, 1)),
      0,
      { from: 0, to: 1 },
    );
    expect(many.meaningful).toBe(true);
    expect(many.brier).toBeLessThan(BRIER_THRESHOLD);
    expect(many.withinThreshold).toBe(true);
  });
});
