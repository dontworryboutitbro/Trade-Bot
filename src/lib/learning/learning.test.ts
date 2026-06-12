import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/types";
import { computeLabels } from "./labels";
import { bucketFor, calibrationMinConfidence, computeCalibration } from "./calibration";
import {
  generateSystematicVariants,
  nextVersionId,
  validateChallengerParams,
  MAX_NEW_CHALLENGERS_PER_WEEK,
} from "./challengers";
import { evaluateChallengerPromotion, evaluateRollback, type ShadowStats } from "./promotion";
import { stressTestPl } from "./realism";
import { streamFreshnessVerifiable } from "@/lib/streaming/market-stream";
import type { StrategyVersion } from "./types";

function bars(symbol: string, prices: number[]): Bar[] {
  return prices.map((close, i) => ({
    symbol,
    timestamp: new Date(Date.UTC(2026, 0, 5 + i)).toISOString(),
    open: close * 0.999,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
  }));
}

describe("outcome labels", () => {
  const inputs = {
    sourceType: "observation" as const,
    sourceId: "obs-1",
    symbol: "SPY",
    entryAtIso: "2026-01-05T15:00:00Z",
    entryPrice: 100,
    stopLossPct: 5,
    estimatedCostBps: 20,
    barsAfterEntry: bars("SPY", [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]),
    spyClosesAfterEntry: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110],
    now: new Date("2026-02-01T00:00:00Z"),
  };

  it("labels every horizon with returns, costs, MFE/MAE, and SPY-relative results", () => {
    const labels = computeLabels(inputs);
    const h5 = labels.find((l) => l.horizonDays === 5)!;
    expect(h5.returnPct).toBeCloseTo(5, 1);
    expect(h5.returnAfterCostsPct!).toBeLessThan(h5.returnPct!);
    expect(h5.excessReturnPct).toBeCloseTo(0, 1); // identical SPY series
    expect(h5.maxFavorableExcursionPct!).toBeGreaterThan(0);
    expect(h5.maxAdverseExcursionPct!).toBeLessThan(h5.maxFavorableExcursionPct!);
    expect(h5.abstainWasBetter).toBe(false);
    expect(h5.interim).toBe(false);
  });

  it("marks horizons beyond available data as interim", () => {
    const short = computeLabels({ ...inputs, barsAfterEntry: inputs.barsAfterEntry.slice(0, 4) });
    expect(short.find((l) => l.horizonDays === 3)!.interim).toBe(false);
    expect(short.find((l) => l.horizonDays === 10)!.interim).toBe(true);
  });

  it("detects stop triggers from max adverse excursion", () => {
    const crash = computeLabels({
      ...inputs,
      barsAfterEntry: bars("SPY", [100, 96, 92, 95, 97, 99]),
    });
    expect(crash.find((l) => l.horizonDays === 3)!.stopWouldHaveTriggered).toBe(true);
  });

  it("flags abstain-was-better on after-cost losers", () => {
    const losers = computeLabels({
      ...inputs,
      barsAfterEntry: bars("SPY", [100, 99.9, 99.95, 100.0, 100.05, 100.1]),
    });
    expect(losers.find((l) => l.horizonDays === 1)!.abstainWasBetter).toBe(true);
  });
});

describe("confidence calibration", () => {
  it("buckets correctly", () => {
    expect(bucketFor(45)).toBe("0-49");
    expect(bucketFor(65)).toBe("60-69");
    expect(bucketFor(95)).toBe("90-100");
  });

  it("flags overconfidence and raises the autonomous minimum", () => {
    const samples = Array.from({ length: 12 }, () => ({
      confidence: 75,
      executed: true,
      afterCostReturnPct: -0.8,
      excessVsSpyPct: -1,
      abstainWasBetter: true,
    }));
    const buckets = computeCalibration(samples);
    const bucket = buckets.find((b) => b.bucket === "70-79")!;
    expect(bucket.verdict).toBe("OVERCONFIDENT");
    expect(calibrationMinConfidence(buckets)).toBe(80);
  });

  it("reports insufficient data on small samples", () => {
    const buckets = computeCalibration([
      { confidence: 80, executed: true, afterCostReturnPct: 1, excessVsSpyPct: 0, abstainWasBetter: false },
    ]);
    expect(buckets.find((b) => b.bucket === "80-89")!.verdict).toBe("INSUFFICIENT_DATA");
    expect(buckets.find((b) => b.bucket === "80-89")!.lowSample).toBe(true);
  });

  it("the penalty only tightens and is capped", () => {
    const samples = Array.from({ length: 12 }, () => ({
      confidence: 95,
      executed: true,
      afterCostReturnPct: -2,
      excessVsSpyPct: -2,
      abstainWasBetter: true,
    }));
    expect(calibrationMinConfidence(computeCalibration(samples))).toBe(95);
    expect(calibrationMinConfidence([])).toBe(55);
  });
});

