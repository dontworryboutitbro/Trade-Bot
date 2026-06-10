import "server-only";
// Supabase-backed Store. All writes use the service-role client and are only
// reachable from server routes that have already authorized the caller.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AppSettings,
  ApprovedSymbol,
  Environment,
  ProposalStatus,
  RiskLimits,
} from "@/lib/types";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import type {
  AuditEventRow,
  CronRunRow,
  HealthCheckRow,
  NewProposalInput,
  NotificationRow,
  PortfolioSnapshotRow,
  Store,
  StoredOrder,
  StoredProposal,
  StoredRiskEvaluation,
  TradeApprovalRow,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapProposal(row: any): StoredProposal {
  return {
    id: row.id,
    environment: row.environment,
    symbol: row.symbol,
    action: row.action,
    quantity: Number(row.quantity),
    proposedNotional: Number(row.proposed_notional),
    orderType: row.order_type,
    limitPrice: row.limit_price === null ? null : Number(row.limit_price),
    confidence: Number(row.confidence),
    conciseReasoning: row.concise_reasoning,
    keyRisk: row.key_risk,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrder(row: any): StoredOrder {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    environment: row.environment,
    clientOrderId: row.client_order_id,
    brokerageOrderId: row.brokerage_order_id,
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type,
    quantity: Number(row.quantity),
    notional: row.notional === null ? null : Number(row.notional),
    limitPrice: row.limit_price === null ? null : Number(row.limit_price),
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    filledQuantity: Number(row.filled_quantity ?? 0),
    filledAvgPrice: row.filled_avg_price === null ? null : Number(row.filled_avg_price),
    raw: row.raw_brokerage_payload,
  };
}

const OPEN_ORDER_STATUSES = ["NEW", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"];

export class SupabaseStore implements Store {
  readonly label = "Supabase store";
  private db: SupabaseClient;

  constructor() {
    this.db = getSupabaseAdminClient();
  }

  private async one<T>(query: PromiseLike<{ data: T | null; error: any }>): Promise<T> {
    const { data, error } = await query;
    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (data === null) throw new Error("Supabase: expected a row, got none");
    return data;
  }

  private async many<T>(query: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return data ?? [];
  }

  private async run(query: PromiseLike<{ error: any }>): Promise<void> {
    const { error } = await query;
    if (error) throw new Error(`Supabase error: ${error.message}`);
  }

  async getSettings(): Promise<AppSettings> {
    const row = await this.one<any>(
      this.db.from("app_settings").select("*").eq("id", 1).single(),
    );
    return {
      tradingMode: row.trading_mode,
      globalKillSwitch: row.global_kill_switch,
      stopNewOrders: row.stop_new_orders,
      maximumLiveFundedBalance: Number(row.maximum_live_funded_balance),
      aiEvaluationFrequency: row.ai_evaluation_frequency,
    };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.tradingMode !== undefined) update.trading_mode = patch.tradingMode;
    if (patch.globalKillSwitch !== undefined) update.global_kill_switch = patch.globalKillSwitch;
    if (patch.stopNewOrders !== undefined) update.stop_new_orders = patch.stopNewOrders;
    if (patch.maximumLiveFundedBalance !== undefined)
      update.maximum_live_funded_balance = patch.maximumLiveFundedBalance;
    if (patch.aiEvaluationFrequency !== undefined)
      update.ai_evaluation_frequency = patch.aiEvaluationFrequency;
    await this.run(this.db.from("app_settings").update(update).eq("id", 1));
    return this.getSettings();
  }

  async getRiskLimits(environment: Environment): Promise<RiskLimits> {
    const row = await this.one<any>(
      this.db
        .from("risk_profiles")
        .select("*")
        .eq("environment", environment)
        .eq("active", true)
        .single(),
    );
    return {
      environment,
      maxPositions: row.max_positions,
      maxTotalExposurePct: Number(row.max_total_exposure_pct),
      maxSymbolExposurePct: Number(row.max_symbol_exposure_pct),
      maxOrderNotional: Number(row.max_order_notional),
      maxOrderNotionalIsPct: row.max_order_notional_is_pct,
      maxTradesPerDay: row.max_trades_per_day,
      maxDailyLossPct: Number(row.max_daily_loss_pct),
      maxDrawdownPct: Number(row.max_drawdown_pct),
      minSharePrice: Number(row.min_share_price),
      maxLiveFundedBalance:
        row.max_live_funded_balance === null ? null : Number(row.max_live_funded_balance),
      marketHoursOnly: row.market_hours_only,
      allowMargin: row.allow_margin,
      allowOptions: row.allow_options,
      allowShorting: row.allow_shorting,
      allowCrypto: row.allow_crypto,
      allowLeveragedEtfs: row.allow_leveraged_etfs,
      allowInverseEtfs: row.allow_inverse_etfs,
      allowOtc: row.allow_otc,
    };
  }

  async updateRiskLimits(
    environment: Environment,
    next: RiskLimits,
    changedBy: string,
    reason: string,
  ): Promise<void> {
    const current = await this.one<any>(
      this.db
        .from("risk_profiles")
        .select("*")
        .eq("environment", environment)
        .eq("active", true)
        .single(),
    );
    await this.run(
      this.db
        .from("risk_profiles")
        .update({
          max_positions: next.maxPositions,
          max_total_exposure_pct: next.maxTotalExposurePct,
          max_symbol_exposure_pct: next.maxSymbolExposurePct,
          max_order_notional: next.maxOrderNotional,
          max_order_notional_is_pct: next.maxOrderNotionalIsPct,
          max_trades_per_day: next.maxTradesPerDay,
          max_daily_loss_pct: next.maxDailyLossPct,
          max_drawdown_pct: next.maxDrawdownPct,
          min_share_price: next.minSharePrice,
          max_live_funded_balance: next.maxLiveFundedBalance,
          market_hours_only: next.marketHoursOnly,
          updated_at: new Date().toISOString(),
        })
        .eq("id", current.id),
    );
    await this.run(
      this.db.from("risk_profile_change_log").insert({
        risk_profile_id: current.id,
        changed_by: changedBy,
        previous_values: current,
        updated_values: next as unknown as Record<string, unknown>,
        reason,
      }),
    );
  }

  async getApprovedSymbols(): Promise<ApprovedSymbol[]> {
    const rows = await this.many<any>(
      this.db.from("approved_symbols").select("*").order("symbol"),
    );
    return rows.map((row) => ({
      symbol: row.symbol,
      displayName: row.display_name,
      assetClass: row.asset_class,
      tradable: row.tradable,
      leveraged: row.leveraged,
      inverse: row.inverse,
      otc: row.otc,
      active: row.active,
    }));
  }

  async upsertApprovedSymbol(
    symbol: ApprovedSymbol & { validationDetails?: unknown },
  ): Promise<void> {
    await this.run(
      this.db.from("approved_symbols").upsert(
        {
          symbol: symbol.symbol,
          display_name: symbol.displayName,
          asset_class: symbol.assetClass,
          tradable: symbol.tradable,
          leveraged: symbol.leveraged,
          inverse: symbol.inverse,
          otc: symbol.otc,
          active: symbol.active,
          validation_status: symbol.tradable ? "VALIDATED" : "REJECTED",
          validation_details: symbol.validationDetails ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      ),
    );
  }

  async setSymbolActive(symbol: string, active: boolean): Promise<void> {
    await this.run(
      this.db
        .from("approved_symbols")
        .update({ active, updated_at: new Date().toISOString() })
        .eq("symbol", symbol),
    );
  }

  async createProposal(input: NewProposalInput): Promise<StoredProposal> {
    const row = await this.one<any>(
      this.db
        .from("trade_proposals")
        .insert({
          environment: input.environment,
          symbol: input.symbol,
          action: input.action,
          quantity: input.quantity,
          proposed_notional: input.proposedNotional,
          order_type: input.orderType,
          limit_price: input.limitPrice,
          confidence: input.confidence,
          concise_reasoning: input.conciseReasoning,
          key_risk: input.keyRisk,
          expires_at: input.expiresAt,
          status: input.status,
        })
        .select()
        .single(),
    );
    return mapProposal(row);
  }

  async getProposal(id: string): Promise<StoredProposal | null> {
    const { data, error } = await this.db
      .from("trade_proposals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return data ? mapProposal(data) : null;
  }

  async listProposals(filter?: {
    environment?: Environment;
    statuses?: ProposalStatus[];
    limit?: number;
  }): Promise<StoredProposal[]> {
    let query = this.db
      .from("trade_proposals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(filter?.limit ?? 100);
    if (filter?.environment) query = query.eq("environment", filter.environment);
    if (filter?.statuses) query = query.in("status", filter.statuses);
    const rows = await this.many<any>(query);
    return rows.map(mapProposal);
  }

  async updateProposalStatus(id: string, status: ProposalStatus): Promise<void> {
    await this.run(
      this.db
        .from("trade_proposals")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id),
    );
  }

  async expireStaleProposals(now: string): Promise<number> {
    const { data, error } = await this.db
      .from("trade_proposals")
      .update({ status: "EXPIRED", updated_at: now })
      .in("status", ["PENDING_RISK", "AWAITING_APPROVAL", "QUEUED"])
      .lt("expires_at", now)
      .select("id");
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return data?.length ?? 0;
  }

  async saveRiskEvaluation(evaluation: Omit<StoredRiskEvaluation, "id">): Promise<void> {
    await this.run(
      this.db.from("risk_evaluations").insert({
        proposal_id: evaluation.proposalId,
        evaluated_at: evaluation.evaluatedAt,
        overall_result: evaluation.overallResult,
        account_snapshot: evaluation.accountSnapshot,
        market_snapshot: evaluation.marketSnapshot,
        risk_profile_snapshot: evaluation.riskProfileSnapshot,
        checks: evaluation.checks,
        block_reasons: evaluation.blockReasons,
      }),
    );
  }

  async getRiskEvaluationsForProposal(proposalId: string): Promise<StoredRiskEvaluation[]> {
    const rows = await this.many<any>(
      this.db
        .from("risk_evaluations")
        .select("*")
        .eq("proposal_id", proposalId)
        .order("evaluated_at", { ascending: false }),
    );
    return rows.map((row) => ({
      id: row.id,
      proposalId: row.proposal_id,
      overallResult: row.overall_result,
      checks: row.checks,
      blockReasons: row.block_reasons,
      evaluatedAt: row.evaluated_at,
      accountSnapshot: row.account_snapshot,
      marketSnapshot: row.market_snapshot,
      riskProfileSnapshot: row.risk_profile_snapshot,
    }));
  }

  async saveApproval(approval: Omit<TradeApprovalRow, "id">): Promise<void> {
    await this.run(
      this.db.from("trade_approvals").insert({
        proposal_id: approval.proposalId,
        decision: approval.decision,
        decided_by: approval.decidedBy,
        reason: approval.reason,
        decided_at: approval.decidedAt,
      }),
    );
  }

  async createOrder(order: Omit<StoredOrder, "id">): Promise<StoredOrder> {
    const row = await this.one<any>(
      this.db
        .from("brokerage_orders")
        .insert({
          proposal_id: order.proposalId,
          environment: order.environment,
          client_order_id: order.clientOrderId,
          brokerage_order_id: order.brokerageOrderId,
          symbol: order.symbol,
          side: order.side,
          order_type: order.orderType,
          quantity: order.quantity,
          notional: order.notional,
          limit_price: order.limitPrice,
          status: order.status,
          filled_quantity: order.filledQuantity,
          filled_avg_price: order.filledAvgPrice,
          submitted_at: order.submittedAt,
          updated_at: order.updatedAt,
          raw_brokerage_payload: order.raw ?? null,
        })
        .select()
        .single(),
    );
    return mapOrder(row);
  }

  async updateOrder(id: string, patch: Partial<StoredOrder>): Promise<void> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.brokerageOrderId !== undefined) update.brokerage_order_id = patch.brokerageOrderId;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.filledQuantity !== undefined) update.filled_quantity = patch.filledQuantity;
    if (patch.filledAvgPrice !== undefined) update.filled_avg_price = patch.filledAvgPrice;
    if (patch.notional !== undefined) update.notional = patch.notional;
    if (patch.raw !== undefined) update.raw_brokerage_payload = patch.raw;
    await this.run(this.db.from("brokerage_orders").update(update).eq("id", id));
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<StoredOrder | null> {
    const { data, error } = await this.db
      .from("brokerage_orders")
      .select("*")
      .eq("client_order_id", clientOrderId)
      .maybeSingle();
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return data ? mapOrder(data) : null;
  }

  async listOrders(filter?: {
    environment?: Environment;
    openOnly?: boolean;
    limit?: number;
  }): Promise<StoredOrder[]> {
    let query = this.db
      .from("brokerage_orders")
      .select("*")
      .order("submitted_at", { ascending: false })
      .limit(filter?.limit ?? 100);
    if (filter?.environment) query = query.eq("environment", filter.environment);
    if (filter?.openOnly) query = query.in("status", OPEN_ORDER_STATUSES);
    const rows = await this.many<any>(query);
    return rows.map(mapOrder);
  }

  async countExecutedTradesToday(environment: Environment, dayStartIso: string): Promise<number> {
    const { count, error } = await this.db
      .from("brokerage_orders")
      .select("id", { count: "exact", head: true })
      .eq("environment", environment)
      .gte("submitted_at", dayStartIso)
      .in("status", ["FILLED", "PARTIALLY_FILLED", "SUBMITTED", "ACCEPTED"]);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return count ?? 0;
  }

  async hasOrderForProposal(proposalId: string): Promise<boolean> {
    const { count, error } = await this.db
      .from("brokerage_orders")
      .select("id", { count: "exact", head: true })
      .eq("proposal_id", proposalId);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async hasOpenEquivalentOrder(
    environment: Environment,
    symbol: string,
    side: "buy" | "sell",
  ): Promise<boolean> {
    const { count, error } = await this.db
      .from("brokerage_orders")
      .select("id", { count: "exact", head: true })
      .eq("environment", environment)
      .eq("symbol", symbol)
      .eq("side", side)
      .in("status", OPEN_ORDER_STATUSES);
    if (error) throw new Error(`Supabase error: ${error.message}`);
    return (count ?? 0) > 0;
  }

  async saveSnapshot(snapshot: Omit<PortfolioSnapshotRow, "id">): Promise<void> {
    await this.run(
      this.db.from("portfolio_snapshots").insert({
        environment: snapshot.environment,
        captured_at: snapshot.capturedAt,
        equity: snapshot.equity,
        cash: snapshot.cash,
        buying_power: snapshot.buyingPower,
        total_market_value: snapshot.totalMarketValue,
        daily_return_pct: snapshot.dailyReturnPct,
        total_return_pct: snapshot.totalReturnPct,
        drawdown_pct: snapshot.drawdownPct,
        benchmark_value: snapshot.benchmarkValue,
        benchmark_return_pct: snapshot.benchmarkReturnPct,
      }),
    );
  }

  async listSnapshots(environment: Environment, limit = 365): Promise<PortfolioSnapshotRow[]> {
    const rows = await this.many<any>(
      this.db
        .from("portfolio_snapshots")
        .select("*")
        .eq("environment", environment)
        .order("captured_at", { ascending: false })
        .limit(limit),
    );
    return rows.reverse().map((row) => ({
      id: row.id,
      environment: row.environment,
      capturedAt: row.captured_at,
      equity: Number(row.equity),
      cash: Number(row.cash),
      buyingPower: Number(row.buying_power),
      totalMarketValue: Number(row.total_market_value),
      dailyReturnPct: Number(row.daily_return_pct),
      totalReturnPct: Number(row.total_return_pct),
      drawdownPct: Number(row.drawdown_pct),
      benchmarkValue: row.benchmark_value === null ? null : Number(row.benchmark_value),
      benchmarkReturnPct:
        row.benchmark_return_pct === null ? null : Number(row.benchmark_return_pct),
    }));
  }

  async createNotification(input: {
    notificationType: string;
    severity: NotificationRow["severity"];
    title: string;
    message: string;
  }): Promise<void> {
    await this.run(
      this.db.from("notifications").insert({
        notification_type: input.notificationType,
        severity: input.severity,
        title: input.title,
        message: input.message,
        delivery_status: "DELIVERED",
        delivered_at: new Date().toISOString(),
      }),
    );
  }

  async listNotifications(limit = 50): Promise<NotificationRow[]> {
    const rows = await this.many<any>(
      this.db
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      notificationType: row.notification_type,
      severity: row.severity,
      title: row.title,
      message: row.message,
      deliveryStatus: row.delivery_status,
      createdAt: row.created_at,
    }));
  }

  async createAuditEvent(input: Omit<AuditEventRow, "id" | "createdAt">): Promise<void> {
    await this.run(
      this.db.from("audit_events").insert({
        actor_type: input.actorType,
        actor_id: input.actorId,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId,
        severity: input.severity,
        summary: input.summary,
        metadata: input.metadata ?? null,
      }),
    );
  }

  async listAuditEvents(limit = 100): Promise<AuditEventRow[]> {
    const rows = await this.many<any>(
      this.db
        .from("audit_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      severity: row.severity,
      summary: row.summary,
      metadata: row.metadata,
      createdAt: row.created_at,
    }));
  }

  async tryStartCronRun(jobName: string, idempotencyKey: string): Promise<CronRunRow | null> {
    // Unique (job_name, idempotency_key) constraint makes duplicate triggers a
    // safe no-op: the insert fails with 23505 and we return null.
    const { data, error } = await this.db
      .from("cron_runs")
      .insert({ job_name: jobName, idempotency_key: idempotencyKey })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return null;
      throw new Error(`Supabase error: ${error.message}`);
    }
    return {
      id: data.id,
      jobName: data.job_name,
      idempotencyKey: data.idempotency_key,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      status: data.status,
      details: data.details,
    };
  }

  async finishCronRun(id: string, status: CronRunRow["status"], details: unknown): Promise<void> {
    await this.run(
      this.db
        .from("cron_runs")
        .update({ status, details, completed_at: new Date().toISOString() })
        .eq("id", id),
    );
  }

  async listCronRuns(limit = 50): Promise<CronRunRow[]> {
    const rows = await this.many<any>(
      this.db.from("cron_runs").select("*").order("started_at", { ascending: false }).limit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      jobName: row.job_name,
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status,
      details: row.details,
    }));
  }

  async saveHealthCheck(input: Omit<HealthCheckRow, "id">): Promise<void> {
    await this.run(
      this.db.from("system_health_checks").insert({
        check_name: input.checkName,
        environment: input.environment,
        status: input.status,
        details: input.details,
        checked_at: input.checkedAt,
      }),
    );
  }

  async listHealthChecks(limit = 50): Promise<HealthCheckRow[]> {
    const rows = await this.many<any>(
      this.db
        .from("system_health_checks")
        .select("*")
        .order("checked_at", { ascending: false })
        .limit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      checkName: row.check_name,
      environment: row.environment,
      status: row.status,
      details: row.details,
      checkedAt: row.checked_at,
    }));
  }
}

export { randomUUID };
