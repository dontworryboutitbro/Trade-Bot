// Deterministic candidate ranking. Runs BEFORE Claude; only a small ranked
// set (MAX_AI_CANDIDATES) ever reaches a prompt. Pure functions.

import type { Bar } from "@/lib/types";
import type { QuoteSnapshot } from "@/lib/market-data/types";
import type { CandidateScore, UniverseLayer } from "./types";
import { avgDailyDollarVolume, realizedVolPct } from "./filters";

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function ret(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  return ((closes[closes.length - 1] - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 100;
}

export function scoreCandidate(input: {
  symbol: string;
  assetClass: "us_equity" | "crypto";
  snapshot: QuoteSnapshot;
  bars: Bar[];
  spyBars: Bar[];
  eligibleLayer: UniverseLayer | "REJECTED";
  now: Date;
}): CandidateScore {
  const closes = input.bars.map((b) => b.close);
  const spyCloses = input.spyBars.map((b) => b.close);
  const components: Record<string, number> = {};

  // Liquidity (0–20): dollar volume on a log scale.
  const addv = avgDailyDollarVolume(input.bars) ?? 0;
  components.liquidity = clamp(((Math.log10(Math.max(addv, 1)) - 6) / 4) * 20, 0, 20);

  // Spread quality (0–15): tighter is better.
  const spread = input.snapshot.spreadBps ?? 100;
  components.spread = clamp(15 - (spread / 50) * 15, 0, 15);

  // Trend alignment (0–20): close vs MA20 vs MA50.
  const ma = (n: number) =>
    closes.length >= n ? closes.slice(-n).reduce((s, v) => s + v, 0) / n : null;
  const ma20 = ma(20);
  const ma50 = ma(50);
  const close = closes[closes.length - 1] ?? 0;
  components.trend =
    ma20 !== null && ma50 !== null ? (close > ma20 ? 8 : 0) + (ma20 > ma50 ? 7 : 0) + (close > ma50 ? 5 : 0) : 0;

  // Momentum / relative strength vs SPY (0–20).
  const r20 = ret(closes, 20);
  const spy20 = ret(spyCloses, 20);
  const rs = r20 !== null && spy20 !== null ? r20 - spy20 : null;
  components.relativeStrength = rs === null ? 0 : clamp(10 + rs * 1.5, 0, 20);

  // Volatility sanity (0–15): moderate vol scores best.
  const vol = realizedVolPct(input.bars);
  components.volatility =
    vol === null ? 0 : clamp(15 - Math.abs(vol - 25) * 0.45, 0, 15);

  // Freshness (0–10).
  components.freshness = input.snapshot.stale ? 0 : clamp(10 - input.snapshot.quoteAgeMs / 30_000, 0, 10);

  const score = clamp(
    Object.values(components).reduce((s, v) => s + v, 0),
    0,
    100,
  );
  return {
    symbol: input.symbol,
    assetClass: input.assetClass,
    score: Math.round(score * 10) / 10,
    components,
    eligibleLayer: input.eligibleLayer,
    rankedAt: input.now.toISOString(),
  };
}

export function rankCandidates(scores: CandidateScore[], limit: number): CandidateScore[] {
  return [...scores]
    .filter((s) => s.eligibleLayer === "PAPER_EXECUTION_UNIVERSE")
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
