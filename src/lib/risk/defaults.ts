import type { RiskLimits } from "@/lib/types";

export const PAPER_DEFAULT_LIMITS: RiskLimits = {
  environment: "PAPER",
  maxPositions: 5,
  maxTotalExposurePct: 60,
  maxSymbolExposurePct: 10,
  maxOrderNotional: 10, // 10% of equity
  maxOrderNotionalIsPct: true,
  maxTradesPerDay: 3,
  maxCryptoTradesPerDay: 100,
  maxDailyLossPct: 2,
  maxDrawdownPct: 8,
  minSharePrice: 10,
  maxLiveFundedBalance: null,
  marketHoursOnly: true,
  allowMargin: false,
  allowOptions: false,
  allowShorting: false,
  allowCrypto: false,
  allowLeveragedEtfs: false,
  allowInverseEtfs: false,
  allowOtc: false,
};

export const LIVE_DEFAULT_LIMITS: RiskLimits = {
  environment: "LIVE",
  maxPositions: 5,
  maxTotalExposurePct: 60,
  maxSymbolExposurePct: 10,
  maxOrderNotional: 100, // absolute $100 cap
  maxOrderNotionalIsPct: false,
  maxTradesPerDay: 3,
  maxCryptoTradesPerDay: 3, // crypto is locked off for LIVE anyway
  maxDailyLossPct: 2,
  maxDrawdownPct: 8,
  minSharePrice: 10,
  maxLiveFundedBalance: 1000,
  marketHoursOnly: true,
  allowMargin: false,
  allowOptions: false,
  allowShorting: false,
  allowCrypto: false,
  allowLeveragedEtfs: false,
  allowInverseEtfs: false,
  allowOtc: false,
};

// MOCK uses paper limits.
export const MOCK_DEFAULT_LIMITS: RiskLimits = { ...PAPER_DEFAULT_LIMITS, environment: "MOCK" };

export function defaultLimitsFor(environment: "MOCK" | "PAPER" | "LIVE"): RiskLimits {
  if (environment === "LIVE") return LIVE_DEFAULT_LIMITS;
  if (environment === "PAPER") return PAPER_DEFAULT_LIMITS;
  return MOCK_DEFAULT_LIMITS;
}

/** Quote older than this is considered stale and blocks execution. */
export const MAX_QUOTE_AGE_MS = 5 * 60 * 1000;
