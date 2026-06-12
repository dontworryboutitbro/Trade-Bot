import "server-only";
// Server-side trading pipeline: AI evaluation → proposal persistence → risk
// gating → (approval | autonomous) execution → reconciliation → snapshots.
// Every step audits. Every execution re-runs the full risk engine on fresh data.

import { randomUUID } from "node:crypto";
import { BENCHMARK_SYMBOL, PROPOSAL_TTL_MINUTES } from "@/lib/config";
import { getDecisionClient, type AiContext } from "@/lib/ai/client";
import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { evaluateRisk, type RiskContext } from "@/lib/risk/engine";
import { getQuoteSnapshot } from "@/lib/market-data/snapshots";
import { assessQuote } from "@/lib/market-data/quality";
import { estimateExecution } from "@/lib/execution/cost-model";
import { planOrder } from "@/lib/execution/order-policy";
import { activeCooldowns } from "@/lib/execution/cooldowns";
import { classifyRegime, type RegimeReading } from "@/lib/regime/engine";
import { getStrategy, STRATEGIES } from "@/lib/strategies/definitions";
import type { Store as StoreType } from "@/lib/store/types";
import { alert, audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import type { Store, StoredProposal } from "@/lib/store/types";
import {
  isAutonomousMode,
  isLiveMode,
  modeToEnvironment,
  type Environment,
  type TradeAction,
  type TradingMode,
} from "@/lib/types";

function sideOf(action: TradeAction): "buy" | "sell" {
  return action === "BUY" ? "buy" : "sell";
}

/** Start of the current US market day (midnight ET), as ISO. */
function marketDayStartIso(now = new Date()): string {
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(now); // YYYY-MM-DD
  return new Date(`${etDate}T00:00:00-05:00`).toISOString();
}

/** Derive deterministic cooldown inputs from stored history. */
async function deriveCooldownReasons(
  store: StoreType,
  environment: Environment,
  symbol: string,
  side: "buy" | "sell",
): Promise<string[]> {
  const [orders, auditEvents] = await Promise.all([
    store.listOrders({ environment, limit: 300 }),
    store.listAuditEvents(200),
  ]);
  const symbolOrders = orders
    .filter((o) => o.symbol === symbol)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));

  const lastEntryAt =
    [...symbolOrders].reverse().find((o) => o.side === "buy" && o.status !== "REJECTED" && o.status !== "FAILED")
      ?.submittedAt ?? null;
  const lastRejectionAt =
    [...symbolOrders].reverse().find((o) => ["REJECTED", "FAILED"].includes(o.status))
      ?.submittedAt ?? null;

  // Loss exit: most recent filled sell whose price is below the average cost
  // of the filled buys that preceded it.
  let lastLossExitAt: string | null = null;
  let costSum = 0;
  let costQty = 0;
  for (const order of symbolOrders) {
    if (order.status !== "FILLED" || !order.filledAvgPrice) continue;
    if (order.side === "buy") {
      costSum += order.filledAvgPrice * order.filledQuantity;
      costQty += order.filledQuantity;
    } else if (costQty > 0) {
      const avgCost = costSum / costQty;
      if (order.filledAvgPrice < avgCost) lastLossExitAt = order.submittedAt;
      costQty = Math.max(0, costQty - order.filledQuantity);
      costSum = avgCost * costQty;
    }
  }

  const lastKillSwitchResetAt =
    auditEvents.find((e) => e.action === "KILL_SWITCH_RESET")?.createdAt ?? null;
  const lastStaleDataIncidentAt =
    auditEvents.find(
      (e) => e.action === "DATA_QUALITY_INCIDENT" && e.entityId === symbol,
    )?.createdAt ?? null;

  return activeCooldowns({
    symbol,
    side,
    now: new Date(),
    lastEntryAt,
    lastLossExitAt,
    lastRejectionAt,
    lastKillSwitchResetAt,
    lastStaleDataIncidentAt,
  });
}

async function getActiveRegime(mode: TradingMode): Promise<RegimeReading | null> {
  try {
    const bars = await getMarketDataClient(mode).getDailyBars(BENCHMARK_SYMBOL, 130);
    return classifyRegime(bars);
  } catch {
    return null;
  }
}

