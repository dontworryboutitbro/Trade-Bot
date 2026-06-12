// In-memory store backing zero-credential MOCK mode. Persisted on globalThis
// to survive dev HMR. Seeded with realistic demo data so the dashboard is
// fully explorable before any external service is configured.

import { randomUUID } from "node:crypto";
import type {
  AppSettings,
  ApprovedSymbol,
  Environment,
  ProposalStatus,
  RiskLimits,
  StopRule,
} from "@/lib/types";
import { defaultLimitsFor } from "@/lib/risk/defaults";
import { SEED_SYMBOLS } from "@/lib/config";
import type {
  AuditEventRow,
  CronRunRow,
  HealthCheckRow,
  JournalEntryRow,
  NewProposalInput,
  NotificationRow,
  PortfolioSnapshotRow,
  Store,
  StoredOrder,
  StoredProposal,
  StoredRiskEvaluation,
  TradeApprovalRow,
} from "./types";

interface MemoryData {
  settings: AppSettings;
  limits: Record<Environment, RiskLimits>;
  symbols: ApprovedSymbol[];
  proposals: StoredProposal[];
  evaluations: StoredRiskEvaluation[];
  approvals: TradeApprovalRow[];
  orders: StoredOrder[];
  snapshots: PortfolioSnapshotRow[];
  notifications: NotificationRow[];
  auditEvents: AuditEventRow[];
  cronRuns: CronRunRow[];
  healthChecks: HealthCheckRow[];
  stopRules: StopRule[];
  journal: JournalEntryRow[];
  crossMarketHistory: { key: string; midpoint: number | null; capturedAt: string }[];
  backtestRuns: {
    id: string;
    strategyId: string;
    startDate: string;
    endDate: string;
    metrics: unknown;
    walkForward: unknown;
    warnings: string[];
    createdAt: string;
  }[];
}