describe("challenger generation", () => {
  it("rejects parameters outside hardcoded ranges (AI cannot smuggle values)", () => {
    expect(validateChallengerParams("trend-pullback", { maShort: 500 }).ok).toBe(false);
    expect(validateChallengerParams("trend-pullback", { evilParam: 1 }).ok).toBe(false);
    expect(validateChallengerParams("unknown-strategy", { maShort: 20 }).ok).toBe(false);
    expect(
      validateChallengerParams("trend-pullback", { maShort: 25, stopLossPct: 4 }).ok,
    ).toBe(true);
  });

  it("systematic variants stay inside ranges and are deterministic per seed", () => {
    const champion = { maShort: 20, maLong: 50, pullbackMin: 2, pullbackMax: 6, stopLossPct: 5, maxHoldingDays: 20 };
    const a = generateSystematicVariants("trend-pullback", champion, "2026-06-12", 2);
    const b = generateSystematicVariants("trend-pullback", champion, "2026-06-12", 2);
    expect(a).toEqual(b); // deterministic
    for (const variant of a) {
      expect(validateChallengerParams("trend-pullback", variant).ok).toBe(true);
    }
    expect(MAX_NEW_CHALLENGERS_PER_WEEK).toBeLessThanOrEqual(5);
  });

  it("version ids increment immutably", () => {
    const existing = [
      { familyId: "trend-pullback", versionId: "trend-pullback@1" },
      { familyId: "trend-pullback", versionId: "trend-pullback@3" },
    ] as StrategyVersion[];
    expect(nextVersionId("trend-pullback", existing)).toBe("trend-pullback@4");
  });
});

describe("promotion gates", () => {
  const good: ShadowStats = {
    shadowTradingDays: 35,
    closedShadowTrades: 32,
    stressedExpectancyPct: 0.4,
    outOfSampleScore: 0.7,
    maxDrawdownPct: 4,
    championStressedExpectancyPct: 0.1,
    largestSingleTradeShareOfProfit: 0.3,
    regimeWorstExpectancyPct: 0,
    costSensitivityOk: true,
    unresolvedDataQualityIncidents: 0,
    unresolvedReconciliationIncidents: 0,
    safetyViolations: 0,
  };

  it("passes only when every gate passes, and ALWAYS requires manual approval", () => {
    const result = evaluateChallengerPromotion(good);
    expect(result.eligible).toBe(true);
    expect(result.requiresManualApproval).toBe(true);
  });

  it("blocks on insufficient shadow time, negative expectancy, or one-trade profits", () => {
    expect(evaluateChallengerPromotion({ ...good, shadowTradingDays: 10 }).eligible).toBe(false);
    expect(evaluateChallengerPromotion({ ...good, stressedExpectancyPct: -0.1 }).eligible).toBe(false);
    expect(
      evaluateChallengerPromotion({ ...good, largestSingleTradeShareOfProfit: 0.8 }).eligible,
    ).toBe(false);
    expect(
      evaluateChallengerPromotion({ ...good, championStressedExpectancyPct: 1.0 }).eligible,
    ).toBe(false);
  });

  it("rollback triggers on drawdown, regime exit, calibration decay, and reliance on one trade", () => {
    const healthy = {
      rolling20TradeStressedExpectancyPct: 0.3,
      maxDrawdownPct: 3,
      strategyDrawdownLimitPct: 8,
      excessVsSpy30dPct: 1,
      staleQuoteIncidents7d: 0,
      reconciliationFailures7d: 0,
      calibrationDeterioratingSeverely: false,
      approvedRegimeExpectancyPct: 0.5,
      largestSingleTradeShareOfProfit: 0.2,
      currentRegimeSupported: true,
    };
    expect(evaluateRollback(healthy).shouldRollback).toBe(false);
    expect(evaluateRollback({ ...healthy, maxDrawdownPct: 10 }).shouldRollback).toBe(true);
    expect(evaluateRollback({ ...healthy, currentRegimeSupported: false }).shouldRollback).toBe(true);
    expect(evaluateRollback({ ...healthy, calibrationDeterioratingSeverely: true }).shouldRollback).toBe(true);
    expect(
      evaluateRollback({ ...healthy, rolling20TradeStressedExpectancyPct: -0.2 }).shouldRollback,
    ).toBe(true);
  });
});

describe("paper realism penalties", () => {
  it("stress-tested P/L is always below raw P/L", () => {
    const result = stressTestPl({
      grossPlUsd: 100,
      notionalUsd: 5000,
      dataQualityOk: true,
      lowLiquidity: false,
      volatilitySpikeRegime: false,
    });
    expect(result.stressedPlUsd).toBeLessThan(result.rawPlUsd);
    expect(result.penaltyUsd).toBeGreaterThan(0);
  });

  it("degraded data, low liquidity, and vol spikes increase the penalty", () => {
    const base = { grossPlUsd: 100, notionalUsd: 5000, dataQualityOk: true, lowLiquidity: false, volatilitySpikeRegime: false };
    const clean = stressTestPl(base);
    const dirty = stressTestPl({ ...base, dataQualityOk: false, lowLiquidity: true, volatilitySpikeRegime: true });
    expect(dirty.penaltyUsd).toBeGreaterThan(clean.penaltyUsd);
  });
});

describe("streaming fallback", () => {
  it("REST snapshot alone verifies freshness (stream optional)", () => {
    const health = {
      status: "DISCONNECTED" as const,
      reconnectAttempts: 0,
      lastMessageAt: null,
      lastError: null,
      subscribedSymbols: [],
      usingFallback: true,
    };
    expect(streamFreshnessVerifiable(health, true)).toBe(true);
    expect(streamFreshnessVerifiable(health, false)).toBe(false);
    expect(
      streamFreshnessVerifiable({ ...health, status: "CONNECTED", usingFallback: false }, false),
    ).toBe(true);
  });
});