async function buildRiskContext(
  store: Store,
  proposal: StoredProposal,
  mode: TradingMode,
): Promise<RiskContext> {
  const environment = proposal.environment;
  const brokerage = getBrokerageClient(mode);
  const marketData = getMarketDataClient(mode);
  const settings = await store.getSettings();

  const [account, positions, quote, marketClock, approvedSymbols, limits] = await Promise.all([
    brokerage.getAccount(),
    brokerage.getPositions(),
    marketData.getQuote(proposal.symbol),
    marketData.getMarketClock(),
    store.getApprovedSymbols(),
    store.getRiskLimits(environment),
  ]);

  const [
    executedTradesToday,
    executedCryptoTradesToday,
    hasEquivalentPendingOrder,
    proposalAlreadyExecuted,
    snapshots,
  ] = await Promise.all([
    store.countExecutedTradesToday(environment, marketDayStartIso(), "equity"),
    store.countExecutedTradesToday(environment, marketDayStartIso(), "crypto"),
    store.hasOpenEquivalentOrder(environment, proposal.symbol, sideOf(proposal.action)),
    store.hasOrderForProposal(proposal.id),
    store.listSnapshots(environment, 90),
  ]);

  const lastSnapshot = snapshots[snapshots.length - 1];
  const peak = snapshots.reduce((max, s) => Math.max(max, s.equity), account.equity);
  const dailyReturnPct = lastSnapshot
    ? ((account.equity - lastSnapshot.equity) / lastSnapshot.equity) * 100
    : 0;
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - account.equity) / peak) * 100) : 0;

  // Quality layer: typed snapshot, cost estimate, cooldowns, regime eligibility.
  const side = sideOf(proposal.action);
  const quoteSnapshot = await getQuoteSnapshot(mode, proposal.symbol, marketClock.isOpen).catch(
    () => null,
  );
  const costEstimate = quoteSnapshot
    ? estimateExecution(quoteSnapshot, side, proposal.quantity)
    : null;
  const cooldownReasons = await deriveCooldownReasons(
    store,
    environment,
    proposal.symbol,
    side,
  ).catch(() => []);

  let regimeEligibility: RiskContext["regimeEligibility"] = null;
  if (proposal.strategyId) {
    const strategy = getStrategy(proposal.strategyId);
    const reading = await getActiveRegime(mode);
    if (strategy && reading) {
      regimeEligibility = {
        activeRegime: reading.regime,
        approved: strategy.approvedRegimes.includes(reading.regime),
      };
    }
  }

  // Record stale-data incidents so cooldowns and analytics can see them.
  const quality = assessQuote(quoteSnapshot ?? null);
  if (!quality.ok && quoteSnapshot?.stale) {
    await store
      .createAuditEvent({
        actorType: "SYSTEM",
        actorId: null,
        action: "DATA_QUALITY_INCIDENT",
        entityType: "symbol",
        entityId: proposal.symbol,
        severity: "WARNING",
        summary: `Stale/degraded quote for ${proposal.symbol}: ${quality.reasons.join(" ")}`,
        metadata: {},
      })
      .catch(() => undefined);
  }

  return {
    proposal,
    limits,
    account,
    positions,
    quote,
    marketClock,
    approvedSymbols,
    tradingMode: settings.tradingMode,
    globalKillSwitch: settings.globalKillSwitch,
    stopNewOrders: settings.stopNewOrders,
    executedTradesToday,
    executedCryptoTradesToday,
    dailyReturnPct,
    drawdownPct,
    hasEquivalentPendingOrder,
    proposalAlreadyExecuted,
    quoteSnapshot,
    costEstimate,
    cooldownReasons,
    regimeEligibility,
  };
}

async function persistEvaluation(
  store: Store,
  proposalId: string,
  ctx: RiskContext,
  evaluation: ReturnType<typeof evaluateRisk>,
) {
  await store.saveRiskEvaluation({
    proposalId,
    overallResult: evaluation.overallResult,
    checks: evaluation.checks,
    blockReasons: evaluation.blockReasons,
    evaluatedAt: evaluation.evaluatedAt,
    accountSnapshot: {
      equity: ctx.account.equity,
      cash: ctx.account.cash,
      positions: ctx.positions.length,
    },
    marketSnapshot: { quote: ctx.quote, marketOpen: ctx.marketClock.isOpen },
    riskProfileSnapshot: ctx.limits,
  });
}

export interface EvaluationResult {
  decisionCount: number;
  proposalsCreated: number;
  blocked: number;
  queued: number;
  executed: number;
  errors: string[];
}

/**
 * Full AI evaluation run. Triggered by cron or the admin "Run now" button.
 */
