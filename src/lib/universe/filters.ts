// Deterministic eligibility filters. Pure functions over asset metadata,
// quote snapshots, and daily bars — fully unit-testable.

import type { Bar } from "@/lib/types";
import type { QuoteSnapshot } from "@/lib/market-data/types";
import type { EligibilityResult, EquityFilterConfig, UniverseAsset } from "./types";
import { DEFAULT_EQUITY_FILTERS } from "./types";

const LEVERAGED_NAME = /\b(2x|3x|ultra|ultrapro|leveraged|bull 2x|bull 3x)\b/i;
const INVERSE_NAME = /\b(short|inverse|bear)\b/i;

export function serverDenylist(): Set<string> {
  return new Set(
    (process.env.UNIVERSE_DENYLIST ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export interface EquityEvidence {
  asset: UniverseAsset;
  snapshot: QuoteSnapshot | null;
  bars: Bar[]; // daily, oldest→newest
  unresolvedDataQualityIncident: boolean;
}

function realizedVolPct(bars: Bar[]): number | null {
  if (bars.length < 21) return null;
  const closes = bars.map((b) => b.close);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const recent = rets.slice(-20);
  const mean = recent.reduce((s, v) => s + v, 0) / recent.length;
  const sd = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / (recent.length - 1));
  return sd * Math.sqrt(252) * 100;
}

function avgDailyDollarVolume(bars: Bar[]): number | null {
  if (bars.length < 5) return null;
  const recent = bars.slice(-20);
  return recent.reduce((s, b) => s + b.close * b.volume, 0) / recent.length;
}

/** Layer classification for one equity. Reasons explain the highest layer NOT reached. */
export function classifyEquity(
  evidence: EquityEvidence,
  config: EquityFilterConfig = DEFAULT_EQUITY_FILTERS,
  denylist: Set<string> = serverDenylist(),
): EligibilityResult {
  const { asset, snapshot, bars } = evidence;
  const reasons: string[] = [];

  // DISCOVERY gate (anything failing here is fully rejected).
  if (denylist.has(asset.symbol)) {
    return { symbol: asset.symbol, layer: "REJECTED", reasons: ["On the server denylist."] };
  }
  if (!asset.active) return { symbol: asset.symbol, layer: "REJECTED", reasons: ["Inactive at the brokerage."] };
  if (!asset.tradable) return { symbol: asset.symbol, layer: "REJECTED", reasons: ["Not tradable."] };
  if (asset.exchange === "OTC" && !config.allowOtc) {
    return { symbol: asset.symbol, layer: "REJECTED", reasons: ["OTC venue excluded."] };
  }

  // RESEARCH gate: needs usable data.
  if (!snapshot || snapshot.bid === null || snapshot.ask === null) reasons.push("No valid bid/ask quote.");
  if (snapshot && snapshot.stale) reasons.push("Quote freshness not verified (stale).");
  if (bars.length < Math.min(20, config.minRecentBars)) reasons.push("Insufficient recent bar history for research.");
  if (reasons.length > 0) {
    return { symbol: asset.symbol, layer: "DISCOVERY_UNIVERSE", reasons };
  }

  // PAPER_EXECUTION gate.
  const price = snapshot!.mid ?? snapshot!.lastTrade ?? 0;
  const vol = realizedVolPct(bars);
  const addv = avgDailyDollarVolume(bars);
  if (LEVERAGED_NAME.test(asset.name) && !config.allowLeveraged) reasons.push("Leveraged ETF excluded.");
  if (INVERSE_NAME.test(asset.name) && !config.allowInverse) reasons.push("Inverse ETF excluded.");
  if (price < config.minPriceUsd) reasons.push(`Price $${price.toFixed(2)} below $${config.minPriceUsd} minimum.`);
  if (snapshot!.halted === true) reasons.push("Security is halted.");
  if (snapshot!.spreadBps !== null && snapshot!.spreadBps > config.maxSpreadBps) {
    reasons.push(`Spread ${snapshot!.spreadBps.toFixed(1)} bps exceeds ${config.maxSpreadBps} bps.`);
  }
  if (addv === null || addv < config.minAvgDailyDollarVolume) {
    reasons.push(
      `Avg daily dollar volume ${addv === null ? "unknown" : `$${(addv / 1e6).toFixed(1)}M`} below $${config.minAvgDailyDollarVolume / 1e6}M.`,
    );
  }
  if (bars.length < config.minSeasoningTradingDays) {
    reasons.push(`Only ${bars.length} trading days of history — seasoning period is ${config.minSeasoningTradingDays} days.`);
  }
  if (bars.length < config.minRecentBars) reasons.push(`Needs ${config.minRecentBars} recent bars for signals.`);
  if (vol !== null && vol > config.maxRealizedVolPct) {
    reasons.push(`Realized vol ${vol.toFixed(0)}% exceeds the ${config.maxRealizedVolPct}% spike threshold.`);
  }
  if (evidence.unresolvedDataQualityIncident) reasons.push("Unresolved data-quality incident.");

  if (reasons.length > 0) {
    return { symbol: asset.symbol, layer: "RESEARCH_UNIVERSE", reasons };
  }
  return { symbol: asset.symbol, layer: "PAPER_EXECUTION_UNIVERSE", reasons: [] };
}

/* ===== Crypto ===== */

export interface CryptoFilterConfig {
  min24hDollarVolume: number;
  maxSpreadBps: number;
  minOrderBookDepthUsd: number;
  maxRealizedVolPct: number;
  takerFeeBps: number; // Alpaca base tier
  maxSlippageBps: number;
}

export const DEFAULT_CRYPTO_FILTERS: CryptoFilterConfig = {
  // Alpaca-VENUE 24h dollar volume (where we actually execute) — venue books
  // are far thinner than global crypto volume, so this floor is venue-scaled.
  min24hDollarVolume: 50_000,
  maxSpreadBps: 60,
  minOrderBookDepthUsd: 25_000,
  maxRealizedVolPct: 150,
  takerFeeBps: 25, // 0.25% base-tier taker fee
  maxSlippageBps: 40,
};

export interface CryptoEvidence {
  asset: UniverseAsset;
  snapshot: QuoteSnapshot | null;
  bars: Bar[];
  accountCryptoEligible: boolean | null; // null = unknown → no execution
  unresolvedDataQualityIncident: boolean;
}

/** Estimated all-in crypto cost: taker fee + half spread + impact proxy. */
export function estimateCryptoCostBps(
  snapshot: QuoteSnapshot,
  config: CryptoFilterConfig = DEFAULT_CRYPTO_FILTERS,
): number | null {
  if (snapshot.spreadBps === null) return null;
  return config.takerFeeBps + snapshot.spreadBps / 2 + 2;
}

export function classifyCrypto(
  evidence: CryptoEvidence,
  config: CryptoFilterConfig = DEFAULT_CRYPTO_FILTERS,
  denylist: Set<string> = serverDenylist(),
): EligibilityResult {
  const { asset, snapshot, bars } = evidence;
  if (denylist.has(asset.symbol)) {
    return { symbol: asset.symbol, layer: "REJECTED", reasons: ["On the server denylist."] };
  }
  if (!asset.active || !asset.tradable) {
    return { symbol: asset.symbol, layer: "REJECTED", reasons: ["Inactive or non-tradable pair."] };
  }
  if (!/\/USD$/.test(asset.symbol)) {
    return { symbol: asset.symbol, layer: "REJECTED", reasons: ["Only USD-quoted pairs are supported."] };
  }

  const reasons: string[] = [];
  if (!snapshot || snapshot.mid === null) reasons.push("No current quote.");
  if (snapshot?.stale) reasons.push("Quote stale.");
  if (bars.length < 20) reasons.push("Insufficient price history.");
  if (reasons.length > 0) return { symbol: asset.symbol, layer: "DISCOVERY_UNIVERSE", reasons };

  // PAPER execution gate.
  if (evidence.accountCryptoEligible !== true) {
    reasons.push("Crypto account eligibility unknown or inactive — execution blocked.");
  }
  const vol24h =
    snapshot!.dailyVolume !== null && snapshot!.mid !== null
      ? snapshot!.dailyVolume * snapshot!.mid
      : null;
  if (vol24h === null || vol24h < config.min24hDollarVolume) {
    reasons.push(
      `Alpaca-venue 24h dollar volume ${vol24h === null ? "unknown" : `$${(vol24h / 1e3).toFixed(0)}k`} below $${config.min24hDollarVolume / 1e3}k.`,
    );
  }
  if (snapshot!.spreadBps !== null && snapshot!.spreadBps > config.maxSpreadBps) {
    reasons.push(`Spread ${snapshot!.spreadBps.toFixed(1)} bps exceeds ${config.maxSpreadBps} bps.`);
  }
  const cost = estimateCryptoCostBps(snapshot!, config);
  if (cost === null) reasons.push("Fee model could not be computed — execution blocked.");
  else if (cost > config.takerFeeBps + config.maxSlippageBps) {
    reasons.push(`All-in cost ${cost.toFixed(1)} bps exceeds fee+slippage budget.`);
  }
  const vol = realizedVolPct(bars);
  if (vol !== null && vol > config.maxRealizedVolPct) {
    reasons.push(`Realized vol ${vol.toFixed(0)}% exceeds the ${config.maxRealizedVolPct}% spike threshold.`);
  }
  if (evidence.unresolvedDataQualityIncident) reasons.push("Unresolved data-quality incident.");

  if (reasons.length > 0) return { symbol: asset.symbol, layer: "RESEARCH_UNIVERSE", reasons };
  return { symbol: asset.symbol, layer: "PAPER_EXECUTION_UNIVERSE", reasons: [] };
}

export { realizedVolPct, avgDailyDollarVolume };
