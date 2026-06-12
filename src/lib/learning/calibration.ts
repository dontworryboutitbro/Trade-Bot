// Confidence calibration — does a Claude confidence number predict anything?
// Pure functions; the penalty is deterministic and can only TIGHTEN behavior.

import type { CalibrationBucket } from "./types";

export const BUCKETS = ["0-49", "50-59", "60-69", "70-79", "80-89", "90-100"] as const;

export function bucketFor(confidence: number): string {
  if (confidence < 50) return "0-49";
  if (confidence < 60) return "50-59";
  if (confidence < 70) return "60-69";
  if (confidence < 80) return "70-79";
  if (confidence < 90) return "80-89";
  return "90-100";
}

export interface CalibrationSample {
  confidence: number;
  executed: boolean;
  afterCostReturnPct: number | null; // from the 5-day label (or exit)
  excessVsSpyPct: number | null;
  abstainWasBetter: boolean | null;
}

const MIN_SAMPLE = 8;

export function computeCalibration(samples: CalibrationSample[]): CalibrationBucket[] {
  return BUCKETS.map((bucket) => {
    const inBucket = samples.filter((s) => bucketFor(s.confidence) === bucket);
    const labeled = inBucket.filter((s) => s.afterCostReturnPct !== null);
    const returns = labeled.map((s) => s.afterCostReturnPct!) .sort((a, b) => a - b);
    const wins = labeled.filter((s) => s.afterCostReturnPct! > 0).length;
    const lowSample = labeled.length < MIN_SAMPLE;
    const avg = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : null;

    let verdict: CalibrationBucket["verdict"] = "INSUFFICIENT_DATA";
    if (!lowSample && avg !== null) {
      const bucketFloor = bucket === "0-49" ? 0 : Number(bucket.split("-")[0]);
      // High-confidence buckets that lose money = overconfidence; low buckets
      // that win consistently = underconfidence.
      if (bucketFloor >= 70 && avg <= 0) verdict = "OVERCONFIDENT";
      else if (bucketFloor < 60 && avg > 0.5) verdict = "UNDERCONFIDENT";
      else verdict = "RELIABLE";
    }

    return {
      bucket,
      proposalCount: inBucket.length,
      executedCount: inBucket.filter((s) => s.executed).length,
      winRatePct: labeled.length ? (wins / labeled.length) * 100 : null,
      avgAfterCostReturnPct: avg,
      medianAfterCostReturnPct: returns.length ? returns[Math.floor(returns.length / 2)] : null,
      expectancyPct: avg,
      excessVsSpyPct: labeled.some((s) => s.excessVsSpyPct !== null)
        ? labeled.reduce((s, v) => s + (v.excessVsSpyPct ?? 0), 0) / labeled.length
        : null,
      abstainBetterPct: labeled.length
        ? (labeled.filter((s) => s.abstainWasBetter === true).length / labeled.length) * 100
        : null,
      lowSample,
      verdict,
    };
  });
}

/**
 * Deterministic calibration penalty: when a confidence bucket has proven
 * unreliable, autonomous execution requires MORE confidence than the AI
 * claims. The penalty can never loosen anything and never overrides the
 * risk engine — it is one additional deterministic gate.
 */
export function calibrationMinConfidence(
  buckets: CalibrationBucket[],
  baseline = 55,
): number {
  let min = baseline;
  for (const bucket of buckets) {
    if (bucket.verdict === "OVERCONFIDENT") {
      const ceiling = bucket.bucket === "90-100" ? 100 : Number(bucket.bucket.split("-")[1]);
      // Require confidence above any bucket proven overconfident.
      min = Math.max(min, ceiling + 1);
    }
  }
  return Math.min(min, 95); // never demand the impossible; 95 cap keeps EXITs reviewable
}