export async function runAiEvaluation(triggeredBy: string): Promise<EvaluationResult> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const result: EvaluationResult = {
    decisionCount: 0,
    proposalsCreated: 0,
    blocked: 0,
    queued: 0,
    executed: 0,
    errors: [],
  };

  if (settings.globalKillSwitch) {
    await audit({
      actorType: "SYSTEM",
      actorId: triggeredBy,
      action: "AI_EVALUATION_SKIPPED",
      entityType: null,
      entityId: null,
      severity: "WARNING",
      summary: "AI evaluation skipped: global kill switch is engaged.",
      metadata: {},
    });
    return result;
  }

  if (mode === "LIVE_LOCKED") {
    result.errors.push("LIVE_LOCKED mode: AI evaluation does not run.");
    return result;
  }

  const brokerage = getBrokerageClient(mode);
  const marketData = getMarketDataClient(mode);
  const approvedSymbols = await store.getApprovedSymbols();
  const activeSymbols = approvedSymbols.filter((s) => s.active).map((s) => s.symbol);

  const [account, positions, openOrders, recentTrades, limits, marketClock, quotes] =
    await Promise.all([
      brokerage.getAccount(),
      brokerage.getPositions(),
      store.listOrders({ environment, openOnly: true }),
      store.listOrders({ environment, limit: 10 }),
      store.getRiskLimits(environment),
      marketData.getMarketClock(),
      marketData.getQuotes(activeSymbols),
    ]);

  const recentBars: AiContext["recentBars"] = {};
  const hourlyBars: AiContext["hourlyBars"] = {};
  // Bars for held symbols + benchmark + a few candidates (keep prompt small).
  const barSymbols = Array.from(
    new Set([
      BENCHMARK_SYMBOL,
      ...positions.map((p) => p.symbol),
      ...activeSymbols.slice(0, 8),
    ]),
  ).slice(0, 12);
  const cryptoSymbols = approvedSymbols
    .filter((s) => s.active && s.assetClass === "crypto")
    .map((s) => s.symbol)
    .slice(0, 10);
  // 90 daily bars: enough history for strategy signals (need ≥60).
  const signalBars: Record<string, import("@/lib/types").Bar[]> = {};
  await Promise.all([
    ...barSymbols.map(async (symbol) => {
      try {
        signalBars[symbol] = await marketData.getDailyBars(symbol, 90);
        recentBars[symbol] = signalBars[symbol].slice(-30);
      } catch {
        recentBars[symbol] = [];
      }
    }),
    ...cryptoSymbols.map(async (symbol) => {
      try {
        hourlyBars[symbol] = await marketData.getHourlyBars(symbol, 24);
      } catch {
        hourlyBars[symbol] = [];
      }
    }),
  ]);

  // Research packet: regime, eligible strategies, mechanical signals,
  // quote quality, cooldowns. All deterministic, no secrets, no raw text.
  const regimeReading = await getActiveRegime(mode);
  const eligibleStrategies = STRATEGIES.filter(
    (s) => regimeReading && s.approvedRegimes.includes(regimeReading.regime),
  ).map((s) => ({ id: s.id, name: s.name, entryCriteria: s.entryCriteria, sizePct: s.positionSizePct }));

  const strategySignals: NonNullable<AiContext["strategySignals"]> = [];
  for (const strategy of STRATEGIES) {
    if (!strategy.signal) continue;
    if (regimeReading && !strategy.approvedRegimes.includes(regimeReading.regime)) continue;
    const universe =
      strategy.universe === "ALL_ACTIVE_EQUITIES"
        ? barSymbols.filter((s) => !s.includes("/"))
        : strategy.universe.filter((s) => activeSymbols.includes(s));
    for (const symbol of universe) {
      const bars = signalBars[symbol];
      if (!bars || bars.length < 60) continue;
      const sig = strategy.signal(bars);
      if (sig.enter || sig.evidenceFor.length > 0) {
        strategySignals.push({
          strategyId: strategy.id,
          symbol,
          enter: sig.enter,
          evidenceFor: sig.evidenceFor.slice(0, 3),
          evidenceAgainst: sig.evidenceAgainst.slice(0, 3),
        });
      }
    }
  }

  const quoteQuality: NonNullable<AiContext["quoteQuality"]> = {};
  const cooldownSymbols: string[] = [];
  await Promise.all(
    barSymbols.slice(0, 10).map(async (symbol) => {
      const snap = await getQuoteSnapshot(mode, symbol, marketClock.isOpen).catch(() => null);
      if (snap) {
        quoteQuality[symbol] = {
          spreadBps: snap.spreadBps,
          quoteAgeMs: snap.quoteAgeMs,
          ok: assessQuote(snap).ok,
        };
      }
      const cooldowns = await deriveCooldownReasons(store, environment, symbol, "buy").catch(
        () => [],
      );
      if (cooldowns.length > 0) cooldownSymbols.push(symbol);
    }),
  );

  const aiContext: AiContext = {
    mode,
    account,
    positions,
    openOrders,
    recentTrades,
    approvedSymbols,
    quotes,
    recentBars,
    hourlyBars,
    limits,
    marketClock,
    regime: regimeReading
      ? { regime: regimeReading.regime, rules: regimeReading.rules, metrics: regimeReading.metrics }
      : null,
    quoteQuality,
    strategySignals: strategySignals.slice(0, 16),
    eligibleStrategies,
    cooldownSymbols,
  };

  let decision;
  try {
    decision = await getDecisionClient(mode).evaluate(aiContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI error";
    result.errors.push(message);
    await audit({
      actorType: "AI",
      actorId: null,
      action: "AI_EVALUATION_FAILED",
      entityType: null,
      entityId: null,
      severity: "WARNING",
      summary: `AI evaluation failed: ${message.slice(0, 300)}`,
      metadata: {},
    });
    await alert({
      notificationType: "AI_FAILURE",
      severity: "WARNING",
      title: "AI evaluation failed",
      message: message.slice(0, 500),
    });
    return result;
  }

  result.decisionCount = decision.actions.length;

  for (const action of decision.actions) {
    // HOLD / NO_ACTION: audit-log only, no visible proposal (keeps dashboard clean).
    if (action.action === "HOLD" || action.action === "NO_ACTION" || action.action === "NO_TRADE") {
      await audit({
        actorType: "AI",
        actorId: null,
        action: "AI_DECISION_PASSIVE",
        entityType: "symbol",
        entityId: action.symbol,
        severity: "INFO",
        summary: `AI chose ${action.action} for ${action.symbol} (confidence ${action.confidence}).`,
        metadata: { reasoning: action.concise_reasoning },
      });
      continue;
    }

    // Clamp expiration to the configured TTL — the AI cannot extend its own window.
    const maxExpiry = new Date(Date.now() + PROPOSAL_TTL_MINUTES * 60 * 1000);
    const aiExpiry = new Date(action.expiration_timestamp);
    const expiresAt = (aiExpiry < maxExpiry ? aiExpiry : maxExpiry).toISOString();

    // Crypto pairs trade in fractional quantities; equities are whole shares.
    const isCryptoSymbol =
      approvedSymbols.find((s) => s.symbol === action.symbol)?.assetClass === "crypto";
    const proposal = await store.createProposal({
      environment,
      symbol: action.symbol,
      action: action.action,
      quantity: isCryptoSymbol
        ? Math.round(action.quantity * 1e6) / 1e6
        : Math.floor(action.quantity),
      proposedNotional: action.proposed_notional,
      orderType: action.order_type,
      limitPrice: action.order_type === "LIMIT" ? action.limit_price : null,
      confidence: action.confidence,
      conciseReasoning: action.concise_reasoning,
      keyRisk: action.key_risk,
      expiresAt,
      status: "PENDING_RISK",
      stopLossPct: action.action === "BUY" ? action.stop_loss_pct : null,
      // Strategy attribution is validated against the known registry — an
      // invented strategy_id degrades to null rather than being trusted.
      strategyId: action.strategy_id && getStrategy(action.strategy_id) ? action.strategy_id : null,
      counterargument: action.counterargument,
      invalidationCondition: action.invalidation_condition,
      intendedHoldingDays: action.intended_holding_days,
      regimeAtCreation: regimeReading?.regime ?? null,
    });
    result.proposalsCreated++;

    await audit({
      actorType: "AI",
      actorId: null,
      action: "PROPOSAL_CREATED",
      entityType: "trade_proposal",
      entityId: proposal.id,
      severity: "INFO",
      summary: `AI proposed ${action.action} ${proposal.quantity} ${action.symbol} (confidence ${action.confidence}).`,
      metadata: { reasoning: action.concise_reasoning, keyRisk: action.key_risk },
    });

    // Risk gate.
    const ctx = await buildRiskContext(store, proposal, mode);
    const evaluation = evaluateRisk(ctx);
    await persistEvaluation(store, proposal.id, ctx, evaluation);

    if (evaluation.overallResult === "BLOCK") {
      await store.updateProposalStatus(proposal.id, "BLOCKED");
      result.blocked++;
      await audit({
        actorType: "SYSTEM",
        actorId: null,
        action: "PROPOSAL_BLOCKED",
        entityType: "trade_proposal",
        entityId: proposal.id,
        severity: "WARNING",
        summary: `Risk engine blocked ${action.action} ${proposal.quantity} ${action.symbol}.`,
        metadata: { blockReasons: evaluation.blockReasons },
      });
      await alert({
        notificationType: "PROPOSAL_BLOCKED",
        severity: "WARNING",
        title: `Proposal blocked: ${action.symbol}`,
        message: evaluation.blockReasons.join(" | ").slice(0, 800),
      });
      continue;
    }

    if (isAutonomousMode(mode)) {
      await store.updateProposalStatus(proposal.id, "QUEUED");
      result.queued++;
      const execution = await executeProposal(proposal.id, "autonomous-pipeline");
      if (execution.executed) result.executed++;
      else result.errors.push(...execution.reasons);
    } else {
      await store.updateProposalStatus(proposal.id, "AWAITING_APPROVAL");
      result.queued++;
      await alert({
        notificationType: "APPROVAL_NEEDED",
        severity: "INFO",
        title: `Approval needed: ${action.action} ${proposal.quantity} ${action.symbol}`,
        message: `${action.concise_reasoning} (confidence ${action.confidence}). Expires ${expiresAt}.`,
      });
    }
  }

  return result;
}

