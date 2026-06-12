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
  /** Pure signal over daily bars (oldest→newest). Needs ≥60 bars. */
  signal?: (bars: Bar[]) => StrategySignal;
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
  approvedRegimes: ["RISK_ON_TREND", "SIDEWAYS_LOW_VOL"],
  maxHoldingDays: 20,
  stopLossPct: 5,
  positionSizePct: 8,
  backtestable: true,
  signal(bars) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const high20 = Math.max(...closes.slice(-20));
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (ma20 === null || ma50 === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    const pullbackPct = ((high20 - close) / high20) * 100;
    const uptrend = close > ma50 && ma20 > ma50;
    if (uptrend) evidenceFor.push(`Uptrend intact: close ${close.toFixed(2)} > MA50 ${ma50.toFixed(2)}.`);
    else evidenceAgainst.push("No aligned uptrend (close vs MA50 / MA20 vs MA50).");
    if (pullbackPct >= 2 && pullbackPct <= 6) evidenceFor.push(`Pullback ${pullbackPct.toFixed(1)}% from 20d high is in the 2–6% buy zone.`);
    else evidenceAgainst.push(`Pullback ${pullbackPct.toFixed(1)}% outside the 2–6% zone.`);
    return {
      enter: uptrend && pullbackPct >= 2 && pullbackPct <= 6,
      exit: close < ma50,
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
  approvedRegimes: ["RISK_ON_TREND"],
  maxHoldingDays: 42,
  stopLossPct: 7,
  positionSizePct: 8,
  backtestable: true,
  signal(bars) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma50 = sma(closes, 50);
    const r63 = ret(closes, 63);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (ma50 === null || r63 === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (r63 > 5) evidenceFor.push(`3-month return ${r63.toFixed(1)}% shows momentum.`);
    else evidenceAgainst.push(`3-month return ${r63.toFixed(1)}% below +5% momentum bar.`);
    if (close > ma50) evidenceFor.push("Price above MA50.");
    else evidenceAgainst.push("Price below MA50.");
    return { enter: r63 > 5 && close > ma50, exit: r63 < 0 || close < ma50, evidenceFor, evidenceAgainst };
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
  signal(bars) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma50 = sma(closes, 50);
    const r5 = ret(closes, 5);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (ma50 === null || r5 === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (r5 < -4) evidenceFor.push(`5-day move ${r5.toFixed(1)}% is oversold (<-4%).`);
    else evidenceAgainst.push(`5-day move ${r5.toFixed(1)}% not oversold.`);
    if (close > ma50 * 0.93) evidenceFor.push("Holding above deep support (7% under MA50).");
    else evidenceAgainst.push("Broken far below MA50 — falling knife risk.");
    return { enter: r5 < -4 && close > ma50 * 0.93, exit: r5 !== null && r5 > 0, evidenceFor, evidenceAgainst };
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
  signal(bars) {
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1];
    const ma20 = sma(closes, 20);
    const evidenceFor: string[] = [];
    const evidenceAgainst: string[] = [];
    if (ma20 === null) return { enter: false, exit: false, evidenceFor, evidenceAgainst: ["Insufficient history."] };
    if (close > ma20) evidenceFor.push("Defensive name holding above MA20 while the market is risk-off.");
    else evidenceAgainst.push("Below MA20 — defensives not attracting flows.");
    return { enter: close > ma20, exit: close < ma20, evidenceFor, evidenceAgainst };
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
