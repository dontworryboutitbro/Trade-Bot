// Deterministic execution-cost model. Pure functions over QuoteSnapshots —
// estimates what a trade really costs before the risk engine allows it.

import type { QuoteSnapshot } from "@/lib/market-data/types";

export interface ExecutionEstimate {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  /** Reference price used for the estimate (mid, falling back to last trade). */
  referencePrice: number;
  /** Estimated fill price after crossing half the spread + impact. */
  estimatedFillPrice: number;
  bidAskCostUsd: number;
  estimatedSlippageUsd: number;
  totalEstimatedCostUsd: number;
  totalEstimatedCostBps: number;
  notionalAtReference: number;
  notionalAtEstimatedFill: number;
  /** Max % the fill may deviate from reference before the order policy rejects. */
  maxPriceDeviationPct: number;
  /** Order size as a fraction of daily volume (impact proxy); null when unknown. */
  participationOfDailyVolume: number | null;
}

export interface CostModelConfig {
  /** Extra impact (bps) added per 1% of daily volume consumed. */
  impactBpsPerPctOfVolume: number;
  /** Hard ceiling on acceptable total estimated cost, in bps. */
  maxTotalCostBps: number;
  /** Allowed fill deviation from reference price. */
  maxPriceDeviationPct: number;
}

export const DEFAULT_COST_CONFIG: CostModelConfig = {
  impactBpsPerPctOfVolume: 8,
  maxTotalCostBps: 75,
  maxPriceDeviationPct: 1.0,
};

export function estimateExecution(
  snapshot: QuoteSnapshot,
  side: "buy" | "sell",
  quantity: number,
  config: CostModelConfig = DEFAULT_COST_CONFIG,
): ExecutionEstimate | null {
  const reference = snapshot.mid ?? snapshot.lastTrade;
  if (!reference || reference <= 0 || quantity <= 0) return null;

  const halfSpreadUsd = snapshot.spreadUsd !== null ? snapshot.spreadUsd / 2 : reference * 0.001;
  const notional = reference * quantity;
  const participation =
    snapshot.dailyVolume && snapshot.dailyVolume > 0 ? quantity / snapshot.dailyVolume : null;
  const impactBps =
    participation !== null ? participation * 100 * config.impactBpsPerPctOfVolume : 2;
  const slippagePerShare = reference * (impactBps / 10_000);

  const direction = side === "buy" ? 1 : -1;
  const estimatedFillPrice = reference + direction * (halfSpreadUsd + slippagePerShare);
  const bidAskCostUsd = halfSpreadUsd * quantity;
  const estimatedSlippageUsd = slippagePerShare * quantity;
  const totalEstimatedCostUsd = bidAskCostUsd + estimatedSlippageUsd;

  return {
    symbol: snapshot.symbol,
    side,
    quantity,
    referencePrice: reference,
    estimatedFillPrice,
    bidAskCostUsd,
    estimatedSlippageUsd,
    totalEstimatedCostUsd,
    totalEstimatedCostBps: notional > 0 ? (totalEstimatedCostUsd / notional) * 10_000 : 0,
    notionalAtReference: notional,
    notionalAtEstimatedFill: estimatedFillPrice * quantity,
    maxPriceDeviationPct: config.maxPriceDeviationPct,
    participationOfDailyVolume: participation,
  };
}

export function assessExecutionCost(
  estimate: ExecutionEstimate | null,
  config: CostModelConfig = DEFAULT_COST_CONFIG,
): { ok: boolean; reasons: string[] } {
  if (!estimate) return { ok: false, reasons: ["Execution cost could not be estimated."] };
  const reasons: string[] = [];
  if (estimate.totalEstimatedCostBps > config.maxTotalCostBps) {
    reasons.push(
      `Estimated execution cost ${estimate.totalEstimatedCostBps.toFixed(1)} bps exceeds the ${config.maxTotalCostBps} bps cap.`,
    );
  }
  if (
    estimate.participationOfDailyVolume !== null &&
    estimate.participationOfDailyVolume > 0.01
  ) {
    reasons.push(
      `Order is ${(estimate.participationOfDailyVolume * 100).toFixed(2)}% of daily volume (max 1%).`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}
