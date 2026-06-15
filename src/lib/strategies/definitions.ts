// Typed, interpretable strategy definitions. Signal functions are pure and
// deterministic over daily bars — the same code drives backtests and the
// live evidence packet handed to the AI. The AI never modifies these.

import type { Bar } from "@/lib/types";
import type { MarketRegime } from "@/lib/regime/engine";

export type StrategyStage =
  | "RESEARCH_ONLY"
  | "BACKTEST_ELIGIBLE"
  | "PAPER_MANUAL"
  | "PAPER_AUTONOMOUS_CANDIDATE"
  | "PAPER_AUTONOMOUS"
  | "LIVE_MANUAL_CANDIDATE";

export interface StrategySignal {
  enter: boolean;
  exit: boolean;
  evidenceFor: string[];
  evidenceAgainst: string[];
}

export interface Strategy {
  id: string;
  name: string;
  version: number;
  description: string;
  entryCriteria: string;
  exitCriteria: string;
  /** Symbols this strategy may trade (subset of the global allowlist). */
  universe: string[] | "ALL_ACTIVE_EQUITIES";
  approvedRegimes: MarketRegime[];
  maxHoldingDays: number;
  stopLossPct: number;
  /** Target position size as % of equity. */
  positionSizePct: number;
  /** Mechanical strategies are backtestable; discretionary AI research is not. */
  backtestable: boolean;
  /** Tunable parameters (challenger variants change ONLY these, within hardcoded ranges). */
  params: Record<string, number>;
  /** Pure signal over daily bars (oldest→newest). Needs ≥60 bars. */
  signal?: (bars: Bar[], params?: Record<string, number>) => StrategySignal;
}

/** Immutable variant of a strategy with overridden params (for shadow testing). */
export function withParams(strategy: Strategy, params: Record<string, number>): Strategy {
  const merged = { ...strategy.params, ...params };
  return {
    ...strategy,
    params: merged,
    stopLossPct: merged.stopLossPct ?? strategy.stopLossPct,
    maxHoldingDays: merged.maxHoldingDays ?? strategy.maxHoldingDays,
    signal: strategy.signal ? (bars) => strategy.signal!(bars, merged) : undefined,
  };
}

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function ret(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - n];
  return ((last - prior) / prior) * 100;
}

const trendPullback: Strategy = {
  id: "trend-pullback",
  name: "Trend-Following Pullback",
  version: 1,
  description: "Buy short-term dips inside an established uptrend; exit on trend break or time.",
  entryCriteria: "Close > MA50, MA20 > MA50, and a 2–6% pullback from the 20-day high.",
  exitCriteria: "Close < MA50 (trend break), stop-loss, or max holding period.",
  universe: "ALL_ACTIVE_EQUITIES",
  approvedRegimes: ["RISK_ON_TREND", "SIDEWAYS_LOW_VOL", "SIDEWAYS_HIGH_VOL"],
  maxHoldingDays: 20,
  stopLossPct: 5,
  positionSizePct: 8,
  backtestable: true,
  params: { maShort: 20, maLong: 50, pullbackMin: 2, pullbackMax: 6, stopLossPct: 5, maxHoldingDays: 20 },
  signal(bars, params = trendPullback.params) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const maS = sma(closes, params.maShort);
    const maL = sma(closes, params.maLong);
    const highWin = Math.max(...closes.slice(-params.maShort));
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (maS === null || maL === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    const pullbackPct = ((highWin - close) / highWin) * 100;
    const uptrend = close > maL && maS > maL;
    if (uptrend) evidenceFor.push(`Uptrend intact: close ${close.toFixed(2)} > MA${params.maLong} ${maL.toFixed(2)}.`);
    else evidenceAgainst.push("No aligned uptrend (close vs long MA / short MA vs long MA).");
    if (pullbackPct >= params.pullbackMin && pullbackPct <= params.pullbackMax) evidenceFor.push(`Pullback ${pullbackPct.toFixed(1)}% from recent high is in the ${params.pullbackMin}-${params.pullbackMax}% buy zone.`);
    else evidenceAgainst.push(`Pullback ${pullbackPct.toFixed(1)}% outside the ${params.pullbackMin}-${params.pullbackMax}% zone.`);
    return {
      enter: uptrend && pullbackPct >= params.pullbackMin && pullbackPct <= params.pullbackMax,
      exit: close < maL,
      evidenceFor,
      evidenceAgainst,
    };
  },
};

