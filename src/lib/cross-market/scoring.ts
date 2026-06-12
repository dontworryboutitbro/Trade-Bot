// Deterministic divergence scoring + match-quality classification. Pure.

import {
  MAX_QUOTE_AGE_MS,
  MIN_DEPTH_USD,
  SAFETY_BUFFER,
  type CrossMarketRow,
  type MatchQuality,
} from "./types";

export function scoreDivergence(input: {
  midpoint: number | null;
  spread: number | null;
  externalImpliedProbability: number | null;
}): { rawDivergence: number | null; netDivergence: number | null } {
  if (input.midpoint === null || input.externalImpliedProbability === null) {
    return { rawDivergence: null, netDivergence: null };
  }
  const raw = input.midpoint - input.externalImpliedProbability;
  const halfSpread = (input.spread ?? 0.05) / 2;
  return {
    rawDivergence: raw,
    netDivergence: Math.abs(raw) - halfSpread - SAFETY_BUFFER,
  };
}

export function classifyMatch(input: {
  hasPolymarketData: boolean;
  hasExternalProbability: boolean;
  externalIsProxy: boolean;
  intendedExpiry: string;
  actualExpiry: string | null;
  settlementRulesComparable: boolean;
  quoteAgeMs: number | null;
  depthUsd: number | null;
}): { quality: MatchQuality; explanation: string | null } {
  if (!input.hasPolymarketData) {
    return { quality: "FALLBACK_DATA", explanation: "Polymarket data unavailable; showing fallback state." };
  }
  if (input.quoteAgeMs !== null && input.quoteAgeMs > MAX_QUOTE_AGE_MS) {
    return { quality: "STALE_DATA", explanation: `Polymarket quote is ${Math.round(input.quoteAgeMs / 60000)}m old.` };
  }
  if (input.depthUsd !== null && input.depthUsd < MIN_DEPTH_USD) {
    return { quality: "LOW_LIQUIDITY", explanation: `Order-book depth ~$${input.depthUsd.toFixed(0)} is below $${MIN_DEPTH_USD}.` };
  }
  if (!input.hasExternalProbability) {
    return { quality: "FALLBACK_DATA", explanation: "No external probability source available for comparison." };
  }
  if (!input.settlementRulesComparable) {
    return {
      quality: "SETTLEMENT_RULE_MISMATCH",
      explanation: "Settlement rules differ from the external instrument; prices are not directly comparable.",
    };
  }
  if (input.actualExpiry) {
    const intended = new Date(input.intendedExpiry).getTime();
    const actual = new Date(input.actualExpiry).getTime();
    if (Math.abs(actual - intended) > 14 * 86_400_000) {
      return {
        quality: "EXPIRY_MISMATCH",
        explanation: "Polymarket expiry differs from the intended comparison window by more than 14 days.",
      };
    }
  }
  if (input.externalIsProxy) {
    return { quality: "CLOSE_PROXY", explanation: "External probability is a model-based proxy, not an executable market price." };
  }
  return { quality: "EXACT_MATCH", explanation: null };
}

/** A divergence is research-notable only with quality data and positive net edge. */
export function isNotable(row: Pick<CrossMarketRow, "matchQuality" | "netDivergence">): boolean {
  return (
    (row.matchQuality === "EXACT_MATCH" || row.matchQuality === "CLOSE_PROXY") &&
    row.netDivergence !== null &&
    row.netDivergence > 0
  );
}
