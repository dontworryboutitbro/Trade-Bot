// Daily-bar backtest engine for mechanical strategies. Strict no-look-ahead:
// signals are computed on bars [0..i] and filled at the NEXT bar's open with
// transaction-cost and slippage assumptions. Pure — no I/O; callers supply bars.

import type { Bar } from "@/lib/types";
import type { Strategy } from "@/lib/strategies/definitions";

export interface BacktestConfig {
  /** Per-side transaction cost in bps (spread + slippage assumption). */
  costBpsPerSide: number;
  /** Capital per position as fraction of equity (falls back to strategy sizing). */
  positionSizePct?: number;
  startingEquity: number;
  maxPositions: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  costBpsPerSide: 10,
  startingEquity: 10_000,
  maxPositions: 5,
};

export interface BacktestTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number; // after costs
  exitDate: string;
  exitPrice: number; // after costs
  quantity: number;
  plUsd: number;
  plPct: number;
  holdingDays: number;
  exitReason: "SIGNAL" | "STOP" | "TIME" | "END_OF_DATA";
  grossPlUsd: number;
  costsUsd: number;
}

export interface BacktestResult {
  strategyId: string;
  startDate: string;
  endDate: string;
  trades: BacktestTrade[];
  equityCurve: { date: string; equity: number }[];
  finalEquity: number;
  config: BacktestConfig;
}

interface OpenPosition {
  symbol: string;
  entryIndex: number;
  entryDate: string;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  grossEntryCost: number;
  entryCostsUsd: number;
}

/**
 * Run a backtest over aligned daily bars. `barsBySymbol` values must be sorted
 * oldest→newest. Bars are aligned by timestamp date; symbols missing a date are
 * skipped that day.
 */
export function runBacktest(
  strategy: Strategy,
  barsBySymbol: Record<string, Bar[]>,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  if (!strategy.signal) {
    throw new Error(`Strategy ${strategy.id} is not mechanically backtestable.`);
  }
  const symbols = Object.keys(barsBySymbol);
  // Build the union calendar of trading dates.
  const dates = Array.from(
    new Set(symbols.flatMap((s) => barsBySymbol[s].map((b) => b.timestamp.slice(0, 10)))),
  ).sort();
  const indexByDate: Record<string, Record<string, number>> = {};
  for (const symbol of symbols) {
    barsBySymbol[symbol].forEach((bar, i) => {
      const d = bar.timestamp.slice(0, 10);
      (indexByDate[d] ??= {})[symbol] = i;
    });
  }

  const costMult = config.costBpsPerSide / 10_000;
  const sizePct = (config.positionSizePct ?? strategy.positionSizePct) / 100;
  let cash = config.startingEquity;
  const open: OpenPosition[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];

  const closeTrade = (
    pos: OpenPosition,
    rawExit: number,
    date: string,
    barIndex: number,
    reason: BacktestTrade["exitReason"],
  ) => {
    const exitCosts = rawExit * pos.quantity * costMult;
    const exitPrice = rawExit - rawExit * costMult;
    const proceeds = exitPrice * pos.quantity;
    cash += proceeds;
    const plUsd = proceeds - pos.entryPrice * pos.quantity;
    trades.push({
      symbol: pos.symbol,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      exitDate: date,
      exitPrice,
      quantity: pos.quantity,
      plUsd,
      plPct: (plUsd / (pos.entryPrice * pos.quantity)) * 100,
      holdingDays: barIndex - pos.entryIndex,
      exitReason: reason,
      grossPlUsd: (rawExit - pos.grossEntryCost / pos.quantity) * pos.quantity,
      costsUsd: pos.entryCostsUsd + exitCosts,
    });
  };

  for (let d = 0; d < dates.length; d++) {
    const date = dates[d];
    const todayIdx = indexByDate[date] ?? {};

    // 1. Exits first (signal computed on data through yesterday, filled at today's open).
    for (const pos of [...open]) {
      const i = todayIdx[pos.symbol];
      if (i === undefined || i === 0) continue;
      const bars = barsBySymbol[pos.symbol];
      const today = bars[i];
      const history = bars.slice(0, i); // strictly prior data — no look-ahead
      const sig = strategy.signal!(history);
      const heldDays = i - pos.entryIndex;

      let exitReason: BacktestTrade["exitReason"] | null = null;
      let rawExit = today.open;
      if (today.low <= pos.stopPrice) {
        exitReason = "STOP";
        rawExit = Math.min(today.open, pos.stopPrice); // gap-down fills below the stop
      } else if (sig.exit) {
        exitReason = "SIGNAL";
      } else if (heldDays >= strategy.maxHoldingDays) {
        exitReason = "TIME";
      }
      if (exitReason) {
        closeTrade(pos, rawExit, date, i, exitReason);
        open.splice(open.indexOf(pos), 1);
      }
    }

    // 2. Entries (signal on data through yesterday, filled at today's open).
    const equityNow =
      cash +
      open.reduce((sum, pos) => {
        const i = todayIdx[pos.symbol];
        const price = i !== undefined ? barsBySymbol[pos.symbol][i].open : pos.entryPrice;
        return sum + price * pos.quantity;
      }, 0);

    for (const symbol of symbols) {
      if (open.length >= config.maxPositions) break;
      if (open.some((p) => p.symbol === symbol)) continue;
      const i = todayIdx[symbol];
      if (i === undefined || i < 60) continue; // need history, and never index 0
      const bars = barsBySymbol[symbol];
      const history = bars.slice(0, i);
      const sig = strategy.signal!(history);
      if (!sig.enter) continue;

      const rawEntry = bars[i].open;
      const entryPrice = rawEntry + rawEntry * costMult;
      const budget = equityNow * sizePct;
      const quantity = Math.floor(budget / entryPrice);
      if (quantity < 1 || entryPrice * quantity > cash) continue;
      cash -= entryPrice * quantity;
      open.push({
        symbol,
        entryIndex: i,
        entryDate: date,
        entryPrice,
        quantity,
        stopPrice: rawEntry * (1 - strategy.stopLossPct / 100),
        grossEntryCost: rawEntry * quantity,
        entryCostsUsd: rawEntry * quantity * costMult,
      });
    }

    // 3. Mark to market at close.
    const equityClose =
      cash +
      open.reduce((sum, pos) => {
        const i = todayIdx[pos.symbol];
        const price =
          i !== undefined ? barsBySymbol[pos.symbol][i].close : pos.entryPrice;
        return sum + price * pos.quantity;
      }, 0);
    equityCurve.push({ date, equity: Math.round(equityClose * 100) / 100 });
  }

  // Close remaining positions at the last available close.
  for (const pos of [...open]) {
    const bars = barsBySymbol[pos.symbol];
    const last = bars[bars.length - 1];
    closeTrade(pos, last.close, last.timestamp.slice(0, 10), bars.length - 1, "END_OF_DATA");
  }

  return {
    strategyId: strategy.id,
    startDate: dates[0] ?? "",
    endDate: dates[dates.length - 1] ?? "",
    trades,
    equityCurve,
    finalEquity: equityCurve[equityCurve.length - 1]?.equity ?? config.startingEquity,
    config,
  };
}
