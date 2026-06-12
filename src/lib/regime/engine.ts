// Deterministic market-regime classifier. Transparent rules over SPY daily
// bars — no ML, no AI. Pure and unit-testable.

import type { Bar } from "@/lib/types";

export type MarketRegime =
  | "RISK_ON_TREND"
  | "RISK_OFF_TREND"
  | "SIDEWAYS_LOW_VOL"
  | "SIDEWAYS_HIGH_VOL"
  | "VOLATILITY_SPIKE"
  | "INSUFFICIENT_DATA";

export interface RegimeReading {
  regime: MarketRegime;
  asOf: string;
  metrics: {
    close: number | null;
    ma20: number | null;
    ma50: number | null;
    drawdownPct: number | null; // % below trailing 90-bar peak
    realizedVolAnnualizedPct: number | null; // 20-bar
    volRatio: number | null; // short-term vol / longer-term vol
  };
  rules: string[];
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

/** Classify the market regime from SPY daily bars (oldest → newest). */
export function classifyRegime(spyBars: Bar[]): RegimeReading {
  const closes = spyBars.map((b) => b.close);
  const asOf = spyBars[spyBars.length - 1]?.timestamp ?? new Date(0).toISOString();
  if (closes.length < 60) {
    return {
      regime: "INSUFFICIENT_DATA",
      asOf,
      metrics: {
        close: closes[closes.length - 1] ?? null,
        ma20: null,
        ma50: null,
        drawdownPct: null,
        realizedVolAnnualizedPct: null,
        volRatio: null,
      },
      rules: [`Need ≥60 daily bars, have ${closes.length}.`],
    };
  }

  const close = closes[closes.length - 1];
  const ma20 = mean(closes.slice(-20));
  const ma50 = mean(closes.slice(-50));
  const peak90 = Math.max(...closes.slice(-90));
  const drawdownPct = ((peak90 - close) / peak90) * 100;

  const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const vol20 = stdev(returns.slice(-20)) * Math.sqrt(252) * 100;
  const vol60 = stdev(returns.slice(-60)) * Math.sqrt(252) * 100;
  const volRatio = vol60 > 0 ? vol20 / vol60 : 1;

  const rules: string[] = [];
  let regime: MarketRegime;

  if (volRatio > 1.75 && vol20 > 20) {
    regime = "VOLATILITY_SPIKE";
    rules.push(
      `20d vol ${vol20.toFixed(1)}% is ${volRatio.toFixed(2)}× the 60d baseline (>1.75× and >20%).`,
    );
  } else if (close > ma20 && ma20 > ma50 && drawdownPct < 3) {
    regime = "RISK_ON_TREND";
    rules.push("Close > MA20 > MA50 and drawdown < 3%: established uptrend.");
  } else if (close < ma20 && ma20 < ma50 && drawdownPct > 5) {
    regime = "RISK_OFF_TREND";
    rules.push("Close < MA20 < MA50 and drawdown > 5%: established downtrend.");
  } else if (vol20 <= 15) {
    regime = "SIDEWAYS_LOW_VOL";
    rules.push(`No aligned trend; 20d vol ${vol20.toFixed(1)}% ≤ 15%: quiet range.`);
  } else {
    regime = "SIDEWAYS_HIGH_VOL";
    rules.push(`No aligned trend; 20d vol ${vol20.toFixed(1)}% > 15%: choppy range.`);
  }

  return {
    regime,
    asOf,
    metrics: {
      close,
      ma20: Math.round(ma20 * 100) / 100,
      ma50: Math.round(ma50 * 100) / 100,
      drawdownPct: Math.round(drawdownPct * 100) / 100,
      realizedVolAnnualizedPct: Math.round(vol20 * 100) / 100,
      volRatio: Math.round(volRatio * 100) / 100,
    },
    rules,
  };
}