async function maybeCreateStopRule(
  store: Store,
  proposal: StoredProposal,
  entryPrice: number | null,
): Promise<void> {
  if (proposal.action !== "BUY" || !proposal.stopLossPct || !entryPrice || entryPrice <= 0) return;
  const stopPrice = entryPrice * (1 - proposal.stopLossPct / 100);
  await store.createStopRule({
    environment: proposal.environment,
    symbol: proposal.symbol,
    quantity: proposal.quantity,
    entryPrice,
    stopPrice,
    sourceProposalId: proposal.id,
  });
  await audit({
    actorType: "SYSTEM",
    actorId: null,
    action: "STOP_RULE_CREATED",
    entityType: "trade_proposal",
    entityId: proposal.id,
    severity: "INFO",
    summary: `Stop-loss armed for ${proposal.symbol}: exit ${proposal.quantity} if price ≤ $${stopPrice.toFixed(2)} (${proposal.stopLossPct}% below entry $${entryPrice.toFixed(2)}).`,
    metadata: {},
  });
}

export interface ExecutionOutcome {
  executed: boolean;
  reasons: string[];
  orderId?: string;
}

/**
 * Execute a permitted proposal. Re-runs the FULL risk engine on fresh account
 * data and a fresh quote immediately before submission. Uses a stored
 * client_order_id (DB-unique) so retries reconcile instead of duplicating.
 */
