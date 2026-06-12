// Daily adaptive learning engine — types. The learner observes, labels, and
// recommends. Deterministic code (and the human owner) decides. Claude never
// writes code, SQL, risk limits, or live settings through any of this.

import type { MarketRegime } from "@/lib/regime/engine";

export type LearningTable =
  | "learning_runs"
  | "feature_observations"
  | "outcome_labels"
  | "confidence_calibration_buckets"
  | "strategy_versions"
  | "shadow_proposals"
  | "shadow_trade_results"
  | "promotion_reviews"
  | "rollback_events"
  | "stream_health_events";

export const LEARNING_TABLES: LearningTable[] = [
  "learning_runs",
  "feature_observations",
  "outcome_labels",
  "confidence_calibration_buckets",
  "strategy_versions",
  "shadow_proposals",
  "shadow_trade_results",
  "promotion_reviews",
  "rollback_events",
  "stream_health_events",
];

export interface LearningRecord {
  id: string;
  keys: Record<string, string | null>;
  payload: unknown;
  createdAt: string;
}

/** One evaluated candidate (executed, rejected, NO_TRADE, or shadow). */
export interface FeatureObservation {
  observedAt: string;
  source: "EXECUTED" | "RISK_REJECTED" | "MANUAL_REJECTED" | "NO_TRADE" | "SHADOW";
  proposalId: string | null;
  symbol: string;
  assetClass: "us_equity" | "crypto";
  strategyId: string | null;
  strategyVersionId: string | null;
  regime: MarketRegime | string | null;
  action: string;
  confidence: number | null;
  thesis: string | null;
  counterargument: string | null;
  invalidationCondition: string | null;
  // market context
  spyReturns: { d1: number | null; d5: number | null; d20: number | null; d60: number | null };
  symbolReturns: { d1: number | null; d5: number | null; d20: number | null; d60: number | null };
  relativeStrength20d: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  quoteAgeMs: number | null;
  dailyVolume: number | null;
  realizedVolPct: number | null;
  maRelation: { aboveMa20: boolean | null; aboveMa50: boolean | null; ma20VsMa50: number | null };
  drawdownFromHighPct: number | null;
  // portfolio context
  positionsCount: number | null;
  cash: number | null;
  exposurePct: number | null;
  cooldownActive: boolean;
  // decision context
  riskResult: "PASS" | "BLOCK" | null;
  rejectionReasons: string[];
  hypotheticalEntryPrice: number | null;
  actualFillPrice: number | null;
  estimatedCostBps: number | null;
}

/** Objective outcome at a fixed horizon. */
export interface OutcomeLabel {
  sourceType: "observation" | "shadow";
  sourceId: string;
  symbol: string;
  horizonDays: number; // 1,3,5,10,20 or -1 = actual exit
  interim: boolean;
  entryPrice: number;
  exitPrice: number | null;
  returnPct: number | null;
  returnAfterCostsPct: number | null;
  spyReturnPct: number | null;
  excessReturnPct: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  stopWouldHaveTriggered: boolean | null;
  abstainWasBetter: boolean | null;
  labeledAt: string;
}

export interface CalibrationBucket {
  bucket: string; // "0-49" | "50-59" | ...
  proposalCount: number;
  executedCount: number;
  winRatePct: number | null;
  avgAfterCostReturnPct: number | null;
  medianAfterCostReturnPct: number | null;
  expectancyPct: number | null;
  excessVsSpyPct: number | null;
  abstainBetterPct: number | null;
  lowSample: boolean;
  verdict: "RELIABLE" | "OVERCONFIDENT" | "UNDERCONFIDENT" | "INSUFFICIENT_DATA";
}

export type StrategyVersionStatus =
  | "CHAMPION"
  | "CHALLENGER_GENERATED"
  | "SHADOW_TESTING"
  | "VALIDATION_FAILED"
  | "PAPER_MANUAL_CANDIDATE"
  | "PAPER_AUTONOMOUS_CANDIDATE"
  | "ARCHIVED"
  | "ROLLED_BACK";

export interface StrategyVersion {
  familyId: string; // stable strategy id, e.g. "trend-pullback"
  versionId: string; // immutable, e.g. "trend-pullback@2"
  parentVersionId: string | null;
  createdAt: string;
  creator: "BASELINE" | "SYSTEMATIC_VARIANT" | "AI_RESEARCH_PROPOSAL";
  params: Record<string, number>;
  approvedRegimes: string[];
  status: StrategyVersionStatus;
  metrics: unknown;
  rejectionReasons: string[];
  shadowStartedAt: string | null;
}

export interface ShadowProposal {
  versionId: string;
  familyId: string;
  symbol: string;
  proposedAt: string;
  entryPrice: number; // next-day-open hypothetical, tracked via labels
  stopLossPct: number;
  maxHoldingDays: number;
  status: "OPEN" | "CLOSED";
  exitPrice: number | null;
  exitReason: string | null;
  plPctAfterCosts: number | null;
  closedAt: string | null;
}

export interface DailyLearningReport {
  marketDate: string;
  regime: string;
  account: { equity: number | null; cash: number | null };
  paperPlToday: number | null;
  stressTestedPlToday: number | null;
  spyRelativeToday: number | null;
  proposalsGenerated: number;
  executed: number;
  rejected: number;
  noTradeDecisions: number;
  bestDecision: string | null;
  worstDecision: string | null;
  strongestRejected: string | null;
  calibrationSummary: string;
  strategyFindings: { strategyId: string; note: string }[];
  dataQualityIncidents: number;
  challengerUpdates: string[];
  rollbacks: string[];
  reviewItems: string[];
  narrative: string;
}

export interface WeeklyValidationReport {
  weekOf: string;
  championSummaries: { versionId: string; note: string }[];
  challengerRankings: { versionId: string; stressedExpectancyPct: number | null; trades: number; verdict: string }[];
  promotionsEligible: string[];
  challengersRejected: string[];
  rollbacksTriggered: string[];
  calibrationSummary: string;
  overfittingWarnings: string[];
  costSensitivityNotes: string[];
  dataQualitySummary: string;
  researchPriorities: string[];
}
