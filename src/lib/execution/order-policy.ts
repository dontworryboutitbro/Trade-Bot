// Order-type policy: prefer limit orders; never send a market order into a
// wide spread. Deterministic and pure.

import type { QuoteSnapshot } from "@/lib/market-data/types";
import { isCryptoSymbol } from "@/lib/market-data/quality";
import type { OrderType } from "@/lib/types";

export interface OrderPolicyConfig {
  /** Above this spread (bps), market orders are converted to limit orders. */
  marketOrderMaxSpreadBps: number;
  /** Limit price buffer beyond mid toward the touch, in bps. */
  limitBufferBps: number;
}

export const DEFAULT_ORDER_POLICY: OrderPolicyConfig = {
  marketOrderMaxSpreadBps: 20,
  limitBufferBps: 5,
};

export interface OrderPlan {
  type: OrderType;
  limitPrice: number | null;
  policyNote: string;
}

export function planOrder(
  requestedType: OrderType,
  requestedLimit: number | null,
  side: "buy" | "sell",
  snapshot: QuoteSnapshot,
  config: OrderPolicyConfig = DEFAULT_ORDER_POLICY,
): OrderPlan {
  const mid = snapshot.mid ?? snapshot.lastTrade ?? null;
  if (requestedType === "LIMIT" && requestedLimit) {
    return { type: "LIMIT", limitPrice: requestedLimit, policyNote: "AI-specified limit retained." };
  }
  const wide =
    snapshot.spreadBps !== null && snapshot.spreadBps > config.marketOrderMaxSpreadBps;
  if (!wide && !isCryptoSymbol(snapshot.symbol)) {
    return { type: "MARKET", limitPrice: null, policyNote: "Tight spread; market order allowed." };
  }
  // Wide spread or crypto: convert to a marketable limit anchored at mid.
  if (mid === null) {
    return { type: "MARKET", limitPrice: null, policyNote: "No mid available; market order fallback." };
  }
  const buffer = mid * (config.limitBufferBps / 10_000);
  const limitPrice = side === "buy" ? mid + buffer : mid - buffer;
  return {
    type: "LIMIT",
    limitPrice: Math.round(limitPrice * 100) / 100,
    policyNote: wide
      ? `Spread ${snapshot.spreadBps?.toFixed(1)} bps > ${config.marketOrderMaxSpreadBps} bps: converted to marketable limit.`
      : "Crypto order routed as marketable limit.",
  };
}