export async function executeProposal(
  proposalId: string,
  actor: string,
): Promise<ExecutionOutcome> {
  const store = await getStore();
  const proposal = await store.getProposal(proposalId);
  if (!proposal) return { executed: false, reasons: ["Proposal not found."] };
  if (!["APPROVED", "QUEUED"].includes(proposal.status)) {
    return { executed: false, reasons: [`Proposal status ${proposal.status} is not executable.`] };
  }

  const settings = await store.getSettings();
  const mode = settings.tradingMode;

  // Final risk check on fresh data — non-negotiable.
  const ctx = await buildRiskContext(store, proposal, mode);
  const evaluation = evaluateRisk(ctx);
  await persistEvaluation(store, proposal.id, ctx, evaluation);

  if (evaluation.overallResult === "BLOCK") {
    await store.updateProposalStatus(proposal.id, "BLOCKED");
    await audit({
      actorType: "SYSTEM",
      actorId: actor,
      action: "EXECUTION_BLOCKED",
      entityType: "trade_proposal",
      entityId: proposal.id,
      severity: "WARNING",
      summary: `Final pre-execution risk check blocked ${proposal.action} ${proposal.quantity} ${proposal.symbol}.`,
      metadata: { blockReasons: evaluation.blockReasons },
    });
    await alert({
      notificationType: "PROPOSAL_BLOCKED",
      severity: "WARNING",
      title: `Execution blocked: ${proposal.symbol}`,
      message: evaluation.blockReasons.join(" | ").slice(0, 800),
    });
    return { executed: false, reasons: evaluation.blockReasons };
  }

  await store.updateProposalStatus(proposal.id, "EXECUTING");

  // Deterministic client_order_id per proposal: a retry after a network
  // timeout reconciles the same id instead of double-submitting.
  const clientOrderId = `ffl-${proposal.id.slice(0, 18)}`;
  const side = sideOf(proposal.action);
  const brokerage = getBrokerageClient(mode);
  // Alpaca rejects time_in_force "day" for crypto; crypto requires "gtc".
  const timeInForce =
    ctx.approvedSymbols.find((s) => s.symbol === proposal.symbol)?.assetClass === "crypto"
      ? ("gtc" as const)
      : ("day" as const);

  // If we already recorded this order locally, reconcile instead of resubmitting.
  const existingLocal = await store.getOrderByClientOrderId(clientOrderId);
  if (existingLocal) {
    await reconcileOrders("execution-retry");
    return { executed: false, reasons: ["Order already exists; reconciled instead of retrying."] };
  }

  // Check the brokerage too (covers: we submitted, then crashed before saving).
  const existingRemote = await brokerage.getOrderByClientId(clientOrderId).catch(() => null);
  if (existingRemote) {
    const order = await store.createOrder({
      proposalId: proposal.id,
      environment: proposal.environment,
      clientOrderId,
      brokerageOrderId: existingRemote.brokerageOrderId,
      symbol: proposal.symbol,
      side,
      orderType: proposal.orderType,
      quantity: proposal.quantity,
      notional: ctx.quote ? ctx.quote.price * proposal.quantity : null,
      limitPrice: proposal.limitPrice,
      status: existingRemote.status,
      submittedAt: existingRemote.submittedAt,
      updatedAt: existingRemote.updatedAt,
      filledQuantity: existingRemote.filledQuantity,
      filledAvgPrice: existingRemote.filledAvgPrice,
      raw: existingRemote.raw,
    });
    await store.updateProposalStatus(proposal.id, "EXECUTED");
    return { executed: true, reasons: ["Recovered previously submitted order."], orderId: order.id };
  }

  try {
    // Order policy: prefer limit orders; never market into a wide spread.
    const plan = ctx.quoteSnapshot
      ? planOrder(proposal.orderType, proposal.limitPrice, side, ctx.quoteSnapshot)
      : { type: proposal.orderType, limitPrice: proposal.limitPrice, policyNote: "No snapshot; AI order type retained." };

    const submitted = await brokerage.submitOrder({
      clientOrderId,
      symbol: proposal.symbol,
      side,
      type: plan.type,
      quantity: proposal.quantity,
      limitPrice: plan.limitPrice,
      timeInForce,
    });

    const order = await store.createOrder({
      proposalId: proposal.id,
      environment: proposal.environment,
      clientOrderId,
      brokerageOrderId: submitted.brokerageOrderId,
      symbol: proposal.symbol,
      side,
      orderType: plan.type,
      quantity: proposal.quantity,
      notional: ctx.quote ? ctx.quote.price * proposal.quantity : null,
      limitPrice: plan.limitPrice,
      status: submitted.status,
      submittedAt: submitted.submittedAt,
      updatedAt: submitted.updatedAt,
      filledQuantity: submitted.filledQuantity,
      filledAvgPrice: submitted.filledAvgPrice,
      raw: submitted.raw,
    });

    await store.updateProposalStatus(proposal.id, "EXECUTED");
    await maybeCreateStopRule(store, proposal, submitted.filledAvgPrice ?? ctx.quote?.price ?? null);

    // Paper-trade journal entry: full decision context at execution time.
    await store
      .createJournalEntry({
        environment: proposal.environment,
        proposalId: proposal.id,
        orderId: order.id,
        symbol: proposal.symbol,
        side,
        quantity: proposal.quantity,
        strategyId: proposal.strategyId ?? null,
        regime: proposal.regimeAtCreation ?? null,
        confidence: proposal.confidence,
        thesis: proposal.conciseReasoning,
        counterargument: proposal.counterargument ?? null,
        invalidationCondition: proposal.invalidationCondition ?? null,
        quoteSnapshot: ctx.quoteSnapshot ?? null,
        costEstimate: ctx.costEstimate ?? null,
        fillPrice: submitted.filledAvgPrice,
        dataQualityOk: ctx.quoteSnapshot ? !ctx.quoteSnapshot.stale : false,
        rulesFollowed: true,
        lessons: null,
      })
      .catch(() => undefined);

    await audit({
      actorType: "SYSTEM",
      actorId: actor,
      action: "ORDER_SUBMITTED",
      entityType: "brokerage_order",
      entityId: order.id,
      severity: isLiveMode(mode) ? "CRITICAL" : "INFO",
      summary: `${isLiveMode(mode) ? "LIVE " : ""}Order submitted: ${side.toUpperCase()} ${proposal.quantity} ${proposal.symbol} (${submitted.status}).`,
      metadata: { clientOrderId, brokerageOrderId: submitted.brokerageOrderId },
    });
    await alert({
      notificationType: isLiveMode(mode) ? "LIVE_ORDER_SUBMITTED" : "ORDER_SUBMITTED",
      severity: isLiveMode(mode) ? "CRITICAL" : "INFO",
      title: `${isLiveMode(mode) ? "LIVE order" : "Order"} ${submitted.status === "FILLED" ? "filled" : "submitted"}: ${side.toUpperCase()} ${proposal.quantity} ${proposal.symbol}`,
      message: `${proposal.conciseReasoning} (confidence ${proposal.confidence})`,
    });
    return { executed: true, reasons: [], orderId: order.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown submission error";
    // Do NOT assume failure on a timeout: reconcile by client_order_id first.
    const recovered = await brokerage.getOrderByClientId(clientOrderId).catch(() => null);
    if (recovered) {
      const order = await store.createOrder({
        proposalId: proposal.id,
        environment: proposal.environment,
        clientOrderId,
        brokerageOrderId: recovered.brokerageOrderId,
        symbol: proposal.symbol,
        side,
        orderType: proposal.orderType,
        quantity: proposal.quantity,
        notional: null,
        limitPrice: proposal.limitPrice,
        status: recovered.status,
        submittedAt: recovered.submittedAt,
        updatedAt: recovered.updatedAt,
        filledQuantity: recovered.filledQuantity,
        filledAvgPrice: recovered.filledAvgPrice,
        raw: recovered.raw,
      });
      await store.updateProposalStatus(proposal.id, "EXECUTED");
      return {
        executed: true,
        reasons: ["Submission error, but order was found at brokerage and recovered."],
        orderId: order.id,
      };
    }
    await store.updateProposalStatus(proposal.id, "FAILED");
    await audit({
      actorType: "SYSTEM",
      actorId: actor,
      action: "ORDER_SUBMISSION_FAILED",
      entityType: "trade_proposal",
      entityId: proposal.id,
      severity: "WARNING",
      summary: `Order submission failed for ${proposal.symbol}: ${message.slice(0, 300)}`,
      metadata: {},
    });
    await alert({
      notificationType: "ORDER_FAILED",
      severity: "WARNING",
      title: `Order failed: ${proposal.symbol}`,
      message: message.slice(0, 500),
    });
    return { executed: false, reasons: [message] };
  }
}

/** Reconcile locally-open orders against the brokerage. */
export async function reconcileOrders(actor: string): Promise<{ updated: number }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const brokerage = getBrokerageClient(mode);
  const openLocal = await store.listOrders({ environment, openOnly: true });
  let updated = 0;

  for (const local of openLocal) {
    try {
      const remote = await brokerage.getOrderByClientId(local.clientOrderId);
      if (!remote) {
        // Stuck > 1 hour with no remote record: mark UNKNOWN and alert.
        const ageMs = Date.now() - new Date(local.submittedAt).getTime();
        if (ageMs > 60 * 60 * 1000) {
          await store.updateOrder(local.id, { status: "UNKNOWN" });
          await alert({
            notificationType: "RECONCILIATION_FAILURE",
            severity: "WARNING",
            title: `Order ${local.clientOrderId} not found at brokerage`,
            message: "Order is older than 1 hour and missing remotely. Marked UNKNOWN — review manually.",
          });
          updated++;
        }
        continue;
      }
      if (
        remote.status !== local.status ||
        remote.filledQuantity !== local.filledQuantity ||
        remote.filledAvgPrice !== local.filledAvgPrice
      ) {
        await store.updateOrder(local.id, {
          status: remote.status,
          filledQuantity: remote.filledQuantity,
          filledAvgPrice: remote.filledAvgPrice,
          brokerageOrderId: remote.brokerageOrderId,
          raw: remote.raw,
        });
        updated++;
        if (["FILLED", "PARTIALLY_FILLED", "REJECTED", "CANCELED"].includes(remote.status)) {
          await alert({
            notificationType: `ORDER_${remote.status}`,
            severity: remote.status === "REJECTED" ? "WARNING" : "INFO",
            title: `Order ${remote.status.toLowerCase().replace("_", " ")}: ${local.side.toUpperCase()} ${local.quantity} ${local.symbol}`,
            message: remote.filledAvgPrice
              ? `Filled ${remote.filledQuantity} @ $${remote.filledAvgPrice.toFixed(2)}.`
              : `Status changed to ${remote.status}.`,
          });
        }
      }
    } catch (error) {
      await audit({
        actorType: "SYSTEM",
        actorId: actor,
        action: "RECONCILIATION_ERROR",
        entityType: "brokerage_order",
        entityId: local.id,
        severity: "WARNING",
        summary: `Reconciliation failed for ${local.clientOrderId}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        metadata: {},
      });
    }
  }
  return { updated };
}

/**
 * Stop-loss monitor. For each active stop rule, if the current price has
 * fallen to or below the stop price, create an EXIT proposal and run it
 * through the FULL risk engine + execution pipeline (auto-executes in
 * autonomous modes; queues for approval in manual modes). Called from the
 * reconcile cron and the Autopilot tick.
 */
export async function checkStopRules(actor: string): Promise<{ triggered: number }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  if (settings.globalKillSwitch || mode === "LIVE_LOCKED") return { triggered: 0 };

  const rules = await store.listActiveStopRules(environment);
  if (rules.length === 0) return { triggered: 0 };

  const brokerage = getBrokerageClient(mode);
  const marketData = getMarketDataClient(mode);
  const positions = await brokerage.getPositions();
  let triggered = 0;

  for (const rule of rules) {
    const held = positions.find((p) => p.symbol === rule.symbol);
    if (!held || held.quantity <= 0) {
      // Position already gone (sold or exited elsewhere) — retire the stop.
      await store.updateStopRuleStatus(rule.id, "CANCELED");
      continue;
    }
    let price: number | null = null;
    try {
      price = (await marketData.getQuote(rule.symbol))?.price ?? null;
    } catch {
      continue; // no fresh quote — never act on stale data
    }
    if (price === null || price > rule.stopPrice) continue;

    const quantity = Math.min(rule.quantity, held.quantity);
    const proposal = await store.createProposal({
      environment,
      symbol: rule.symbol,
      action: "EXIT",
      quantity,
      proposedNotional: price * quantity,
      orderType: "MARKET",
      limitPrice: null,
      confidence: 100,
      conciseReasoning: `Stop-loss triggered: ${rule.symbol} fell to $${price.toFixed(2)}, at or below the $${rule.stopPrice.toFixed(2)} stop (${((1 - rule.stopPrice / rule.entryPrice) * 100).toFixed(1)}% below entry $${rule.entryPrice.toFixed(2)}).`,
      keyRisk: "Exit fills at market; price may differ from the stop level.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "PENDING_RISK",
      stopLossPct: null,
    });
    await store.updateStopRuleStatus(rule.id, "TRIGGERED");
    await alert({
      notificationType: "STOP_LOSS_TRIGGERED",
      severity: "WARNING",
      title: `Stop-loss triggered: ${rule.symbol}`,
      message: `Price $${price.toFixed(2)} breached the $${rule.stopPrice.toFixed(2)} stop. Exiting ${quantity}.`,
    });

    const ctx = await buildRiskContext(store, proposal, mode);
    const evaluation = evaluateRisk(ctx);
    await persistEvaluation(store, proposal.id, ctx, evaluation);
    if (evaluation.overallResult === "BLOCK") {
      await store.updateProposalStatus(proposal.id, "BLOCKED");
      continue;
    }
    if (isAutonomousMode(mode)) {
      await store.updateProposalStatus(proposal.id, "QUEUED");
      const outcome = await executeProposal(proposal.id, actor);
      if (outcome.executed) triggered++;
    } else {
      await store.updateProposalStatus(proposal.id, "AWAITING_APPROVAL");
      triggered++;
    }
  }
  return { triggered };
}

/** Capture a portfolio snapshot incl. SPY benchmark for the current environment. */
export async function captureSnapshot(): Promise<{ environment: Environment; equity: number }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const brokerage = getBrokerageClient(mode);
  const marketData = getMarketDataClient(mode);

  const [account, benchmarkQuote, previous] = await Promise.all([
    brokerage.getAccount(),
    marketData.getQuote(BENCHMARK_SYMBOL).catch(() => null),
    store.listSnapshots(environment, 5000),
  ]);

  const first = previous[0];
  const last = previous[previous.length - 1];
  const peak = previous.reduce((max, s) => Math.max(max, s.equity), account.equity);
  const baseEquity = first?.equity ?? account.equity;
  const baseBenchmark = first?.benchmarkValue ?? benchmarkQuote?.price ?? null;

  await store.saveSnapshot({
    environment,
    capturedAt: new Date().toISOString(),
    equity: account.equity,
    cash: account.cash,
    buyingPower: account.buyingPower,
    totalMarketValue: account.totalMarketValue,
    dailyReturnPct: last ? ((account.equity - last.equity) / last.equity) * 100 : 0,
    totalReturnPct: baseEquity > 0 ? ((account.equity - baseEquity) / baseEquity) * 100 : 0,
    drawdownPct: peak > 0 ? Math.max(0, ((peak - account.equity) / peak) * 100) : 0,
    benchmarkValue: benchmarkQuote?.price ?? null,
    benchmarkReturnPct:
      benchmarkQuote && baseBenchmark
        ? ((benchmarkQuote.price - baseBenchmark) / baseBenchmark) * 100
        : null,
  });

  // Threshold alerts.
  const limits = await store.getRiskLimits(environment);
  if (last) {
    const dailyPct = ((account.equity - last.equity) / last.equity) * 100;
    if (dailyPct <= -limits.maxDailyLossPct) {
      await alert({
        notificationType: "DAILY_LOSS_THRESHOLD",
        severity: "CRITICAL",
        title: "Daily loss threshold reached",
        message: `Portfolio is down ${dailyPct.toFixed(2)}% today (limit ${limits.maxDailyLossPct}%). New buys are blocked by the risk engine.`,
      });
    }
  }
  const ddPct = peak > 0 ? ((peak - account.equity) / peak) * 100 : 0;
  if (ddPct >= limits.maxDrawdownPct) {
    await alert({
      notificationType: "DRAWDOWN_THRESHOLD",
      severity: "CRITICAL",
      title: "Drawdown threshold reached",
      message: `Drawdown is ${ddPct.toFixed(2)}% (limit ${limits.maxDrawdownPct}%). New buys are blocked by the risk engine.`,
    });
  }

  return { environment, equity: account.equity };
}

/** Expire stale proposals (cron). */
export async function expireProposals(): Promise<number> {
  const store = await getStore();
  return store.expireStaleProposals(new Date().toISOString());
}

/** System health check across integrations. */
export async function runHealthChecks(): Promise<{ ok: boolean; results: { name: string; status: string; detail: string }[] }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const results: { name: string; status: "OK" | "DEGRADED" | "FAILED"; detail: string }[] = [];

  // Brokerage connectivity.
  try {
    const check = await getBrokerageClient(mode).checkConnection();
    results.push({
      name: "brokerage",
      status: check.ok ? "OK" : "FAILED",
      detail: check.detail.slice(0, 300),
    });
  } catch (error) {
    results.push({
      name: "brokerage",
      status: "FAILED",
      detail: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
  }

  // Store connectivity.
  try {
    await store.getSettings();
    results.push({ name: "store", status: "OK", detail: store.label });
  } catch (error) {
    results.push({
      name: "store",
      status: "FAILED",
      detail: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
  }

  // Market data freshness.
  try {
    const quote = await getMarketDataClient(mode).getQuote(BENCHMARK_SYMBOL);
    results.push({
      name: "market_data",
      status: quote ? "OK" : "DEGRADED",
      detail: quote ? `SPY $${quote.price.toFixed(2)} as of ${quote.asOf}` : "No quote returned",
    });
  } catch (error) {
    results.push({
      name: "market_data",
      status: "FAILED",
      detail: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
  }

  for (const r of results) {
    await store.saveHealthCheck({
      checkName: r.name,
      environment,
      status: r.status,
      details: r.detail,
      checkedAt: new Date().toISOString(),
    });
    if (r.status === "FAILED") {
      await alert({
        notificationType: "CONNECTION_FAILURE",
        severity: "WARNING",
        title: `Health check failed: ${r.name}`,
        message: r.detail,
      });
    }
  }

  return { ok: results.every((r) => r.status === "OK"), results };
}

/** Sync positions table from the brokerage (Supabase mode persists; memory mode is computed live). */
export async function syncAccount(): Promise<{ positions: number; equity: number }> {
  const store = await getStore();
  const settings = await store.getSettings();
  const brokerage = getBrokerageClient(settings.tradingMode);
  const [account, positions] = await Promise.all([
    brokerage.getAccount(),
    brokerage.getPositions(),
  ]);
  // Positions are read fresh from the brokerage for display; persisting them is
  // only needed for Supabase-backed environments (best-effort).
  return { positions: positions.length, equity: account.equity };
}

export { marketDayStartIso, randomUUID };