function daysAgo(n: number, hour = 21): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function seedData(): MemoryData {
  const symbols: ApprovedSymbol[] = SEED_SYMBOLS.map((s) => ({
    symbol: s.symbol,
    displayName: s.displayName,
    assetClass: "us_equity",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: false,
    active: true,
  }));

  // ~30 trading days of equity history. The curve is rescaled afterwards so it
  // ends at the mock brokerage's base equity — keeps the daily-loss and
  // drawdown risk checks consistent with the live-computed account value.
  const MOCK_BASE_EQUITY = 9947.5; // cash 7093.40 + seeded positions at base prices
  const snapshots: PortfolioSnapshotRow[] = [];
  let equity = 10000;
  let spy = 588.0;
  const spyStart = spy;
  let peak = equity;
  for (let i = 42; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const wiggle = Math.sin(i * 1.7) * 0.004 + 0.0009;
    const prevEquity = equity;
    equity = equity * (1 + wiggle);
    spy = spy * (1 + Math.sin(i * 1.4) * 0.0035 + 0.0006);
    peak = Math.max(peak, equity);
    const invested = equity * 0.29;
    snapshots.push({
      id: randomUUID(),
      environment: "MOCK",
      capturedAt: daysAgo(i),
      equity: Math.round(equity * 100) / 100,
      cash: Math.round((equity - invested) * 100) / 100,
      buyingPower: Math.round((equity - invested) * 100) / 100,
      totalMarketValue: Math.round(invested * 100) / 100,
      dailyReturnPct: Math.round(((equity - prevEquity) / prevEquity) * 10000) / 100,
      totalReturnPct: Math.round(((equity - 10000) / 10000) * 10000) / 100,
      drawdownPct: Math.round(((peak - equity) / peak) * 10000) / 100,
      benchmarkValue: Math.round(spy * 100) / 100,
      benchmarkReturnPct: Math.round(((spy - spyStart) / spyStart) * 10000) / 100,
    });
  }

  const finalEquity = snapshots[snapshots.length - 1]?.equity ?? MOCK_BASE_EQUITY;
  const scale = MOCK_BASE_EQUITY / finalEquity;
  for (const s of snapshots) {
    s.equity = Math.round(s.equity * scale * 100) / 100;
    s.cash = Math.round(s.cash * scale * 100) / 100;
    s.buyingPower = Math.round(s.buyingPower * scale * 100) / 100;
    s.totalMarketValue = Math.round(s.totalMarketValue * scale * 100) / 100;
  }

  // Sample executed trades with proposals + evaluations.
  const proposals: StoredProposal[] = [];
  const evaluations: StoredRiskEvaluation[] = [];
  const orders: StoredOrder[] = [];
  const approvals: TradeApprovalRow[] = [];

  const samples = [
    {
      symbol: "SPY",
      action: "BUY" as const,
      qty: 1,
      price: 596.2,
      confidence: 72,
      reasoning:
        "Core index exposure below target after cash inflow. SPY remains the cheapest broad-market entry; adding one share keeps allocation under the 10% symbol cap.",
      risk: "Broad-market drawdown would hit all holdings simultaneously.",
      day: 18,
    },
    {
      symbol: "QQQ",
      action: "BUY" as const,
      qty: 1,
      price: 518.4,
      confidence: 64,
      reasoning:
        "Tech momentum is positive over the trailing month and the portfolio has no growth tilt. One share keeps QQQ near a 5% allocation, inside every limit.",
      risk: "Concentrated mega-cap tech exposure amplifies rate-driven volatility.",
      day: 14,
    },
    {
      symbol: "SCHD",
      action: "BUY" as const,
      qty: 28,
      price: 27.9,
      confidence: 68,
      reasoning:
        "Dividend tilt diversifies the growth-heavy book. SCHD trades above the $10 minimum and 28 shares stay under the per-order notional cap.",
      risk: "Value/dividend factor can lag in momentum-led rallies.",
      day: 10,
    },
    {
      symbol: "XLV",
      action: "BUY" as const,
      qty: 6,
      price: 149.8,
      confidence: 61,
      reasoning:
        "Healthcare is the weakest-correlated sector to existing holdings; 6 shares add defensive ballast at roughly 9% allocation.",
      risk: "Policy headlines can hit healthcare independently of the market.",
      day: 6,
    },
  ];

  for (const s of samples) {
    const pid = randomUUID();
    const created = daysAgo(s.day, 15);
    proposals.push({
      id: pid,
      environment: "MOCK",
      symbol: s.symbol,
      action: s.action,
      quantity: s.qty,
      proposedNotional: Math.round(s.qty * s.price * 100) / 100,
      orderType: "MARKET",
      limitPrice: null,
      confidence: s.confidence,
      conciseReasoning: s.reasoning,
      keyRisk: s.risk,
      expiresAt: daysAgo(s.day, 19),
      status: "EXECUTED",
      createdAt: created,
      updatedAt: created,
    });
    evaluations.push({
      id: randomUUID(),
      proposalId: pid,
      overallResult: "PASS",
      checks: [
        { name: "kill_switch", passed: true, detail: "Kill switch is off." },
        { name: "symbol_approved", passed: true, detail: `${s.symbol} is on the active allowlist.` },
        { name: "sufficient_cash", passed: true, detail: "Cash covers order cost." },
        { name: "order_size", passed: true, detail: "Within per-order cap." },
      ],
      blockReasons: [],
      evaluatedAt: created,
      accountSnapshot: {},
      marketSnapshot: {},
      riskProfileSnapshot: {},
    });
    orders.push({
      id: randomUUID(),
      proposalId: pid,
      environment: "MOCK",
      clientOrderId: `seed-${s.symbol.toLowerCase()}-${s.day}`,
      brokerageOrderId: `mock-seed-${s.symbol}`,
      symbol: s.symbol,
      side: "buy",
      orderType: "MARKET",
      quantity: s.qty,
      notional: Math.round(s.qty * s.price * 100) / 100,
      limitPrice: null,
      status: "FILLED",
      submittedAt: daysAgo(s.day, 15),
      updatedAt: daysAgo(s.day, 15),
      filledQuantity: s.qty,
      filledAvgPrice: s.price,
    });
  }

  // One blocked proposal for the Activity page.
  const blockedId = randomUUID();
  proposals.push({
    id: blockedId,
    environment: "MOCK",
    symbol: "XLK",
    action: "BUY",
    quantity: 5,
    proposedNotional: 1228,
    orderType: "MARKET",
    limitPrice: null,
    confidence: 58,
    conciseReasoning:
      "Semis strength suggests adding tech sector exposure alongside QQQ for the momentum sleeve.",
    keyRisk: "Overlaps heavily with existing QQQ holding.",
    expiresAt: daysAgo(3, 19),
    status: "BLOCKED",
    createdAt: daysAgo(3, 15),
    updatedAt: daysAgo(3, 15),
  });
  evaluations.push({
    id: randomUUID(),
    proposalId: blockedId,
    overallResult: "BLOCK",
    checks: [
      { name: "kill_switch", passed: true, detail: "Kill switch is off." },
      { name: "symbol_approved", passed: true, detail: "XLK is on the active allowlist." },
      {
        name: "symbol_concentration",
        passed: false,
        detail: "Post-trade XLK allocation 12.1% exceeds 10%.",
      },
    ],
    blockReasons: ["symbol_concentration: Post-trade XLK allocation 12.1% exceeds 10%."],
    evaluatedAt: daysAgo(3, 15),
    accountSnapshot: {},
    marketSnapshot: {},
    riskProfileSnapshot: {},
  });

  const notifications: NotificationRow[] = [
    {
      id: randomUUID(),
      notificationType: "PROPOSAL_BLOCKED",
      severity: "WARNING",
      title: "Proposal blocked: XLK",
      message:
        "BUY 5 XLK was blocked by the risk engine: post-trade symbol allocation 12.1% would exceed the 10% cap.",
      deliveryStatus: "DELIVERED",
      createdAt: daysAgo(3, 15),
    },
    {
      id: randomUUID(),
      notificationType: "ORDER_FILLED",
      severity: "INFO",
      title: "Order filled: BUY 6 XLV",
      message: "Mock order filled at $149.80 (notional $898.80).",
      deliveryStatus: "DELIVERED",
      createdAt: daysAgo(6, 15),
    },
  ];

  const auditEvents: AuditEventRow[] = [
    {
      id: randomUUID(),
      actorType: "SYSTEM",
      actorId: null,
      action: "APP_INITIALIZED",
      entityType: null,
      entityId: null,
      severity: "INFO",
      summary: "Fable Fund Lab initialized in MOCK mode with seeded demo data.",
      metadata: {},
      createdAt: daysAgo(20, 12),
    },
  ];

  return {
    settings: {
      tradingMode: "MOCK",
      globalKillSwitch: false,
      stopNewOrders: false,
      maximumLiveFundedBalance: 1000,
      aiEvaluationFrequency: "DAILY",
    },
    limits: {
      MOCK: defaultLimitsFor("MOCK"),
      PAPER: defaultLimitsFor("PAPER"),
      LIVE: defaultLimitsFor("LIVE"),
    },
    symbols,
    proposals,
    evaluations,
    approvals,
    orders,
    snapshots,
    notifications,
    auditEvents,
    cronRuns: [],
    healthChecks: [],
    stopRules: [],
    journal: [],
    crossMarketHistory: [],
    backtestRuns: [],
  };
}

