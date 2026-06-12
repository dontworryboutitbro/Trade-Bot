// Typed market-data quality layer. Every quote that feeds the AI or the
// execution pipeline is captured as a QuoteSnapshot and assessed before use.

export type MarketSession = "REGULAR" | "CLOSED" | "EXTENDED" | "CRYPTO_24_7";
export type LiquidityStatus = "OK" | "LOW" | "UNKNOWN";

export interface QuoteSnapshot {
  symbol: string;
  timestamp: string; // quote timestamp from the source
  capturedAt: string; // when we captured it
  bid: number | null;
  ask: number | null;
  mid: number | null;
  lastTrade: number | null;
  spreadUsd: number | null;
  spreadBps: number | null;
  quoteAgeMs: number;
  source: "alpaca_rest" | "mock";
  session: MarketSession;
  dailyVolume: number | null;
  avgDailyVolume: number | null;
  /** Annualized realized-volatility estimate from recent daily closes, when available. */
  volatilityEstimate: number | null;
  stale: boolean;
  liquidity: LiquidityStatus;
  halted: boolean | null;
}

export interface QualityConfig {
  maxQuoteAgeMs: number;
  maxSpreadBps: number;
  minDailyVolume: number;
  /** Crypto trades around the clock and quotes are wider; separate thresholds. */
  cryptoMaxSpreadBps: number;
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  maxQuoteAgeMs: 5 * 60 * 1000,
  maxSpreadBps: 50,
  minDailyVolume: 100_000,
  cryptoMaxSpreadBps: 120,
};

export interface QualityAssessment {
  ok: boolean;
  reasons: string[];
}
