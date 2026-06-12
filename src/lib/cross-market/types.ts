// Cross-market research types. READ-ONLY by construction: this module has no
// auth, no wallet, no order types, and no path to any brokerage adapter.

export type MatchQuality =
  | "EXACT_MATCH"
  | "CLOSE_PROXY"
  | "EXPIRY_MISMATCH"
  | "SETTLEMENT_RULE_MISMATCH"
  | "STALE_DATA"
  | "LOW_LIQUIDITY"
  | "FALLBACK_DATA"
  | "REJECTED";

export interface CrossMarketRow {
  key: string;
  event: string;
  polymarketSlug: string | null;
  intendedExpiry: string;
  actualExpiry: string | null;
  yesBestBid: number | null;
  yesBestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  lastTrade: number | null;
  depthUsd: number | null;
  quoteAgeMs: number | null;
  liquidityOk: boolean;
  externalImpliedProbability: number | null;
  externalMethod: string;
  rawDivergence: number | null;
  /** |raw| minus half-spread and safety buffer; ≤0 means no researchable edge. */
  netDivergence: number | null;
  matchQuality: MatchQuality;
  mismatchExplanation: string | null;
  dataSource: "polymarket_gamma+clob" | "fallback";
  sourceStatus: "OK" | "DEGRADED" | "UNAVAILABLE";
  sparkline: number[]; // 7-day midpoint history (may be empty)
  capturedAt: string;
}

/** Safety buffer subtracted from raw divergence before calling anything notable. */
export const SAFETY_BUFFER = 0.02;
export const MIN_DEPTH_USD = 500;
export const MAX_QUOTE_AGE_MS = 10 * 60 * 1000;
