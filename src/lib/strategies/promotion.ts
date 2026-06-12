// Deterministic strategy promotion/demotion gates. No automatic promotion to
// any live stage — LIVE_MANUAL_CANDIDATE is the ceiling and it still requires
// manual acknowledgment plus the app's live activation ceremonies.

import type { StrategyStage } from "./definitions";

export interface StrategyPaperStats {
  paperTradeCount: number;
  tradingDays: number;
  expectancyAfterCostsUsd: number; // avg P/L per trade after estimated costs
  maxDrawdownPct: number;
  excessReturnVsSpyPct: number;
  outOfSampleScore: number | null; // backtest OS/IS performance ratio, null = N/A
  avgExecutionCostBps: number | null;
  unresolvedReconciliationErrors: number;
  staleDataIncidents30d: number;
  safetyViolations: number;
  rolling30dReturnPct: number | null;
}

export interface PromotionThresholds {
  minPaperTrades: number;
  minTradingDays: number;
  maxDrawdownPct: number;
  minExcessVsSpyPct: number;
  minOutOfSampleScore: number;
  maxAvgExecutionCostBps: number;
  maxStaleDataIncidents: number;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minPaperTrades: 20,
  minTradingDays: 30,
  maxDrawdownPct: 8,
  minExcessVsSpyPct: -1, // must roughly keep pace with SPY at minimum
  minOutOfSampleScore: 0.5, // OS performance at least half of IS
  maxAvgExecutionCostBps: 40,
  maxStaleDataIncidents: 3,
};

export const STAGE_ORDER: StrategyStage[] = [
  "RESEARCH_ONLY",
  "BACKTEST_ELIGIBLE",
  "PAPER_MANUAL",
  "PAPER_AUTONOMOUS_CANDIDATE",
  "PAPER_AUTONOMOUS",
  "LIVE_MANUAL_CANDIDATE",
];

export interface GateResult {
  eligible: boolean;
  nextStage: StrategyStage | null;
  passed: string[];
  failed: string[];
}

/** Evaluate whether a strategy meets the deterministic gates for its next stage. */
export function evaluatePromotion(
  currentStage: StrategyStage,
  stats: StrategyPaperStats,
  backtestable: boolean,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): GateResult {
  const index = STAGE_ORDER.indexOf(currentStage);
  const nextStage = STAGE_ORDER[index + 1] ?? null;
  if (!nextStage) return { eligible: false, nextStage: null, passed: [], failed: ["Already at the highest stage."] };

  const passed: string[] = [];
  const failed: string[] = [];
  const gate = (ok: boolean, label: string) => (ok ? passed.push(label) : failed.push(label));

  // Universal safety gates for every promotion.
  gate(stats.safetyViolations === 0, "No safety violations");
  gate(stats.unresolvedReconciliationErrors === 0, "No unresolved reconciliation errors");
  gate(
    stats.staleDataIncidents30d <= thresholds.maxStaleDataIncidents,
    `≤${thresholds.maxStaleDataIncidents} stale-data incidents in 30d`,
  );

  if (nextStage === "BACKTEST_ELIGIBLE") {
    gate(backtestable, "Strategy has a mechanical, backtestable rule set");
  }
  if (nextStage === "PAPER_MANUAL") {
    if (backtestable) {
      gate(
        stats.outOfSampleScore !== null && stats.outOfSampleScore >= thresholds.minOutOfSampleScore,
        `Out-of-sample score ≥ ${thresholds.minOutOfSampleScore}`,
      );
    } else {
      passed.push("Discretionary strategy: backtest gate not applicable");
    }
  }
  if (nextStage === "PAPER_AUTONOMOUS_CANDIDATE" || nextStage === "PAPER_AUTONOMOUS") {
    gate(stats.paperTradeCount >= thresholds.minPaperTrades, `≥${thresholds.minPaperTrades} paper trades`);
    gate(stats.tradingDays >= thresholds.minTradingDays, `≥${thresholds.minTradingDays} trading days`);
    gate(stats.expectancyAfterCostsUsd > 0, "Positive expectancy after estimated costs");
    gate(stats.maxDrawdownPct <= thresholds.maxDrawdownPct, `Drawdown ≤ ${thresholds.maxDrawdownPct}%`);
    gate(
      stats.excessReturnVsSpyPct >= thresholds.minExcessVsSpyPct,
      `Benchmark-relative return ≥ ${thresholds.minExcessVsSpyPct}%`,
    );
    gate(
      stats.avgExecutionCostBps === null || stats.avgExecutionCostBps <= thresholds.maxAvgExecutionCostBps,
      `Avg execution cost ≤ ${thresholds.maxAvgExecutionCostBps} bps`,
    );
  }
  if (nextStage === "LIVE_MANUAL_CANDIDATE") {
    // Stricter: double the sample, and unambiguous outperformance.
    gate(stats.paperTradeCount >= thresholds.minPaperTrades * 2, `≥${thresholds.minPaperTrades * 2} paper trades`);
    gate(stats.tradingDays >= thresholds.minTradingDays * 2, `≥${thresholds.minTradingDays * 2} trading days`);
    gate(stats.expectancyAfterCostsUsd > 0, "Positive expectancy after costs");
    gate(stats.excessReturnVsSpyPct > 0, "Outperforming SPY");
    gate(stats.maxDrawdownPct <= thresholds.maxDrawdownPct, `Drawdown ≤ ${thresholds.maxDrawdownPct}%`);
  }

  return { eligible: failed.length === 0, nextStage, passed, failed };
}

export interface DemotionResult {
  shouldDemote: boolean;
  reasons: string[];
}

/** Automatic demotion triggers. Checked on every journal/snapshot update. */
export function evaluateDemotion(
  stats: StrategyPaperStats,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS,
): DemotionResult {
  const reasons: string[] = [];
  if (stats.maxDrawdownPct > thresholds.maxDrawdownPct) {
    reasons.push(`Drawdown ${stats.maxDrawdownPct.toFixed(1)}% exceeds ${thresholds.maxDrawdownPct}%.`);
  }
  if (stats.rolling30dReturnPct !== null && stats.rolling30dReturnPct < -5) {
    reasons.push(`Rolling 30-day return ${stats.rolling30dReturnPct.toFixed(1)}% breaches -5%.`);
  }
  if (stats.staleDataIncidents30d > thresholds.maxStaleDataIncidents) {
    reasons.push("Repeated stale-data incidents degrade data quality.");
  }
  if (
    stats.avgExecutionCostBps !== null &&
    stats.avgExecutionCostBps > thresholds.maxAvgExecutionCostBps * 1.5
  ) {
    reasons.push("Execution quality degraded (costs far above plan).");
  }
  if (stats.safetyViolations > 0) reasons.push("Safety incident recorded.");
  if (stats.unresolvedReconciliationErrors > 0) reasons.push("Unresolved reconciliation errors.");
  return { shouldDemote: reasons.length > 0, reasons };
}
