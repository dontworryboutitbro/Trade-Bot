import type {
  AppSettings,
  ApprovedSymbol,
  Environment,
  OrderType,
  ProposalStatus,
  RiskEvaluation,
  RiskLimits,
  Severity,
  StopRule,
  TradeAction,
  TradeProposal,
} from "@/lib/types";

export interface StoredProposal extends TradeProposal {
  updatedAt: string;
}

export interface StoredOrder {
  id: string;
  proposalId: string | null;
  environment: Environment;
  clientOrderId: string;
  brokerageOrderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  orderType: OrderType;
  quantity: number;
  notional: number | null;
  limitPrice: number | null;
  status: string;
  submittedAt: string;
  updatedAt: string;
  filledQuantity: number;
  filledAvgPrice: number | null;
  raw?: unknown;
}

export interface StoredRiskEvaluation extends RiskEvaluation {
  id: string;
  proposalId: string;
  accountSnapshot: unknown;
  marketSnapshot: unknown;
  riskProfileSnapshot: unknown;
}

export interface PortfolioSnapshotRow {
  id: string;
  environment: Environment;
  capturedAt: string;
  equity: number;
  cash: number;
  buyingPower: number;
  totalMarketValue: number;
  dailyReturnPct: number;
  totalReturnPct: number;
  drawdownPct: number;
  benchmarkValue: number | null;
  benchmarkReturnPct: number | null;
}

export interface NotificationRow {
  id: string;
  notificationType: string;
  severity: Severity;
  title: string;
  message: string;
  deliveryStatus: string;
  createdAt: string;
}

export interface AuditEventRow {
  id: string;
  actorType: "USER" | "SYSTEM" | "AI" | "CRON";
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  severity: Severity;
  summary: string;
  metadata: unknown;
  createdAt: string;
}

export interface TradeApprovalRow {
  id: string;
  proposalId: string;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
  reason: string | null;
  decidedAt: string;
}

export interface CronRunRow {
  id: string;
  jobName: string;
  idempotencyKey: string;
  startedAt: string;
  completedAt: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED_DUPLICATE";
  details: unknown;
}

export interface HealthCheckRow {
  id: string;
  checkName: string;
  environment: Environment;
  status: "OK" | "DEGRADED" | "FAILED";
  details: string;
  checkedAt: string;
}

export interface JournalEntryRow {
  id: string;
  environment: Environment;
  proposalId: string | null;
  orderId: string | null;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  strategyId: string | null;
  regime: string | null;
  confidence: number | null;
  thesis: string | null;
  counterargument: string | null;
  invalidationCondition: string | null;
  quoteSnapshot: unknown;
  costEstimate: unknown;
  fillPrice: number | null;
  dataQualityOk: boolean;
  rulesFollowed: boolean;
  lessons: string | null;
  createdAt: string;
}

export interface NewProposalInput {
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
  stopLossPct?: number | null;
  strategyId?: string | null;
  counterargument?: string | null;
  invalidationCondition?: string | null;
  intendedHoldingDays?: number | null;
  regimeAtCreation?: string | null;
}

/**
 * Persistence boundary. MemoryStore backs zero-credential MOCK mode;
 * SupabaseStore backs everything once Supabase is configured.
 */
export interface Store {
  readonly label: string;

  // settings
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  // risk limits
  getRiskLimits(environment: Environment): Promise<RiskLimits>;
  updateRiskLimits(
    environment: Environment,
    next: RiskLimits,
    changedBy: string,
    reason: string,
  ): Promise<void>;

  // approved symbols
  getApprovedSymbols(): Promise<ApprovedSymbol[]>;
  upsertApprovedSymbol(symbol: ApprovedSymbol & { validationDetails?: unknown }): Promise<void>;
  setSymbolActive(symbol: string, active: boolean): Promise<void>;

  // proposals
  createProposal(input: NewProposalInput): Promise<StoredProposal>;
  getProposal(id: string): Promise<StoredProposal | null>;
  listProposals(filter?: {
    environment?: Environment;
    statuses?: ProposalStatus[];
    limit?: number;
  }): Promise<StoredProposal[]>;
  updateProposalStatus(id: string, status: ProposalStatus): Promise<void>;
  expireStaleProposals(now: string): Promise<number>;

