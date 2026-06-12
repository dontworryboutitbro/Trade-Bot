import { z } from "zod";
import { adminRoute } from "@/lib/api";
import { getMarketDataClient } from "@/lib/brokerage/factory";
import { getStore } from "@/lib/store";
import { getStrategy } from "@/lib/strategies/definitions";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "@/lib/backtest/engine";
import { computeMetrics } from "@/lib/backtest/metrics";
import { runWalkForward } from "@/lib/backtest/walk-forward";
import { audit } from "@/lib/services";
import type { Bar } from "@/lib/types";

export const maxDuration = 120;

export const POST = adminRoute(
  z.object({
    strategyId: z.string().min(1),
    days: z.number().int().min(120).max(1000).default(500),
    costBpsPerSide: z.number().min(0).max(100).default(10),
  }),
  async (body, user) => {
    const strategy = getStrategy(body.strategyId);
    if (!strategy) throw new Error("Unknown strategy.");
    if (!strategy.backtestable || !strategy.signal) {
      throw new Error("This strategy is discretionary and cannot be mechanically backtested.");
    }

    const store = await getStore();
    const settings = await store.getSettings();
    const marketData = getMarketDataClient(settings.tradingMode);
    const approved = await store.getApprovedSymbols();
    const universe =
      strategy.universe === "ALL_ACTIVE_EQUITIES"
        ? approved.filter((s) => s.active && s.assetClass === "us_equity").map((s) => s.symbol)
        : strategy.universe;

    const barsBySymbol: Record<string, Bar[]> = {};
    await Promise.all(
      universe.slice(0, 16).map(async (symbol) => {
        try {
          const bars = await marketData.getDailyBars(symbol, body.days);
          if (bars.length >= 120) barsBySymbol[symbol] = bars;
        } catch {
          // symbol skipped — recorded implicitly by absence
        }
      }),
    );
    if (Object.keys(barsBySymbol).length === 0) {
      throw new Error("No historical data available for this universe.");
    }

    const config = { ...DEFAULT_BACKTEST_CONFIG, costBpsPerSide: body.costBpsPerSide };
    const result = runBacktest(strategy, barsBySymbol, config);
    const spyBenchmark = (barsBySymbol["SPY"] ?? Object.values(barsBySymbol)[0]).map((b) => ({
      date: b.timestamp.slice(0, 10),
      equity: b.close,
    }));
    const metrics = computeMetrics(result, spyBenchmark);
    const walkForward = runWalkForward(strategy, barsBySymbol, config);

    await store.saveBacktestRun({
      strategyId: strategy.id,
      config,
      startDate: result.startDate,
      endDate: result.endDate,
      metrics,
      walkForward: {
        outOfSampleScore: walkForward.outOfSampleScore,
        warnings: walkForward.warnings,
        windows: walkForward.windows.map((w) => ({
          label: w.label,
          inSampleReturnPct: w.inSample.metrics.totalReturnPct,
          outOfSampleReturnPct: w.outOfSample.metrics.totalReturnPct,
        })),
      },
      warnings: [...metrics.warnings, ...walkForward.warnings],
    });
    await audit({
      actorType: "USER",
      actorId: user.email,
      action: "BACKTEST_RUN",
      entityType: "strategy",
      entityId: strategy.id,
      severity: "INFO",
      summary: `${user.email} backtested ${strategy.id} over ${result.startDate}→${result.endDate}: ${metrics.totalReturnPct.toFixed(1)}% (${metrics.tradeCount} trades).`,
      metadata: {},
    });

    return {
      result: {
        strategyId: strategy.id,
        startDate: result.startDate,
        endDate: result.endDate,
        symbolCount: Object.keys(barsBySymbol).length,
        metrics,
        walkForward: {
          outOfSampleScore: walkForward.outOfSampleScore,
          warnings: walkForward.warnings,
          windows: walkForward.windows.map((w) => ({
            label: w.label,
            inSampleReturnPct: w.inSample.metrics.totalReturnPct,
            outOfSampleReturnPct: w.outOfSample.metrics.totalReturnPct,
          })),
        },
        equityCurve: result.equityCurve.filter((_, i) => i % 2 === 0), // thin for transport
      },
    };
  },
);
