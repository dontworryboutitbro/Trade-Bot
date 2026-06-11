// Shared domain types. No secrets, safe to import anywhere.

export type TradingMode =
  | "MOCK"
  | "PAPER_MANUAL"
  | "PAPER_AUTONOMOUS"
  | "LIVE_LOCKED"
  | "LIVE_MANUAL"
  | "LIVE_AUTONOMOUS";

export type Environment = "MOCK" | "PAPER" | "LIVE";

export type TradeAction = "BUY" | "SELL" | "REDUCE" | "EXIT" | "HOLD" | "NO_ACTION";

export type OrderType = "MARKET" | "LIMIT";

export type ProposalStatus =
  | "PENDING_RISK"
  | "BLOCKED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "QUEUED"
  | "EXECUTING"
  | "EXECUTED"
  | "EXPIRED"
  | "FAILED";

export type OrderStatus =
  | "NEW"
  | "SUBMITTED"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED"
  | "UNKNOWN";

export type Severity = "INFO" | "WARNING" | "CRITICAL";

export function modeToEnvironment(mode: TradingMode): Environment {
  if (mode === "MOCK") return "MOCK";
  if (mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS") return "PAPER";
  return "LIVE";
}

export function isLiveMode(mode: TradingMode): boolean {
  return modeToEnvironment(mode) === "LIVE";
}

export function isAutonomousMode(mode: TradingMode): boolean {
  return mode === "PAPER_AUTONOMOUS" || mode === "LIVE_AUTONOMOUS";
}

/** Modes in which order execution is permitted at all. LIVE_LOCKED can never trade. */
export function canExecuteOrders(mode: TradingMode): boolean {
  return mode !== "LIVE_LOCKED";
}

export interface AccountSnapshot {
  equity: number;
  cash: number;
  buyingPower: number;
  totalMarketValue: number;
  currency: "USD";
  accountBlocked: boolean;
  tradingBlocked: boolean;
  patternDayTrader: boolean;
  asOf: string; // ISO timestamp
}

export interface Position {
  symbol: string;
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
}

export interface Quote {
  symbol: string;
  price: number;
  asOf: string; // ISO timestamp
}

export interface Bar {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  limitPrice?: number | null;
  /** Equities use "day"; Alpaca crypto orders require "gtc". */
  timeInForce: "day" | "gtc";
}

export interface BrokerageOrder {
  brokerageOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  filledAvgPrice: number | null;
  limitPrice: number | null;
  status: OrderStatus;
  submittedAt: string;
  updatedAt: string;
  raw?: unknown;
}

export interface AssetInfo {
  symbol: string;
  name: string;
  tradable: boolean;
  assetClass: string;
  exchange: string;
  fractionable: boolean;
}

export interface MarketClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
  asOf: string;
}

export interface TradeProposal {
  id: string;
  environment: Environment;
  symbol: string;
  action: TradeAction;
  quantity: number;
  proposedNotional: number;
  orderType: OrderType;
  limitPrice: number | null;
  confidence: number;
  conciseReasoning: string;
  keyRisk: string;
  expiresAt: string;
  status: ProposalStatus;
  createdAt: string;
  /** Optional protective stop for BUY proposals, as % below entry (0.2–50). */
  stopLossPct?: number | null;
}

export interface StopRule {
  id: string;
  environment: Environment;
  symbol: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  sourceProposalId: string | null;
  status: "ACTIVE" | "TRIGGERED" | "CANCELED";
  createdAt: string;
}

export interface RiskCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RiskEvaluation {
  overallResult: "PASS" | "BLOCK";
  checks: RiskCheckResult[];
  blockReasons: string[];
  evaluatedAt: string;
}

export interface RiskLimits {
  environment: Environment;
  maxPositions: number;
  maxTotalExposurePct: number;
  maxSymbolExposurePct: number;
  /** For PAPER this is a % of equity; for LIVE this is an absolute dollar cap. */
  maxOrderNotional: number;
  maxOrderNotionalIsPct: boolean;
  maxTradesPerDay: number;
  /** Separate daily cap for crypto trades (crypto trades 24/7 and is exempt from the equity cap). */
  maxCryptoTradesPerDay: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  minSharePrice: number;
  maxLiveFundedBalance: number | null;
  marketHoursOnly: boolean;
  allowMargin: boolean;
  allowOptions: boolean;
  allowShorting: boolean;
  allowCrypto: boolean;
  allowLeveragedEtfs: boolean;
  allowInverseEtfs: boolean;
  allowOtc: boolean;
}

export interface ApprovedSymbol {
  symbol: string;
  displayName: string;
  assetClass: string;
  tradable: boolean;
  leveraged: boolean;
  inverse: boolean;
  otc: boolean;
  active: boolean;
}

export interface AppSettings {
  tradingMode: TradingMode;
  globalKillSwitch: boolean;
  stopNewOrders: boolean;
  maximumLiveFundedBalance: number;
  aiEvaluationFrequency: "DAILY" | "TWICE_DAILY" | "WEEKLY" | "MANUAL_ONLY";
}
