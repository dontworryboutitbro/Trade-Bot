// Champion/challenger promotion gates + automatic rollback. Deterministic.
// A challenger can replace a paper champion ONLY after every gate passes AND
// the owner manually approves. Nothing here can touch live modes — live
// activation remains exclusively behind the existing ceremonies.

export interface ShadowStats {
  shadowTradingDays: number;
  closedShadowTrades: number;
  stressedExpectancyPct: number | null; // after realism penalties
  outOfSampleScore: number | null;
  maxDrawdownPct: number | null;
  championStressedExpectancyPct: number | null;
  largestSingleTradeShareOfProfit: number | null; // 0..1
  regimeWorstExpectancyPct: number | null;
  costSensitivityOk: boolean;
  unresolvedDataQualityIncidents: number;
  unresolvedReconciliationIncidents: number;
  safetyViolations: number;
}

export interface ChallengerGateResult {
  eligible: boolean;
  passed: string[];
  failed: string[];
  requiresManualApproval: true; // structurally always true
}

export function evaluateChallengerPromotion(stats: ShadowStats): ChallengerGateResult {
  const passed: string[] = [];
  const failed: string[] = [];
  const gate = (ok: boolean, label: string) => (ok ? passed.push(label) : failed.push(label));

  gate(stats.shadowTradingDays >= 30, "≥30 trading days in shadow mode");
  gate(stats.closedShadowTrades >= 30, "≥30 closed shadow trades");
  gate(
    stats.stressedExpectancyPct !== null && stats.stressedExpectancyPct > 0,
    "Positive stress-tested expectancy",
  );
  gate(
    stats.outOfSampleScore !== null && stats.outOfSampleScore >= 0.5,
    "Out-of-sample score ≥ 0.5",
  );
  gate(
    stats.maxDrawdownPct !== null && stats.maxDrawdownPct <= 8,
    "Max drawdown ≤ 8%",
  );
  gate(
    stats.stressedExpectancyPct !== null &&
      stats.championStressedExpectancyPct !== null &&
      stats.stressedExpectancyPct > stats.championStressedExpectancyPct,
    "Beats the current champion after realism penalties",
  );
  gate(
    stats.largestSingleTradeShareOfProfit === null ||
      stats.largestSingleTradeShareOfProfit <= 0.5,
    "No single trade explains most profits",
  );
  gate(
    stats.regimeWorstExpectancyPct === null || stats.regimeWorstExpectancyPct > -2,
    "No severe regime fragility",
  );
  gate(stats.costSensitivityOk, "Survives cost/slippage sensitivity");
  gate(stats.unresolvedDataQualityIncidents === 0, "No unresolved data-quality incidents");
  gate(stats.unresolvedReconciliationIncidents === 0, "No unresolved reconciliation incidents");
  gate(stats.safetyViolations === 0, "No safety violations");

  return { eligible: failed.length === 0, passed, failed, requiresManualApproval: true };
}

export interface ChampionHealth {
  rolling20TradeStressedExpectancyPct: number | null;
  maxDrawdownPct: number | null;
  strategyDrawdownLimitPct: number;
  excessVsSpy30dPct: number | null;
  staleQuoteIncidents7d: number;
  reconciliationFailures7d: number;
  calibrationDeterioratingSeverely: boolean;
  approvedRegimeExpectancyPct: number | null;
  largestSingleTradeShareOfProfit: number | null;
  currentRegimeSupported: boolean;
}

export interface RollbackDecision {
  shouldRollback: boolean;
  reasons: string[];
}

export function evaluateRollback(health: ChampionHealth): RollbackDecision {
  const reasons: string[] = [];
  if (
    health.rolling20TradeStressedExpectancyPct !== null &&
    health.rolling20TradeStressedExpectancyPct < 0
  ) {
    reasons.push("Rolling stress-tested expectancy is negative.");
  }
  if (
    health.maxDrawdownPct !== null &&
    health.maxDrawdownPct > health.strategyDrawdownLimitPct
  ) {
    reasons.push(
      `Drawdown ${health.maxDrawdownPct.toFixed(1)}% breaches the ${health.strategyDrawdownLimitPct}% strategy limit.`,
    );
  }
  if (health.excessVsSpy30dPct !== null && health.excessVsSpy30dPct < -5) {
    reasons.push("Benchmark-relative performance deteriorated materially (<-5% vs SPY over 30d).");
  }
  if (health.staleQuoteIncidents7d >= 5) reasons.push("Repeated stale-quote incidents (data unreliable).");
  if (health.reconciliationFailures7d >= 3) reasons.push("Repeated reconciliation failures.");
  if (health.calibrationDeterioratingSeverely) reasons.push("Confidence calibration degraded materially.");
  if (
    health.approvedRegimeExpectancyPct !== null &&
    health.approvedRegimeExpectancyPct < -1
  ) {
    reasons.push("Performance collapsed inside the strategy's approved regime.");
  }
  if (
    health.largestSingleTradeShareOfProfit !== null &&
    health.largestSingleTradeShareOfProfit > 0.7
  ) {
    reasons.push("Profits rely on a single trade.");
  }
  if (!health.currentRegimeSupported) {
    reasons.push("Market conditions are outside the strategy's supported regimes.");
  }
  return { shouldRollback: reasons.length > 0, reasons };
}