declare global {
  var __fableMemoryStore: MemoryData | undefined;
}

function data(): MemoryData {
  if (!globalThis.__fableMemoryStore) globalThis.__fableMemoryStore = seedData();
  return globalThis.__fableMemoryStore;
}

export function resetMemoryStore(): void {
  globalThis.__fableMemoryStore = seedData();
}

export class MemoryStore implements Store {
  readonly label = "In-memory store (mock)";

  async getSettings() {
    return { ...data().settings };
  }

  async updateSettings(patch: Partial<AppSettings>) {
    Object.assign(data().settings, patch);
    return { ...data().settings };
  }

  async getRiskLimits(environment: Environment) {
    return { ...data().limits[environment] };
  }

  async updateRiskLimits(environment: Environment, next: RiskLimits) {
    data().limits[environment] = { ...next, environment };
  }

  async getApprovedSymbols() {
    return data().symbols.map((s) => ({ ...s }));
  }

  async upsertApprovedSymbol(symbol: ApprovedSymbol) {
    const existing = data().symbols.find((s) => s.symbol === symbol.symbol);
    if (existing) Object.assign(existing, symbol);
    else data().symbols.push({ ...symbol });
  }

  async setSymbolActive(symbol: string, active: boolean) {
    const entry = data().symbols.find((s) => s.symbol === symbol);
    if (entry) entry.active = active;
  }

