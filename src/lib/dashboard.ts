import "server-only";
// Server data loaders for dashboard pages. Read-only aggregation; never
// exposes credentials. Brokerage failures degrade gracefully to nulls so the
// UI can render with a connection warning instead of crashing.

import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { getConfigStatus, type ConfigStatus } from "@/lib/env";
import { getStore } from "@/lib/store";
import type {
  AccountSnapshot,
  AppSettings,
  ApprovedSymbol,
  MarketClock,
  Position,
  RiskLimits,
} from "@/lib/types";
import { modeToEnvironment, type Environment } from "@/lib/types";
import type {
  AuditEventRow,
  CronRunRow,
  HealthCheckRow,
  NotificationRow,
  PortfolioSnapshotRow,
  StoredOrder,
  StoredProposal,
  StoredRiskEvaluation,
} from "@/lib/store/types";

export interface DashboardData {
  settings: AppSettings;
  environment: Environment;
  account: AccountSnapshot | null;
  positions: Position[];
  marketClock: MarketClock | null;
  brokerageError: string | null;
  snapshots: PortfolioSnapshotRow[];
  openOrders: StoredOrder[];
  recentOrders: StoredOrder[];
  pendingProposals: StoredProposal[];
  blockedProposals: StoredProposal[];
  notifications: NotificationRow[];
}

export async function getDashboardData(): Promise<DashboardData> {
  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);

  let account: AccountSnapshot | null = null;
  let positions: Position[] = [];
  let marketClock: MarketClock | null = null;
  let brokerageError: string | null = null;
  try {
    const brokerage = getBrokerageClient(settings.tradingMode);
    const marketData = getMarketDataClient(settings.tradingMode);
    [account, positions, marketClock] = await Promise.all([
      brokerage.getAccount(),
      brokerage.getPositions(),
      marketData.getMarketClock(),
    ]);
  } catch (error) {
    brokerageError = error instanceof Error ? error.message.slice(0, 300) : "Brokerage unavailable";
  }

  const [snapshots, openOrders, recentOrders, pendingProposals, blockedProposals, notifications] =
    await Promise.all([
      store.listSnapshots(environment, 365),
      store.listOrders({ environment, openOnly: true, limit: 20 }),
      store.listOrders({ environment, limit: 15 }),
      store.listProposals({ environment, statuses: ["AWAITING_APPROVAL"], limit: 20 }),
      store.listProposals({ environment, statuses: ["BLOCKED"], limit: 10 }),
      store.listNotifications(10),
    ]);

  return {
    settings,
    environment,
    account,
    positions,
    marketClock,
    brokerageError,
    snapshots,
    openOrders,
    recentOrders,
    pendingProposals,
    blockedProposals,
    notifications,
  };
}

export interface ActivityData {
  settings: AppSettings;
  proposals: StoredProposal[];
  orders: StoredOrder[];
  evaluationsByProposal: Record<string, StoredRiskEvaluation[]>;
  auditEvents: AuditEventRow[];
}

export async function getActivityData(): Promise<ActivityData> {
  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);
  const [proposals, orders, auditEvents] = await Promise.all([
    store.listProposals({ environment, limit: 100 }),
    store.listOrders({ environment, limit: 100 }),
    store.listAuditEvents(100),
  ]);
  const evaluationsByProposal: Record<string, StoredRiskEvaluation[]> = {};
  await Promise.all(
    proposals.slice(0, 40).map(async (p) => {
      evaluationsByProposal[p.id] = await store.getRiskEvaluationsForProposal(p.id);
    }),
  );
  return { settings, proposals, orders, evaluationsByProposal, auditEvents };
}

export interface SettingsData {
  settings: AppSettings;
  config: ConfigStatus;
  limits: { mock: RiskLimits; paper: RiskLimits; live: RiskLimits };
  symbols: ApprovedSymbol[];
  auditEvents: AuditEventRow[];
  cronRuns: CronRunRow[];
  healthChecks: HealthCheckRow[];
}

export async function getSettingsData(): Promise<SettingsData> {
  const store = await getStore();
  const [settings, mock, paper, live, symbols, auditEvents, cronRuns, healthChecks] =
    await Promise.all([
      store.getSettings(),
      store.getRiskLimits("MOCK"),
      store.getRiskLimits("PAPER"),
      store.getRiskLimits("LIVE"),
      store.getApprovedSymbols(),
      store.listAuditEvents(50),
      store.listCronRuns(20),
      store.listHealthChecks(10),
    ]);
  return {
    settings,
    config: getConfigStatus(),
    limits: { mock, paper, live },
    symbols,
    auditEvents,
    cronRuns,
    healthChecks,
  };
}

export interface PerformanceData {
  settings: AppSettings;
  byEnvironment: Record<Environment, PortfolioSnapshotRow[]>;
  ordersByEnvironment: Record<Environment, StoredOrder[]>;
  positions: Position[];
}

export async function getPerformanceData(): Promise<PerformanceData> {
  const store = await getStore();
  const settings = await store.getSettings();
  const [mock, paper, live, mockOrders, paperOrders, liveOrders] = await Promise.all([
    store.listSnapshots("MOCK", 365),
    store.listSnapshots("PAPER", 365),
    store.listSnapshots("LIVE", 365),
    store.listOrders({ environment: "MOCK", limit: 200 }),
    store.listOrders({ environment: "PAPER", limit: 200 }),
    store.listOrders({ environment: "LIVE", limit: 200 }),
  ]);
  let positions: Position[] = [];
  try {
    positions = await getBrokerageClient(settings.tradingMode).getPositions();
  } catch {
    positions = [];
  }
  return {
    settings,
    byEnvironment: { MOCK: mock, PAPER: paper, LIVE: live },
    ordersByEnvironment: { MOCK: mockOrders, PAPER: paperOrders, LIVE: liveOrders },
    positions,
  };
}

export interface PositionsData {
  settings: AppSettings;
  positions: Position[];
  account: AccountSnapshot | null;
  orders: StoredOrder[];
  proposals: StoredProposal[];
  brokerageError: string | null;
}

export async function getPositionsData(): Promise<PositionsData> {
  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);
  let positions: Position[] = [];
  let account: AccountSnapshot | null = null;
  let brokerageError: string | null = null;
  try {
    const brokerage = getBrokerageClient(settings.tradingMode);
    [positions, account] = await Promise.all([brokerage.getPositions(), brokerage.getAccount()]);
  } catch (error) {
    brokerageError = error instanceof Error ? error.message.slice(0, 300) : "Brokerage unavailable";
  }
  const [orders, proposals] = await Promise.all([
    store.listOrders({ environment, limit: 200 }),
    store.listProposals({ environment, limit: 100 }),
  ]);
  return { settings, positions, account, orders, proposals, brokerageError };
}
