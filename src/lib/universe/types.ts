// Dynamic asset universe. Scan broadly, trade selectively:
// DISCOVERY ⊇ RESEARCH ⊇ PAPER_EXECUTION ⊇ LIVE_MANUAL. LIVE_AUTONOMOUS stays
// disabled. Membership is decided by deterministic filters only.

export type UniverseLayer =
  | "DISCOVERY_UNIVERSE"
  | "RESEARCH_UNIVERSE"
  | "PAPER_EXECUTION_UNIVERSE"
  | "LIVE_MANUAL_UNIVERSE";

export interface UniverseAsset {
  symbol: string;
  name: string;
  assetClass: "us_equity" | "crypto";
  exchange: string;
  active: boolean;
  tradable: boolean;
  fractionable: boolean;
  shortable: boolean;
  marginable: boolean;
  firstSeenAt: string;
  refreshedAt: string;
  source: "alpaca_assets_api";
}

export interface EligibilityResult {
  symbol: string;
  layer: UniverseLayer | "REJECTED";
  reasons: string[]; // rejection reasons when REJECTED / not promoted further
}

export interface EquityFilterConfig {
  minPriceUsd: number;
  maxSpreadBps: number;
  minAvgDailyDollarVolume: number;
  minSeasoningTradingDays: number;
  minRecentBars: number;
  allowOtc: boolean;
  allowLeveraged: boolean;
  allowInverse: boolean;
  allowMicrocapExecution: boolean;
  maxRealizedVolPct: number; // annualized; severe-spike rejection
}

export const DEFAULT_EQUITY_FILTERS: EquityFilterConfig = {
  minPriceUsd: 5,
  maxSpreadBps: 35,
  minAvgDailyDollarVolume: 20_000_000,
  minSeasoningTradingDays: 20,
  minRecentBars: 60,
  allowOtc: false,
  allowLeveraged: false,
  allowInverse: false,
  allowMicrocapExecution: false,
  maxRealizedVolPct: 90,
};

/** Live-manual filters are strictly tighter than paper. */
export const LIVE_EQUITY_FILTERS: EquityFilterConfig = {
  ...DEFAULT_EQUITY_FILTERS,
  minPriceUsd: 10,
  maxSpreadBps: 20,
  minAvgDailyDollarVolume: 100_000_000,
  minSeasoningTradingDays: 60,
  maxRealizedVolPct: 50,
};

export interface CandidateScore {
  symbol: string;
  assetClass: "us_equity" | "crypto";
  score: number; // 0–100 deterministic composite
  components: Record<string, number>;
  eligibleLayer: UniverseLayer | "REJECTED";
  rankedAt: string;
}

/** Hard cap on candidates per AI evaluation — never send the whole market. */
export const MAX_AI_CANDIDATES = 8;