const relativeMomentum: Strategy = {
  id: "relative-momentum",
  name: "Relative-Strength Momentum",
  version: 1,
  description: "Hold what is outperforming SPY over 3 months; rotate out when leadership fades.",
  entryCriteria: "63-day return > +5% absolute and above MA50; rank among strongest candidates.",
  exitCriteria: "63-day return turns negative, close < MA50, stop, or max holding period.",
  universe: "ALL_ACTIVE_EQUITIES",
  approvedRegimes: ["RISK_ON_TREND", "SIDEWAYS_LOW_VOL"],
  maxHoldingDays: 42,
  stopLossPct: 7,
  positionSizePct: 8,
  backtestable: true,
  params: { lookback: 63, momentumMinPct: 5, maLong: 50, stopLossPct: 7, maxHoldingDays: 42 },
  signal(bars, params = relativeMomentum.params) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const maL = sma(closes, params.maLong);
    const rN = ret(closes, params.lookback);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (maL === null || rN === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (rN > params.momentumMinPct) evidenceFor.push(`${params.lookback}d return ${rN.toFixed(1)}% shows momentum.`);
    else evidenceAgainst.push(`${params.lookback}d return ${rN.toFixed(1)}% below +${params.momentumMinPct}% momentum bar.`);
    if (close > maL) evidenceFor.push(`Price above MA${params.maLong}.`);
    else evidenceAgainst.push(`Price below MA${params.maLong}.`);
    return { enter: rN > params.momentumMinPct && close > maL, exit: rN < 0 || close < maL, evidenceFor, evidenceAgainst };
  },
};

const meanReversion: Strategy = {
  id: "mean-reversion",
  name: "Mean-Reversion Watchlist",
  version: 1,
  description: "Buy sharp short-term oversold moves in liquid ETFs inside non-crashing markets.",
  entryCriteria: "5-day return < -4% while still above MA200-proxy (MA50 here) support zone.",
  exitCriteria: "5-day return recovers above 0%, stop, or max holding period.",
  universe: ["SPY", "QQQ", "IWM", "DIA", "VTI", "XLK", "XLF", "XLV", "XLE"],
  approvedRegimes: ["SIDEWAYS_LOW_VOL", "SIDEWAYS_HIGH_VOL"],
  maxHoldingDays: 10,
  stopLossPct: 4,
  positionSizePct: 6,
  backtestable: true,
  params: { window: 5, oversoldPct: -4, supportBufferPct: 7, stopLossPct: 4, maxHoldingDays: 10 },
  signal(bars, params = meanReversion.params) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma50 = sma(closes, 50);
    const rW = ret(closes, params.window);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (ma50 === null || rW === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (rW < params.oversoldPct) evidenceFor.push(`${params.window}-day move ${rW.toFixed(1)}% is oversold (<${params.oversoldPct}%).`);
    else evidenceAgainst.push(`${params.window}-day move ${rW.toFixed(1)}% not oversold.`);
    const support = ma50 * (1 - params.supportBufferPct / 100);
    if (close > support) evidenceFor.push(`Holding above deep support (${params.supportBufferPct}% under MA50).`);
    else evidenceAgainst.push("Broken far below MA50 — falling knife risk.");
    return { enter: rW < params.oversoldPct && close > support, exit: rW !== null && rW > 0, evidenceFor, evidenceAgainst };
  },
};

const defensiveRotation: Strategy = {
  id: "defensive-rotation",
  name: "Defensive Risk-Off Rotation",
  version: 1,
  description: "In risk-off regimes, rotate toward defensive sectors (staples, utilities, healthcare).",
  entryCriteria: "Active regime is RISK_OFF_TREND or VOLATILITY_SPIKE and the defensive ETF is above its MA20.",
  exitCriteria: "Regime returns to RISK_ON_TREND, close < MA20, stop, or max holding period.",
  universe: ["XLP", "XLU", "XLV", "SCHD"],
  approvedRegimes: ["RISK_OFF_TREND", "VOLATILITY_SPIKE", "SIDEWAYS_HIGH_VOL"],
  maxHoldingDays: 30,
  stopLossPct: 5,
  positionSizePct: 8,
  backtestable: true,
  params: { ma: 20, stopLossPct: 5, maxHoldingDays: 30 },
  signal(bars, params = defensiveRotation.params) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const maV = sma(closes, params.ma);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (maV === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (close > maV) evidenceFor.push(`Defensive name holding above MA${params.ma} while the market is risk-off.`);
    else evidenceAgainst.push(`Below MA${params.ma} — defensives not attracting flows.`);
    return { enter: close > maV, exit: close < maV, evidenceFor, evidenceAgainst };
  },
};

const aiDiscretionary: Strategy = {
  id: "ai-discretionary",
  name: "AI-Assisted Discretionary Research",
  version: 1,
  description:
    "Claude weighs the full research packet (regime, momentum, volatility, costs) and may propose trades the mechanical screens miss. Not mechanically backtestable; judged purely on paper results.",
  entryCriteria: "AI thesis with confidence ≥60, supported by packet evidence, inside all risk limits.",
  exitCriteria: "AI invalidation condition, stop-loss, or max holding period.",
  universe: "ALL_ACTIVE_EQUITIES",
  approvedRegimes: ["RISK_ON_TREND", "SIDEWAYS_LOW_VOL", "SIDEWAYS_HIGH_VOL", "RISK_OFF_TREND"],
  maxHoldingDays: 30,
  stopLossPct: 5,
  positionSizePct: 6,
  backtestable: false,
  params: { minConfidence: 60, stopLossPct: 5, maxHoldingDays: 30 },
};

export const STRATEGIES: Strategy[] = [
  trendPullback,
  relativeMomentum,
  meanReversion,
  defensiveRotation,
  aiDiscretionary,
];

export function getStrategy(id: string): Strategy | null {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}