  // risk evaluations
  saveRiskEvaluation(evaluation: Omit<StoredRiskEvaluation, "id">): Promise<void>;
  getRiskEvaluationsForProposal(proposalId: string): Promise<StoredRiskEvaluation[]>;

  // approvals
  saveApproval(approval: Omit<TradeApprovalRow, "id">): Promise<void>;

  // orders
  createOrder(order: Omit<StoredOrder, "id">): Promise<StoredOrder>;
  updateOrder(id: string, patch: Partial<StoredOrder>): Promise<void>;
  getOrderByClientOrderId(clientOrderId: string): Promise<StoredOrder | null>;
  listOrders(filter?: {
    environment?: Environment;
    openOnly?: boolean;
    limit?: number;
  }): Promise<StoredOrder[]>;
  countExecutedTradesToday(
    environment: Environment,
    dayStartIso: string,
    kind: "equity" | "crypto",
  ): Promise<number>;
  hasOrderForProposal(proposalId: string): Promise<boolean>;
  hasOpenEquivalentOrder(
    environment: Environment,
    symbol: string,
    side: "buy" | "sell",
  ): Promise<boolean>;

  // paper-trade journal
  createJournalEntry(entry: Omit<JournalEntryRow, "id" | "createdAt">): Promise<void>;
  listJournalEntries(filter?: {
    environment?: Environment;
    strategyId?: string;
    limit?: number;
  }): Promise<JournalEntryRow[]>;

  // learning engine (generic, whitelisted tables — see src/lib/learning/types.ts)
  putLearningRecord(
    table: string,
    keys: Record<string, string | null>,
    payload: unknown,
  ): Promise<string>;
  listLearningRecords(
    table: string,
    filter?: { keys?: Record<string, string>; limit?: number; sinceIso?: string },
  ): Promise<{ id: string; keys: Record<string, string | null>; payload: unknown; createdAt: string }[]>;
  updateLearningRecord(
    table: string,
    id: string,
    patch: { keys?: Record<string, string | null>; payload?: unknown },
  ): Promise<void>;

  // backtests
  saveBacktestRun(run: {
    strategyId: string;
    config: unknown;
    startDate: string;
    endDate: string;
    metrics: unknown;
    walkForward: unknown;
    warnings: string[];
  }): Promise<void>;
  listBacktestRuns(limit?: number): Promise<
    {
      id: string;
      strategyId: string;
      startDate: string;
      endDate: string;
      metrics: unknown;
      walkForward: unknown;
      warnings: string[];
      createdAt: string;
    }[]
  >;

  // cross-market research history (optional capability)
  saveCrossMarketSnapshot?(row: unknown & { key: string; midpoint: number | null }): Promise<void>;
  listCrossMarketHistory?(key: string, days: number): Promise<number[]>;

  // stop rules
  createStopRule(rule: Omit<StopRule, "id" | "createdAt" | "status">): Promise<void>;
  listActiveStopRules(environment: Environment): Promise<StopRule[]>;
  updateStopRuleStatus(id: string, status: StopRule["status"]): Promise<void>;

  // snapshots
  saveSnapshot(snapshot: Omit<PortfolioSnapshotRow, "id">): Promise<void>;
  listSnapshots(environment: Environment, limit?: number): Promise<PortfolioSnapshotRow[]>;

  // notifications
  createNotification(input: {
    notificationType: string;
    severity: Severity;
    title: string;
    message: string;
  }): Promise<void>;
  listNotifications(limit?: number): Promise<NotificationRow[]>;

  // audit
  createAuditEvent(input: Omit<AuditEventRow, "id" | "createdAt">): Promise<void>;
  listAuditEvents(limit?: number): Promise<AuditEventRow[]>;

  // cron idempotency
  tryStartCronRun(jobName: string, idempotencyKey: string): Promise<CronRunRow | null>;
  finishCronRun(id: string, status: CronRunRow["status"], details: unknown): Promise<void>;
  listCronRuns(limit?: number): Promise<CronRunRow[]>;

  // health
  saveHealthCheck(input: Omit<HealthCheckRow, "id">): Promise<void>;
  listHealthChecks(limit?: number): Promise<HealthCheckRow[]>;
}