  async createProposal(input: NewProposalInput) {
    const now = new Date().toISOString();
    const proposal: StoredProposal = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    data().proposals.unshift(proposal);
    return { ...proposal };
  }

  async getProposal(id: string) {
    const found = data().proposals.find((p) => p.id === id);
    return found ? { ...found } : null;
  }

  async listProposals(filter?: {
    environment?: Environment;
    statuses?: ProposalStatus[];
    limit?: number;
  }) {
    let list = [...data().proposals];
    if (filter?.environment) list = list.filter((p) => p.environment === filter.environment);
    if (filter?.statuses) list = list.filter((p) => filter.statuses!.includes(p.status));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.slice(0, filter?.limit ?? 100).map((p) => ({ ...p }));
  }

  async updateProposalStatus(id: string, status: ProposalStatus) {
    const proposal = data().proposals.find((p) => p.id === id);
    if (proposal) {
      proposal.status = status;
      proposal.updatedAt = new Date().toISOString();
    }
  }

  async expireStaleProposals(now: string) {
    let count = 0;
    for (const p of data().proposals) {
      if (
        ["PENDING_RISK", "AWAITING_APPROVAL", "QUEUED"].includes(p.status) &&
        p.expiresAt < now
      ) {
        p.status = "EXPIRED";
        p.updatedAt = now;
        count++;
      }
    }
    return count;
  }

  async saveRiskEvaluation(evaluation: Omit<StoredRiskEvaluation, "id">) {
    data().evaluations.unshift({ id: randomUUID(), ...evaluation });
  }

  async getRiskEvaluationsForProposal(proposalId: string) {
    return data()
      .evaluations.filter((e) => e.proposalId === proposalId)
      .map((e) => ({ ...e }));
  }

  async saveApproval(approval: Omit<TradeApprovalRow, "id">) {
    data().approvals.unshift({ id: randomUUID(), ...approval });
  }

  async createOrder(order: Omit<StoredOrder, "id">) {
    const existing = data().orders.find((o) => o.clientOrderId === order.clientOrderId);
    if (existing) throw new Error(`Duplicate client_order_id ${order.clientOrderId}`);
    const stored: StoredOrder = { id: randomUUID(), ...order };
    data().orders.unshift(stored);
    return { ...stored };
  }

  async updateOrder(id: string, patch: Partial<StoredOrder>) {
    const order = data().orders.find((o) => o.id === id);
    if (order) Object.assign(order, patch, { updatedAt: new Date().toISOString() });
  }

  async getOrderByClientOrderId(clientOrderId: string) {
    const found = data().orders.find((o) => o.clientOrderId === clientOrderId);
    return found ? { ...found } : null;
  }

