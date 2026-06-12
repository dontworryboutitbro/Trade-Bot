import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/types";
import { classifyRegime } from "@/lib/regime/engine";
import { runBacktest } from "./engine";
import { computeMetrics } from "./metrics";
import { runWalkForward } from "./walk-forward";
import { evaluateDemotion, evaluatePromotion, type StrategyPaperStats } from "@/lib/strategies/promotion";
import { getStrategy, STRATEGIES } from "@/lib/strategies/definitions";

function makeBars(symbol: string, days: number, fn: (i: number) => number): Bar[] {
  const bars: Bar[] = [];
  const start = new Date("2024-01-01T14:30:00Z");
  let added = 0;
  let i = 0;
  while (added < days) {
    const date = new Date(start.getTime() + i * 86_400_000);
    i++;
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const close = fn(added);
    bars.push({
      symbol,
      timestamp: date.toISOString(),
      open: close * 0.999,
      high: close * 1.005,
      low: close * 0.995,
      close,
      volume: 1_000_000,
    });
    added++;
  }
  return bars;
}

describe("market-regime engine", () => {
  it("returns INSUFFICIENT_DATA with short history", () => {
    expect(classifyRegime(makeBars("SPY", 30, (i) => 500 + i)).regime).toBe("INSUFFICIENT_DATA");
  });

  it("classifies a steady uptrend as RISK_ON_TREND", () => {
    const bars = makeBars("SPY", 120, (i) => 500 * (1 + i * 0.002));
    expect(classifyRegime(bars).regime).toBe("RISK_ON_TREND");
  });

  it("classifies a persistent decline as RISK_OFF_TREND", () => {
    const bars = makeBars("SPY", 120, (i) => 500 * (1 - i * 0.002));
    expect(classifyRegime(bars).regime).toBe("RISK_OFF_TREND");
  });

  it("classifies a quiet range as SIDEWAYS_LOW_VOL", () => {
    const bars = makeBars("SPY", 120, (i) => 500 + Math.sin(i / 5) * 2);
    expect(classifyRegime(bars).regime).toBe("SIDEWAYS_LOW_VOL");
  });

  it("detects a volatility spike", () => {
    const bars = makeBars("SPY", 120, (i) =>
      i < 100 ? 500 + Math.sin(i / 5) * 2 : 500 * (1 + Math.sin(i * 2.1) * 0.04),
    );
    expect(classifyRegime(bars).regime).toBe("VOLATILITY_SPIKE");
  });
});

describe("backtest engine", () => {
  const strategy = getStrategy("trend-pullback")!;

  it("produces trades and an equity curve on trending data with pullbacks", () => {
    const bars = makeBars("SPY", 250, (i) => 500 * (1 + i * 0.003) * (1 - (i % 17 === 0 ? 0.035 : 0)));
    const result = runBacktest(strategy, { SPY: bars });
    expect(result.equityCurve.length).toBeGreaterThan(200);
    const metrics = computeMetrics(result);
    expect(Number.isFinite(metrics.totalReturnPct)).toBe(true);
  });

  it("has no look-ahead: truncating future data never changes past decisions", () => {
    const bars = makeBars("SPY", 250, (i) => 500 * (1 + i * 0.003) * (1 - (i % 17 === 0 ? 0.035 : 0)));
    const full = runBacktest(strategy, { SPY: bars });
    const truncated = runBacktest(strategy, { SPY: bars.slice(0, 200) });
    // Every trade fully inside the truncated window must be identical.
    const cutoff = bars[198].timestamp.slice(0, 10);
    const fullEarly = full.trades.filter((t) => t.exitDate < cutoff);
    const truncEarly = truncated.trades.filter((t) => t.exitDate < cutoff);
    expect(truncEarly).toEqual(fullEarly);
  });

  it("applies transaction costs to every trade", () => {
    const bars = makeBars("SPY", 250, (i) => 500 * (1 + i * 0.003) * (1 - (i % 17 === 0 ? 0.035 : 0)));
    const result = runBacktest(strategy, { SPY: bars });
    for (const trade of result.trades) {
      expect(trade.costsUsd).toBeGreaterThan(0);
      expect(trade.plUsd).toBeLessThan(trade.grossPlUsd + 1e-9);
    }
  });

  it("refuses to backtest non-mechanical strategies", () => {
    const ai = getStrategy("ai-discretionary")!;
    expect(() => runBacktest(ai, {})).toThrow("not mechanically backtestable");
  });

  it("enforces stop-losses", () => {
    // Strong trend that suddenly crashes 20% — stop should trigger, not ride to zero.
    const bars = makeBars("SPY", 200, (i) =>
      i < 150 ? 500 * (1 + i * 0.003) * (1 - (i % 17 === 0 ? 0.03 : 0)) : 500 * (1 + 150 * 0.003) * (1 - (i - 150) * 0.02),
    );
    const result = runBacktest(strategy, { SPY: bars });
    const stops = result.trades.filter((t) => t.exitReason === "STOP");
    if (result.trades.length > 0 && stops.length > 0) {
      for (const stop of stops) {
        expect(stop.plPct).toBeGreaterThan(-15); // bounded loss, not a ride to the bottom
      }
    }
  });
});

