// Live-pilot configuration. Values come ONLY from server-side environment
// variables (with conservative hardcoded defaults) plus the audited capital
// stage in app_settings. Claude has no path to any of these values.

export interface PilotConfig {
  /** Capital intended for the live pilot (paper realism warnings compare to this). */
  targetCapitalUsd: number;
  /** Hard ceiling on enabled live capital regardless of stage. */
  maxCapitalUsd: number;
  maxPositionUsd: number;
  maxPositions: number;
  maxEntriesPerDay: number;
  maxDailyLossUsd: number;
  maxWeeklyLossPct: number;
  maxSpreadBps: number;
  maxQuoteAgeSeconds: number;
  maxSlippageBps: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getPilotConfig(): PilotConfig {
  return {
    targetCapitalUsd: envNumber("TARGET_LIVE_PILOT_CAPITAL", 250),
    maxCapitalUsd: envNumber("PILOT_MAX_CAPITAL_USD", 250),
    maxPositionUsd: envNumber("PILOT_MAX_POSITION_USD", 50),
    maxPositions: envNumber("PILOT_MAX_POSITIONS", 2),
    maxEntriesPerDay: envNumber("PILOT_MAX_ENTRIES_PER_DAY", 2),
    maxDailyLossUsd: envNumber("PILOT_MAX_DAILY_LOSS_USD", 10),
    maxWeeklyLossPct: envNumber("PILOT_MAX_WEEKLY_LOSS_PCT", 3),
    maxSpreadBps: envNumber("PILOT_MAX_SPREAD_BPS", 25),
    maxQuoteAgeSeconds: envNumber("PILOT_MAX_QUOTE_AGE_SECONDS", 60),
    maxSlippageBps: envNumber("PILOT_MAX_SLIPPAGE_BPS", 30),
  };
}

/** Capital stages — expansion is always a manual, audited decision. */
export const CAPITAL_STAGES = {
  CANARY_100: 100,
  PILOT_250: 250,
  PILOT_500: 500,
  REVIEW_REQUIRED: 0,
} as const;

export type CapitalStage = keyof typeof CAPITAL_STAGES;

export function stageCapitalUsd(stage: string, config: PilotConfig): number {
  const stageValue = CAPITAL_STAGES[stage as CapitalStage] ?? 0;
  return Math.min(stageValue, config.maxCapitalUsd);
}

/** Pilot runtime inputs assembled by the pipeline for the risk engine. */
export interface PilotContext {
  config: PilotConfig;
  capitalStage: string;
  enabledCapitalUsd: number;
  entriesToday: number;
  dailyLossUsd: number; // positive = loss
  weeklyLossPct: number; // positive = loss
  assetClass: "us_equity" | "crypto" | "unknown";
  reconciliationHealthy: boolean;
  streamingFreshnessVerifiable: boolean;
}