  async listOrders(filter?: { environment?: Environment; openOnly?: boolean; limit?: number }) {
    let list = [...data().orders];
    if (filter?.environment) list = list.filter((o) => o.environment === filter.environment);
    if (filter?.openOnly) {
      list = list.filter((o) =>
        ["NEW", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"].includes(o.status),
      );
    }
    list.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return list.slice(0, filter?.limit ?? 100).map((o) => ({ ...o }));
  }

  async countExecutedTradesToday(
    environment: Environment,
    dayStartIso: string,
    kind: "equity" | "crypto",
  ) {
    return data().orders.filter(
      (o) =>
        o.environment === environment &&
        o.submittedAt >= dayStartIso &&
        (kind === "crypto") === o.symbol.includes("/") &&
        ["FILLED", "PARTIALLY_FILLED", "SUBMITTED", "ACCEPTED"].includes(o.status),
    ).length;
  }

  async hasOrderForProposal(proposalId: string) {
    return data().orders.some((o) => o.proposalId === proposalId);
  }

  async hasOpenEquivalentOrder(environment: Environment, symbol: string, side: "buy" | "sell") {
    return data().orders.some(
      (o) =>
        o.environment === environment &&
        o.symbol === symbol &&
        o.side === side &&
        ["NEW", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"].includes(o.status),
    );
  }

  async createJournalEntry(entry: Omit<JournalEntryRow, "id" | "createdAt">) {
    data().journal.unshift({ id: randomUUID(), ...entry, createdAt: new Date().toISOString() });
  }

  async listJournalEntries(filter?: {
    environment?: Environment;
    strategyId?: string;
    limit?: number;
  }) {
    let list = [...data().journal];
    if (filter?.environment) list = list.filter((e) => e.environment === filter.environment);
    if (filter?.strategyId) list = list.filter((e) => e.strategyId === filter.strategyId);
    return list.slice(0, filter?.limit ?? 200).map((e) => ({ ...e }));
  }

  async saveBacktestRun(run: {
    strategyId: string;
    config: unknown;
    startDate: string;
    endDate: string;
    metrics: unknown;
    walkForward: unknown;
    warnings: string[];
  }) {
    data().backtestRuns.unshift({
      id: randomUUID(),
      strategyId: run.strategyId,
      startDate: run.startDate,
      endDate: run.endDate,
      metrics: run.metrics,
      walkForward: run.walkForward,
      warnings: run.warnings,
      createdAt: new Date().toISOString(),
    });
  }

  async listBacktestRuns(limit = 50) {
    return data().backtestRuns.slice(0, limit).map((r) => ({ ...r }));
  }

  async saveCrossMarketSnapshot(row: { key: string; midpoint: number | null }) {
    data().crossMarketHistory.push({
      key: row.key,
      midpoint: row.midpoint,
      capturedAt: new Date().toISOString(),
    });
  }

  async listCrossMarketHistory(key: string, days: number) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return data()
      .crossMarketHistory.filter((h) => h.key === key && h.capturedAt >= cutoff && h.midpoint !== null)
      .map((h) => h.midpoint as number);
  }

  async createStopRule(rule: Omit<StopRule, "id" | "createdAt" | "status">) {
    data().stopRules.unshift({
      id: randomUUID(),
      ...rule,
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
  }

  async listActiveStopRules(environment: Environment) {
    return data()
      .stopRules.filter((r) => r.environment === environment && r.status === "ACTIVE")
      .map((r) => ({ ...r }));
  }

  async updateStopRuleStatus(id: string, status: StopRule["status"]) {
    const rule = data().stopRules.find((r) => r.id === id);
    if (rule) rule.status = status;
  }

  async saveSnapshot(snapshot: Omit<PortfolioSnapshotRow, "id">) {
    data().snapshots.push({ id: randomUUID(), ...snapshot });
  }

  async listSnapshots(environment: Environment, limit = 365) {
    return data()
      .snapshots.filter((s) => s.environment === environment)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .slice(-limit)
      .map((s) => ({ ...s }));
  }

  async createNotification(input: {
    notificationType: string;
    severity: NotificationRow["severity"];
    title: string;
    message: string;
  }) {
    data().notifications.unshift({
      id: randomUUID(),
      ...input,
      deliveryStatus: "DELIVERED",
      createdAt: new Date().toISOString(),
    });
  }

  async listNotifications(limit = 50) {
    return data().notifications.slice(0, limit).map((n) => ({ ...n }));
  }

  async createAuditEvent(input: Omit<AuditEventRow, "id" | "createdAt">) {
    data().auditEvents.unshift({
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  async listAuditEvents(limit = 100) {
    return data().auditEvents.slice(0, limit).map((e) => ({ ...e }));
  }

  async tryStartCronRun(jobName: string, idempotencyKey: string) {
    const duplicate = data().cronRuns.find(
      (r) => r.jobName === jobName && r.idempotencyKey === idempotencyKey,
    );
    if (duplicate) return null;
    const run: CronRunRow = {
      id: randomUUID(),
      jobName,
      idempotencyKey,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "RUNNING",
      details: null,
    };
    data().cronRuns.unshift(run);
    return { ...run };
  }

  async finishCronRun(id: string, status: CronRunRow["status"], details: unknown) {
    const run = data().cronRuns.find((r) => r.id === id);
    if (run) {
      run.status = status;
      run.details = details;
      run.completedAt = new Date().toISOString();
    }
  }

  async listCronRuns(limit = 50) {
    return data().cronRuns.slice(0, limit).map((r) => ({ ...r }));
  }

  async saveHealthCheck(input: Omit<HealthCheckRow, "id">) {
    data().healthChecks.unshift({ id: randomUUID(), ...input });
  }

  async listHealthChecks(limit = 50) {
    return data().healthChecks.slice(0, limit).map((h) => ({ ...h }));
  }
}