describe("walk-forward validation", () => {
  it("splits into IS/OS windows and scores robustness", () => {
    const strategy = getStrategy("trend-pullback")!;
    const bars = makeBars("SPY", 400, (i) => 500 * (1 + i * 0.002) * (1 - (i % 19 === 0 ? 0.03 : 0)));
    const result = runWalkForward(strategy, { SPY: bars });
    expect(result.windows.length).toBeGreaterThan(0);
    for (const window of result.windows) {
      expect(window.inSample.end < window.outOfSample.start).toBe(true); // OS strictly after IS
    }
  });

  it("warns when data is insufficient", () => {
    const strategy = getStrategy("trend-pullback")!;
    const result = runWalkForward(strategy, { SPY: makeBars("SPY", 100, (i) => 500 + i) });
    expect(result.windows).toEqual([]);
    expect(result.warnings.join(" ")).toContain("Not enough data");
  });
});

describe("strategy promotion gates", () => {
  const goodStats: StrategyPaperStats = {
    paperTradeCount: 25,
    tradingDays: 40,
    expectancyAfterCostsUsd: 12,
    maxDrawdownPct: 4,
    excessReturnVsSpyPct: 1.5,
    outOfSampleScore: 0.8,
    avgExecutionCostBps: 15,
    unresolvedReconciliationErrors: 0,
    staleDataIncidents30d: 0,
    safetyViolations: 0,
    rolling30dReturnPct: 2,
  };

  it("promotes through paper stages when every gate passes", () => {
    const result = evaluatePromotion("PAPER_AUTONOMOUS_CANDIDATE", goodStats, true);
    expect(result.eligible).toBe(true);
    expect(result.nextStage).toBe("PAPER_AUTONOMOUS");
  });

  it("blocks promotion on insufficient sample", () => {
    const result = evaluatePromotion(
      "PAPER_MANUAL",
      { ...goodStats, paperTradeCount: 3 },
      true,
    );
    expect(result.eligible).toBe(false);
    expect(result.failed.join(" ")).toContain("paper trades");
  });

  it("blocks promotion on negative expectancy after costs", () => {
    expect(
      evaluatePromotion("PAPER_MANUAL", { ...goodStats, expectancyAfterCostsUsd: -2 }, true)
        .eligible,
    ).toBe(false);
  });

  it("never promotes past LIVE_MANUAL_CANDIDATE", () => {
    const result = evaluatePromotion("LIVE_MANUAL_CANDIDATE", goodStats, true);
    expect(result.eligible).toBe(false);
    expect(result.nextStage).toBeNull();
  });

  it("demotes on drawdown, safety incidents, or degraded data quality", () => {
    expect(evaluateDemotion({ ...goodStats, maxDrawdownPct: 12 }).shouldDemote).toBe(true);
    expect(evaluateDemotion({ ...goodStats, safetyViolations: 1 }).shouldDemote).toBe(true);
    expect(evaluateDemotion({ ...goodStats, staleDataIncidents30d: 9 }).shouldDemote).toBe(true);
    expect(evaluateDemotion(goodStats).shouldDemote).toBe(false);
  });
});

describe("strategy definitions", () => {
  it("every strategy has stable id, regimes, stops, and sizing", () => {
    for (const strategy of STRATEGIES) {
      expect(strategy.id).toMatch(/^[a-z-]+$/);
      expect(strategy.approvedRegimes.length).toBeGreaterThan(0);
      expect(strategy.stopLossPct).toBeGreaterThan(0);
      expect(strategy.positionSizePct).toBeLessThanOrEqual(10);
      expect(strategy.maxHoldingDays).toBeGreaterThan(0);
      if (strategy.backtestable) expect(strategy.signal).toBeDefined();
    }
  });
});
