// Backtest performance metrics + honesty warnings. Pure functions.

import type { BacktestResult } from "./engine";

export interface BacktestMetrics {
  totalReturnPct: number;
  annualizedReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  maxDrawdownPct: number;
  volatilityPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  winRatePct: number;
  lossRatePct: number;
  avgGainUsd: number;
  avgLossUsd: number;
  profitFactor: number | null;
  expectancyUsd: number;
  avgHoldingDays: number;
  turnover: number;
  totalCostsUsd: number;
  tradeCount: number;
  worstDayPct: number | null;
  bestDayPct: number | null;
  grossReturnPct: number;
  warnings: string[];
}

function dailyReturns(curve: { equity: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    out.push(curve[i].equity / curve[i - 1].equity - 1);
  }
  return out;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

export function computeMetrics(
  result: BacktestResult,
  benchmarkCurve?: { date: string; equity: number }[],
): BacktestMetrics {
  const { trades, equityCurve, config } = result;
  const start = config.startingEquity;
  const end = result.finalEquity;
  const totalReturnPct = ((end - start) / start) * 100;

  const days = equityCurve.length;
  const years = days / 252;
  const annualizedReturnPct =
    years > 0.2 ? (Math.pow(end / start, 1 / years) - 1) * 100 : null;

  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
  }

  const rets = dailyReturns(equityCurve);
  const vol = stdev(rets);
  const meanRet = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const downside = stdev(rets.filter((r) => r < 0));
  const sharpe = vol > 0 ? (meanRet / vol) * Math.sqrt(252) : null;
  const sortino = downside > 0 ? (meanRet / downside) * Math.sqrt(252) : null;

  const wins = trades.filter((t) => t.plUsd > 0);
  const losses = trades.filter((t) => t.plUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.plUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.plUsd, 0));
  const totalCostsUsd = trades.reduce((s, t) => s + t.costsUsd, 0);
  const grossPl = trades.reduce((s, t) => s + t.grossPlUsd, 0);

  let benchmarkReturnPct: number | null = null;
  if (benchmarkCurve && benchmarkCurve.length >= 2) {
    benchmarkReturnPct =
      ((benchmarkCurve[benchmarkCurve.length - 1].equity - benchmarkCurve[0].equity) /
        benchmarkCurve[0].equity) *
      100;
  }

  const warnings: string[] = [];
  if (trades.length < 20) warnings.push(`Small sample: only ${trades.length} trades — results are not statistically meaningful.`);
  const biggest = trades.reduce((max, t) => Math.max(max, t.plUsd), 0);
  const netPl = end - start;
  if (netPl > 0 && biggest > netPl * 0.5) warnings.push("More than half the profit comes from a single trade.");
  if (grossPl > 0 && totalCostsUsd > grossPl * 0.5) warnings.push("Estimated costs consume over half the gross edge.");
  if (netPl > 0 && grossPl > 0 && netPl / start < 0.3 * (grossPl / start)) warnings.push("Net return is far below gross return — the edge may not survive real execution.");
  if (maxDrawdownPct > 8) warnings.push(`Max drawdown ${maxDrawdownPct.toFixed(1)}% exceeds the 8% portfolio limit.`);
  if (benchmarkReturnPct !== null && totalReturnPct < benchmarkReturnPct) warnings.push("Strategy underperformed simply holding SPY over this window.");
  // Recent-window deterioration: last quarter of the curve vs the rest.
  if (equityCurve.length > 80) {
    const q = Math.floor(equityCurve.length * 0.75);
    const earlier = equityCurve[q].equity / equityCurve[0].equity - 1;
    const recent = equityCurve[equityCurve.length - 1].equity / equityCurve[q].equity - 1;
    if (earlier > 0 && recent < -0.02) warnings.push("Performance deteriorates in the most recent window.");
  }

  return {
    totalReturnPct,
    annualizedReturnPct,
    benchmarkReturnPct,
    excessReturnPct: benchmarkReturnPct === null ? null : totalReturnPct - benchmarkReturnPct,
    maxDrawdownPct,
    volatilityPct: rets.length ? vol * Math.sqrt(252) * 100 : null,
    sharpe,
    sortino,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    lossRatePct: trades.length ? (losses.length / trades.length) * 100 : 0,
    avgGainUsd: wins.length ? grossWin / wins.length : 0,
    avgLossUsd: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyUsd: trades.length ? (grossWin - grossLoss) / trades.length : 0,
    avgHoldingDays: trades.length
      ? trades.reduce((s, t) => s + t.holdingDays, 0) / trades.length
      : 0,
    turnover: start > 0 ? trades.reduce((s, t) => s + t.entryPrice * t.quantity, 0) / start : 0,
    totalCostsUsd,
    tradeCount: trades.length,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : null,
    bestDayPct: rets.length ? Math.max(...rets) * 100 : null,
    grossReturnPct: (grossPl / start) * 100,
    warnings,
  };
}
