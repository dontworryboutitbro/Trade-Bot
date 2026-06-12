// Walk-forward validation: split the history into rolling in-sample (IS) /
// out-of-sample (OS) windows, run the same frozen rules on each, and compare.
// A strategy whose OS results collapse relative to IS is likely overfit.

import type { Bar } from "@/lib/types";
import type { Strategy } from "@/lib/strategies/definitions";
import { runBacktest, type BacktestConfig, DEFAULT_BACKTEST_CONFIG } from "./engine";
import { computeMetrics, type BacktestMetrics } from "./metrics";

export interface WalkForwardWindow {
  label: string;
  inSample: { start: string; end: string; metrics: BacktestMetrics };
  outOfSample: { start: string; end: string; metrics: BacktestMetrics };
}

export interface WalkForwardResult {
  strategyId: string;
  windows: WalkForwardWindow[];
  /** Mean OS return ÷ mean IS return (clamped ≥0). >0.5 is acceptable; ~1 is robust. */
  outOfSampleScore: number | null;
  warnings: string[];
}

function sliceBars(
  barsBySymbol: Record<string, Bar[]>,
  startDate: string,
  endDate: string,
  warmupBars = 70,
): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const startIdx = bars.findIndex((b) => b.timestamp.slice(0, 10) >= startDate);
    if (startIdx === -1) continue;
    const from = Math.max(0, startIdx - warmupBars); // history for indicators, trades only inside window
    out[symbol] = bars.filter(
      (b, i) => i >= from && b.timestamp.slice(0, 10) <= endDate,
    );
  }
  return out;
}

export function runWalkForward(
  strategy: Strategy,
  barsBySymbol: Record<string, Bar[]>,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  windowCount = 3,
): WalkForwardResult {
  const allDates = Array.from(
    new Set(
      Object.values(barsBySymbol).flatMap((bars) => bars.map((b) => b.timestamp.slice(0, 10))),
    ),
  ).sort();
  const warnings: string[] = [];
  if (allDates.length < 252) {
    warnings.push("Less than one year of data — walk-forward results are weak evidence.");
  }
  if (allDates.length < 120) {
    return { strategyId: strategy.id, windows: [], outOfSampleScore: null, warnings: [...warnings, "Not enough data for walk-forward splits."] };
  }

  // Each window: IS = 2 segments, OS = 1 segment, rolling forward.
  const segments = windowCount + 2;
  const segLen = Math.floor(allDates.length / segments);
  const windows: WalkForwardWindow[] = [];
  const isReturns: number[] = [];
  const osReturns: number[] = [];

  for (let w = 0; w < windowCount; w++) {
    const isStart = allDates[w * segLen];
    const isEnd = allDates[(w + 2) * segLen - 1];
    const osStart = allDates[(w + 2) * segLen];
    const osEnd = allDates[Math.min((w + 3) * segLen - 1, allDates.length - 1)];

    const isResult = runBacktest(strategy, sliceBars(barsBySymbol, isStart, isEnd), config);
    const osResult = runBacktest(strategy, sliceBars(barsBySymbol, osStart, osEnd), config);
    const isMetrics = computeMetrics(isResult);
    const osMetrics = computeMetrics(osResult);
    isReturns.push(isMetrics.totalReturnPct);
    osReturns.push(osMetrics.totalReturnPct);
    windows.push({
      label: `Window ${w + 1}`,
      inSample: { start: isStart, end: isEnd, metrics: isMetrics },
      outOfSample: { start: osStart, end: osEnd, metrics: osMetrics },
    });
  }

  const meanIs = isReturns.reduce((s, v) => s + v, 0) / isReturns.length;
  const meanOs = osReturns.reduce((s, v) => s + v, 0) / osReturns.length;
  let outOfSampleScore: number | null = null;
  if (meanIs > 0) {
    outOfSampleScore = Math.max(0, meanOs / meanIs);
    if (outOfSampleScore < 0.5) warnings.push("Out-of-sample performance is less than half of in-sample — likely overfit.");
  } else {
    warnings.push("In-sample performance is non-positive; the strategy shows no edge to validate.");
    outOfSampleScore = meanOs > 0 ? 1 : 0;
  }
  if (meanOs <= 0) warnings.push("Out-of-sample windows are unprofitable on average.");

  return { strategyId: strategy.id, windows, outOfSampleScore, warnings };
}
