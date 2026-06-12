// Deterministic risk engine. Pure functions, no I/O, fully unit-testable.
// Every AI proposal must pass evaluateRisk() — once at proposal time and
// again with fresh data immediately before execution. The AI can never
// modify limits or bypass these checks.

import type {
  AccountSnapshot,
  ApprovedSymbol,
  MarketClock,
  Position,
  Quote,
  RiskCheckResult,
  RiskEvaluation,
  RiskLimits,
  TradeProposal,
  TradingMode,
} from "@/lib/types";
import { canExecuteOrders, modeToEnvironment } from "@/lib/types";
import { MAX_QUOTE_AGE_MS } from "./defaults";
import { assessQuote } from "@/lib/market-data/quality";
import type { QuoteSnapshot } from "@/lib/market-data/types";
import { assessExecutionCost, type ExecutionEstimate } from "@/lib/execution/cost-model";

export interface RiskContext {
  proposal: TradeProposal;
  limits: RiskLimits;
  account: AccountSnapshot;
  positions: Position[];
  quote: Quote | null;
  marketClock: MarketClock;
  approvedSymbols: ApprovedSymbol[];
  tradingMode: TradingMode;
  globalKillSwitch: boolean;
  stopNewOrders: boolean;
  /** Executed EQUITY trade count for the current market day in this environment. */
  executedTradesToday: number;
  /** Executed CRYPTO trade count for the current day (crypto has its own cap). */
  executedCryptoTradesToday: number;
  /** Portfolio daily return percentage (negative = loss), from snapshots. */
  dailyReturnPct: number;
  /** Current drawdown percentage from peak equity (positive number = % below peak). */
  drawdownPct: number;
  /** True when an equivalent order (same symbol+side) is already open/pending. */
  hasEquivalentPendingOrder: boolean;
  /** True when this proposal id has already produced a brokerage order. */
  proposalAlreadyExecuted: boolean;
  /** Evaluation timestamp; injectable for tests. */
  now?: Date;
  /** Typed quote snapshot with bid/ask/spread/liquidity (null = unavailable). */
  quoteSnapshot?: QuoteSnapshot | null;
  /** Execution-cost estimate for this order (null = not estimable). */
  costEstimate?: ExecutionEstimate | null;
  /** Active cooldown reasons computed from order history (empty = none). */
  cooldownReasons?: string[];
  /** Strategy regime eligibility: null skips the check (no strategy attached). */
  regimeEligibility?: { activeRegime: string; approved: boolean } | null;
  /** False when no portfolio snapshot history exists (fail-closed in autonomous/live). */
  hasPortfolioSnapshot?: boolean;
  /** Calibration-adjusted minimum confidence for autonomous entries (tighten-only). */
  calibrationMinConfidence?: number | null;
  /** Live-pilot runtime context; REQUIRED when tradingMode is LIVE_MANUAL_PILOT. */
  pilot?: import("@/lib/pilot/config").PilotContext | null;
}

type Check = (ctx: RiskContext) => RiskCheckResult;

const pass = (name: string, detail: string): RiskCheckResult => ({ name, passed: true, detail });
const fail = (name: string, detail: string): RiskCheckResult => ({ name, passed: false, detail });

function isSellSide(action: string): boolean {
  return action === "SELL" || action === "REDUCE" || action === "EXIT";
}

const checkKillSwitch: Check = (ctx) =>
  ctx.globalKillSwitch
    ? fail("kill_switch", "Global kill switch is engaged. All order creation is blocked.")
    : pass("kill_switch", "Kill switch is off.");

const checkStopNewOrders: Check = (ctx) =>
  ctx.stopNewOrders
    ? fail("stop_new_orders", "STOP NEW ORDERS control is active.")
    : pass("stop_new_orders", "Stop-new-orders control is off.");

const checkTradingMode: Check = (ctx) => {
  if (!canExecuteOrders(ctx.tradingMode)) {
    return fail(
      "trading_mode",
      `Mode ${ctx.tradingMode} does not permit order execution.`,
    );
  }
  const proposalEnv = ctx.proposal.environment;
  const modeEnv = modeToEnvironment(ctx.tradingMode);
  if (proposalEnv !== modeEnv) {
    return fail(
      "trading_mode",
      `Proposal environment ${proposalEnv} does not match current mode environment ${modeEnv}.`,
    );
  }
  return pass("trading_mode", `Mode ${ctx.tradingMode} permits execution in ${modeEnv}.`);
};

const checkActionable: Check = (ctx) => {
  const a = ctx.proposal.action;
  if (a === "HOLD" || a === "NO_ACTION" || a === "NO_TRADE") {
    return fail("actionable", `Action ${a} is not an executable trade.`);
  }
  if (ctx.proposal.quantity <= 0) {
    return fail("actionable", "Quantity must be greater than zero.");
  }
  return pass("actionable", `Action ${a} for ${ctx.proposal.quantity} shares is executable.`);
};

const checkSymbolApproved: Check = (ctx) => {
  const entry = ctx.approvedSymbols.find(
    (s) => s.symbol === ctx.proposal.symbol && s.active,
  );
  return entry
    ? pass("symbol_approved", `${ctx.proposal.symbol} is on the active allowlist.`)
    : fail("symbol_approved", `${ctx.proposal.symbol} is not an active approved symbol.`);
};

function isCrypto(ctx: RiskContext): boolean {
  return (
    ctx.approvedSymbols.find((s) => s.symbol === ctx.proposal.symbol)?.assetClass === "crypto"
  );
}

const checkAssetType: Check = (ctx) => {
  const entry = ctx.approvedSymbols.find((s) => s.symbol === ctx.proposal.symbol);
  if (!entry) return fail("asset_type", `${ctx.proposal.symbol} has no validated asset record.`);
  if (!entry.tradable) return fail("asset_type", `${entry.symbol} is not tradable.`);
  if (entry.assetClass === "crypto" && !ctx.limits.allowCrypto)
    return fail("asset_type", `${entry.symbol} is crypto, which is prohibited by the risk profile.`);
  if (entry.assetClass !== "us_equity" && entry.assetClass !== "crypto")
    return fail(
      "asset_type",
      `Asset class ${entry.assetClass} is not permitted (us_equity or crypto only).`,
    );
  if (entry.leveraged && !ctx.limits.allowLeveragedEtfs)
    return fail("asset_type", `${entry.symbol} is a leveraged ETF, which is prohibited.`);
  if (entry.inverse && !ctx.limits.allowInverseEtfs)
    return fail("asset_type", `${entry.symbol} is an inverse ETF, which is prohibited.`);
  if (entry.otc && !ctx.limits.allowOtc)
    return fail("asset_type", `${entry.symbol} is OTC, which is prohibited.`);
  return pass("asset_type", `${entry.symbol} is a permitted us_equity asset.`);
};

const checkShorting: Check = (ctx) => {
  if (!isSellSide(ctx.proposal.action)) return pass("no_shorting", "Buy-side order.");
  const held = ctx.positions.find((p) => p.symbol === ctx.proposal.symbol);
  const heldQty = held?.quantity ?? 0;
  if (heldQty <= 0) {
    return fail("no_shorting", `No position in ${ctx.proposal.symbol}; selling would be a short.`);
  }
  if (ctx.proposal.quantity > heldQty && !ctx.limits.allowShorting) {
    return fail(
      "no_shorting",
      `Sell quantity ${ctx.proposal.quantity} exceeds held quantity ${heldQty}.`,
    );
  }
  return pass("no_shorting", `Selling ${ctx.proposal.quantity} of ${heldQty} held shares.`);
};

const checkQuoteFresh: Check = (ctx) => {
  if (!ctx.quote) return fail("quote_fresh", "No quote available for symbol.");
  const now = (ctx.now ?? new Date()).getTime();
  const age = now - new Date(ctx.quote.asOf).getTime();
  if (age > MAX_QUOTE_AGE_MS) {
    return fail(
      "quote_fresh",
      `Quote is ${Math.round(age / 1000)}s old (max ${MAX_QUOTE_AGE_MS / 1000}s).`,
    );
  }
  if (ctx.quote.price <= 0) return fail("quote_fresh", "Quote price is not positive.");
  return pass("quote_fresh", `Quote $${ctx.quote.price.toFixed(2)} is fresh.`);
};

const checkMinSharePrice: Check = (ctx) => {
  if (isCrypto(ctx)) return pass("min_share_price", "Crypto pair: penny-stock rule not applicable.");
  if (!ctx.quote) return fail("min_share_price", "No quote to validate price.");
  return ctx.quote.price >= ctx.limits.minSharePrice
    ? pass("min_share_price", `$${ctx.quote.price.toFixed(2)} ≥ $${ctx.limits.minSharePrice}.`)
    : fail(
        "min_share_price",
        `$${ctx.quote.price.toFixed(2)} is below minimum $${ctx.limits.minSharePrice}.`,
      );
};

const checkMarketOpen: Check = (ctx) => {
  if (isCrypto(ctx)) return pass("market_open", "Crypto trades 24/7; market hours not applicable.");
  if (!ctx.limits.marketHoursOnly) return pass("market_open", "Market-hours restriction off.");
  return ctx.marketClock.isOpen
    ? pass("market_open", "Market is open.")
    : fail("market_open", `Market is closed. Next open: ${ctx.marketClock.nextOpen}.`);
};

const checkProposalNotExpired: Check = (ctx) => {
  const now = (ctx.now ?? new Date()).getTime();
  return now <= new Date(ctx.proposal.expiresAt).getTime()
    ? pass("proposal_not_expired", "Proposal is within its validity window.")
    : fail("proposal_not_expired", `Proposal expired at ${ctx.proposal.expiresAt}.`);
};

const checkNotDuplicate: Check = (ctx) => {
  if (ctx.proposalAlreadyExecuted)
    return fail("not_duplicate", "This proposal already produced a brokerage order.");
  if (ctx.hasEquivalentPendingOrder)
    return fail("not_duplicate", "An equivalent order is already pending for this symbol/side.");
  return pass("not_duplicate", "No duplicate or pending equivalent order.");
};

const checkCash: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action)) return pass("sufficient_cash", "Sell order; no cash needed.");
  const price = ctx.quote?.price ?? 0;
  const cost = price * ctx.proposal.quantity;
  return cost <= ctx.account.cash
    ? pass("sufficient_cash", `Cost $${cost.toFixed(2)} ≤ cash $${ctx.account.cash.toFixed(2)}.`)
    : fail(
        "sufficient_cash",
        `Cost $${cost.toFixed(2)} exceeds available cash $${ctx.account.cash.toFixed(2)}.`,
      );
};

const checkLiveFundedBalance: Check = (ctx) => {
  if (ctx.limits.maxLiveFundedBalance == null)
    return pass("live_funded_balance", "No live balance cap for this environment.");
  return ctx.account.equity <= ctx.limits.maxLiveFundedBalance
    ? pass(
        "live_funded_balance",
        `Equity $${ctx.account.equity.toFixed(2)} within $${ctx.limits.maxLiveFundedBalance} cap.`,
      )
    : fail(
        "live_funded_balance",
        `Account equity $${ctx.account.equity.toFixed(2)} exceeds the live experiment cap of $${ctx.limits.maxLiveFundedBalance}. Withdraw excess funds via the brokerage before trading.`,
      );
};

const checkOrderSize: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action)) return pass("order_size", "Sell order; size cap not applied.");
  const price = ctx.quote?.price ?? 0;
  const notional = price * ctx.proposal.quantity;
  const cap = ctx.limits.maxOrderNotionalIsPct
    ? (ctx.limits.maxOrderNotional / 100) * ctx.account.equity
    : ctx.limits.maxOrderNotional;
  return notional <= cap
    ? pass("order_size", `Order $${notional.toFixed(2)} ≤ cap $${cap.toFixed(2)}.`)
    : fail("order_size", `Order $${notional.toFixed(2)} exceeds cap $${cap.toFixed(2)}.`);
};

const checkSymbolConcentration: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action))
    return pass("symbol_concentration", "Sell order reduces concentration.");
  const price = ctx.quote?.price ?? 0;
  const addition = price * ctx.proposal.quantity;
  const existing = ctx.positions.find((p) => p.symbol === ctx.proposal.symbol)?.marketValue ?? 0;
  const postValue = existing + addition;
  const postPct = ctx.account.equity > 0 ? (postValue / ctx.account.equity) * 100 : 100;
  return postPct <= ctx.limits.maxSymbolExposurePct
    ? pass(
        "symbol_concentration",
        `Post-trade ${ctx.proposal.symbol} allocation ${postPct.toFixed(1)}% ≤ ${ctx.limits.maxSymbolExposurePct}%.`,
      )
    : fail(
        "symbol_concentration",
        `Post-trade ${ctx.proposal.symbol} allocation ${postPct.toFixed(1)}% exceeds ${ctx.limits.maxSymbolExposurePct}%.`,
      );
};

const checkTotalExposure: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action))
    return pass("total_exposure", "Sell order reduces exposure.");
  const price = ctx.quote?.price ?? 0;
  const addition = price * ctx.proposal.quantity;
  const invested = ctx.positions.reduce((sum, p) => sum + p.marketValue, 0);
  const postPct = ctx.account.equity > 0 ? ((invested + addition) / ctx.account.equity) * 100 : 100;
  return postPct <= ctx.limits.maxTotalExposurePct
    ? pass(
        "total_exposure",
        `Post-trade exposure ${postPct.toFixed(1)}% ≤ ${ctx.limits.maxTotalExposurePct}%.`,
      )
    : fail(
        "total_exposure",
        `Post-trade exposure ${postPct.toFixed(1)}% exceeds ${ctx.limits.maxTotalExposurePct}%.`,
      );
};

const checkPositionCount: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action))
    return pass("position_count", "Sell order does not add positions.");
  const alreadyHeld = ctx.positions.some((p) => p.symbol === ctx.proposal.symbol);
  const postCount = ctx.positions.length + (alreadyHeld ? 0 : 1);
  return postCount <= ctx.limits.maxPositions
    ? pass("position_count", `Post-trade position count ${postCount} ≤ ${ctx.limits.maxPositions}.`)
    : fail(
        "position_count",
        `Post-trade position count ${postCount} exceeds maximum ${ctx.limits.maxPositions}.`,
      );
};

const checkDailyTradeCount: Check = (ctx) => {
  if (isCrypto(ctx)) {
    return ctx.executedCryptoTradesToday < ctx.limits.maxCryptoTradesPerDay
      ? pass(
          "daily_trade_count",
          `${ctx.executedCryptoTradesToday} of ${ctx.limits.maxCryptoTradesPerDay} daily crypto trades used.`,
        )
      : fail(
          "daily_trade_count",
          `Daily crypto trade limit of ${ctx.limits.maxCryptoTradesPerDay} already reached.`,
        );
  }
  return ctx.executedTradesToday < ctx.limits.maxTradesPerDay
    ? pass(
        "daily_trade_count",
        `${ctx.executedTradesToday} of ${ctx.limits.maxTradesPerDay} daily equity trades used.`,
      )
    : fail(
        "daily_trade_count",
        `Daily equity trade limit of ${ctx.limits.maxTradesPerDay} already reached.`,
      );
};

const checkDailyLoss: Check = (ctx) =>
  ctx.dailyReturnPct <= -ctx.limits.maxDailyLossPct
    ? fail(
        "daily_loss",
        `Daily loss ${ctx.dailyReturnPct.toFixed(2)}% breaches the ${ctx.limits.maxDailyLossPct}% limit. Trading halted for the day.`,
      )
    : pass("daily_loss", `Daily return ${ctx.dailyReturnPct.toFixed(2)}% is within limits.`);

const checkDrawdown: Check = (ctx) =>
  ctx.drawdownPct >= ctx.limits.maxDrawdownPct
    ? fail(
        "drawdown",
        `Drawdown ${ctx.drawdownPct.toFixed(2)}% breaches the ${ctx.limits.maxDrawdownPct}% limit.`,
      )
    : pass("drawdown", `Drawdown ${ctx.drawdownPct.toFixed(2)}% is within limits.`);

/** Account snapshot older than this cannot back an execution decision. */
const MAX_ACCOUNT_AGE_MS = 5 * 60 * 1000;

const checkAccountFreshness: Check = (ctx) => {
  const now = (ctx.now ?? new Date()).getTime();
  const asOf = ctx.account.asOf ? new Date(ctx.account.asOf).getTime() : NaN;
  const missing = Number.isNaN(asOf);
  const stale = !missing && now - asOf > MAX_ACCOUNT_AGE_MS;
  if (!missing && !stale) {
    return pass("account_freshness", "Buying power and account data are fresh.");
  }
  const detail = missing
    ? "Account snapshot has no timestamp — buying power cannot be verified."
    : `Account snapshot is ${Math.round((now - asOf) / 1000)}s old (max ${MAX_ACCOUNT_AGE_MS / 1000}s).`;
  return failsClosed(ctx.tradingMode)
    ? fail("account_freshness", `${detail} Blocking in ${ctx.tradingMode} (fail-closed).`)
    : pass("account_freshness", `WARNING: ${detail} Allowed in manual/mock mode; review required.`);
};

/**
 * Intraday-margin safety layer (replaces legacy PDT logic, which Alpaca
 * deprecated on 2026-06-04). Day-trade COUNT is analytics only and never a
 * rejection reason; what matters is that no order can create an intraday
 * margin deficit. Leverage is never used merely because Alpaca offers it:
 * effective buying power is capped at 1× cash in every mode (live leverage
 * would require a separate manual safety review and a code change).
 */
const checkIntradayMargin: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action))
    return pass("intraday_margin", "Sell order frees buying power.");
  const price = ctx.quote?.price ?? 0;
  const cost = price * ctx.proposal.quantity;
  const effectiveBuyingPower = Math.max(0, Math.min(ctx.account.cash, ctx.account.buyingPower));
  if (cost > effectiveBuyingPower) {
    return fail(
      "intraday_margin",
      `Order cost $${cost.toFixed(2)} exceeds 1× cash buying power $${effectiveBuyingPower.toFixed(2)} (margin borrowing is disabled; leverage is never used even when offered).`,
    );
  }
  if (
    ctx.account.maintenanceMargin != null &&
    ctx.account.equity - ctx.account.maintenanceMargin - cost < 0
  ) {
    return fail(
      "intraday_margin",
      `Order would breach the maintenance-margin cushion: equity $${ctx.account.equity.toFixed(2)} − maintenance $${ctx.account.maintenanceMargin.toFixed(2)} leaves less than the $${cost.toFixed(2)} order cost.`,
    );
  }
  return pass(
    "intraday_margin",
    `Cost $${cost.toFixed(2)} within 1× cash buying power; no intraday margin deficit possible.`,
  );
};

const checkAccountRestrictions: Check = (ctx) => {
  if (ctx.account.accountBlocked) return fail("account_restrictions", "Brokerage account is blocked.");
  if (ctx.account.tradingBlocked)
    return fail("account_restrictions", "Brokerage trading is blocked on this account.");
  return pass("account_restrictions", "No blocking account restrictions.");
};

/**
 * Fail-closed policy (18.11): in autonomous and live modes, missing quality
 * inputs BLOCK; in MOCK / PAPER_MANUAL they pass with an explicit warning
 * detail (manual review still sees it on the proposal card).
 */
function failsClosed(mode: TradingMode): boolean {
  return (
    mode === "PAPER_AUTONOMOUS" ||
    mode === "LIVE_MANUAL_PILOT" ||
    mode === "LIVE_MANUAL" ||
    mode === "LIVE_AUTONOMOUS"
  );
}

const checkDataQuality: Check = (ctx) => {
  const missing = ctx.quoteSnapshot === undefined || ctx.quoteSnapshot === null;
  if (missing) {
    return failsClosed(ctx.tradingMode)
      ? fail(
          "data_quality",
          `No quote snapshot available — quote freshness cannot be verified. Blocking in ${ctx.tradingMode} (fail-closed).`,
        )
      : pass(
          "data_quality",
          "WARNING: no quote snapshot available; allowed in manual/mock mode but requires review.",
        );
  }
  const assessment = assessQuote(ctx.quoteSnapshot!);
  return assessment.ok
    ? pass("data_quality", "Quote snapshot passed spread/staleness/liquidity rules.")
    : fail("data_quality", assessment.reasons.join(" "));
};

const checkExecutionCost: Check = (ctx) => {
  if (isSellSide(ctx.proposal.action))
    return pass("execution_cost", "Sell order; cost cap not applied to exits.");
  const missing = ctx.costEstimate === undefined || ctx.costEstimate === null;
  if (missing) {
    return failsClosed(ctx.tradingMode)
      ? fail(
          "execution_cost",
          `No execution-cost estimate available. Blocking in ${ctx.tradingMode} (fail-closed).`,
        )
      : pass(
          "execution_cost",
          "WARNING: no execution-cost estimate; allowed in manual/mock mode but requires review.",
        );
  }
  const assessment = assessExecutionCost(ctx.costEstimate!);
  return assessment.ok
    ? pass(
        "execution_cost",
        `Estimated cost ${ctx.costEstimate?.totalEstimatedCostBps.toFixed(1)} bps within cap.`,
      )
    : fail("execution_cost", assessment.reasons.join(" "));
};

const checkLearningInputs: Check = (ctx) => {
  // Autonomous/live modes additionally require a portfolio snapshot history,
  // a regime reading when a strategy is attached, and calibration compliance.
  if (!failsClosed(ctx.tradingMode)) {
    return pass("learning_inputs", "Manual/mock mode: learning inputs advisory only.");
  }
  const problems: string[] = [];
  if (ctx.hasPortfolioSnapshot === false) {
    problems.push("No portfolio snapshot exists — daily-loss/drawdown baselines unverifiable.");
  }
  if (ctx.proposal.strategyId && ctx.regimeEligibility === null) {
    problems.push("No regime reading available for a strategy-attributed proposal.");
  }
  if (
    ctx.calibrationMinConfidence !== undefined &&
    ctx.calibrationMinConfidence !== null &&
    !isSellSide(ctx.proposal.action) &&
    ctx.proposal.confidence < ctx.calibrationMinConfidence
  ) {
    problems.push(
      `Confidence ${ctx.proposal.confidence} below the calibration-adjusted minimum ${ctx.calibrationMinConfidence} (historical overconfidence penalty).`,
    );
  }
  return problems.length === 0
    ? pass("learning_inputs", "Snapshots, regime, and calibration requirements satisfied.")
    : fail("learning_inputs", problems.join(" "));
};

const checkCooldowns: Check = (ctx) => {
  const reasons = ctx.cooldownReasons ?? [];
  return reasons.length === 0
    ? pass("cooldown", "No active cooldowns.")
    : fail("cooldown", reasons.join(" "));
};

const checkRegimeEligibility: Check = (ctx) => {
  if (!ctx.regimeEligibility)
    return pass("regime_eligibility", "No strategy regime restriction applies.");
  return ctx.regimeEligibility.approved
    ? pass(
        "regime_eligibility",
        `Strategy is approved for the active regime ${ctx.regimeEligibility.activeRegime}.`,
      )
    : fail(
        "regime_eligibility",
        `Strategy is not eligible in the active market regime ${ctx.regimeEligibility.activeRegime}.`,
      );
};

/**
 * LIVE_MANUAL_PILOT hard limits. Stricter than every other layer; configured
 * only via server env vars + the audited capital stage. The AI cannot change
 * any of these. Inactive outside pilot mode.
 */
const checkPilotLimits: Check = (ctx) => {
  if (ctx.tradingMode !== "LIVE_MANUAL_PILOT") {
    return pass("pilot_limits", "Not in live-pilot mode; pilot caps not applicable.");
  }
  if (!ctx.pilot) {
    return fail("pilot_limits", "Pilot context missing — cannot verify pilot caps (fail-closed).");
  }
  const p = ctx.pilot;
  const problems: string[] = [];
  const sell = isSellSide(ctx.proposal.action);
  const price = ctx.quote?.price ?? 0;
  const notional = price * ctx.proposal.quantity;

  if (p.enabledCapitalUsd <= 0) {
    problems.push(`Capital stage ${p.capitalStage} enables $0 — review required before trading.`);
  }
  if (ctx.account.equity > p.enabledCapitalUsd + 25) {
    problems.push(
      `Live account equity $${ctx.account.equity.toFixed(2)} exceeds the enabled pilot capital $${p.enabledCapitalUsd} — withdraw excess at the brokerage first.`,
    );
  }
  if (p.assetClass === "crypto") problems.push("Crypto execution is disabled in the live pilot.");
  if (!p.reconciliationHealthy) problems.push("Order-state reconciliation is unhealthy.");
  if (!sell) {
    if (notional > p.config.maxPositionUsd) {
      problems.push(`Order $${notional.toFixed(2)} exceeds the $${p.config.maxPositionUsd} pilot position cap.`);
    }
    if (ctx.positions.length >= p.config.maxPositions &&
        !ctx.positions.some((pos) => pos.symbol === ctx.proposal.symbol)) {
      problems.push(`Pilot allows at most ${p.config.maxPositions} simultaneous positions.`);
    }
    if (p.entriesToday >= p.config.maxEntriesPerDay) {
      problems.push(`Pilot allows at most ${p.config.maxEntriesPerDay} new entries per day.`);
    }
    if (p.dailyLossUsd >= p.config.maxDailyLossUsd) {
      problems.push(`Daily loss $${p.dailyLossUsd.toFixed(2)} reached the $${p.config.maxDailyLossUsd} pilot halt.`);
    }
    if (p.weeklyLossPct >= p.config.maxWeeklyLossPct) {
      problems.push(`Weekly loss ${p.weeklyLossPct.toFixed(2)}% reached the ${p.config.maxWeeklyLossPct}% pilot halt.`);
    }
    if (!p.streamingFreshnessVerifiable) {
      problems.push("Quote freshness cannot be verified (stream degraded and REST snapshot failed) — new entries blocked; exits remain allowed.");
    }
    const snap = ctx.quoteSnapshot;
    if (!snap) {
      problems.push("No quote snapshot — pilot entries require verified fresh quotes.");
    } else {
      if (snap.spreadBps !== null && snap.spreadBps > p.config.maxSpreadBps) {
        problems.push(`Spread ${snap.spreadBps.toFixed(1)} bps exceeds the pilot's ${p.config.maxSpreadBps} bps cap.`);
      }
      if (snap.quoteAgeMs > p.config.maxQuoteAgeSeconds * 1000) {
        problems.push(`Quote ${Math.round(snap.quoteAgeMs / 1000)}s old exceeds the pilot's ${p.config.maxQuoteAgeSeconds}s cap.`);
      }
    }
    if (ctx.costEstimate && ctx.costEstimate.totalEstimatedCostBps > p.config.maxSlippageBps) {
      problems.push(
        `Estimated execution cost ${ctx.costEstimate.totalEstimatedCostBps.toFixed(1)} bps exceeds the pilot's ${p.config.maxSlippageBps} bps cap.`,
      );
    }
  }
  return problems.length === 0
    ? pass(
        "pilot_limits",
        sell
          ? "Pilot exit permitted."
          : "Within pilot caps; order will be submitted as a limit order.",
      )
    : fail("pilot_limits", problems.join(" "));
};

const ALL_CHECKS: Check[] = [
  checkKillSwitch,
  checkStopNewOrders,
  checkTradingMode,
  checkActionable,
  checkSymbolApproved,
  checkAssetType,
  checkShorting,
  checkQuoteFresh,
  checkMinSharePrice,
  checkMarketOpen,
  checkProposalNotExpired,
  checkNotDuplicate,
  checkCash,
  checkAccountFreshness,
  checkIntradayMargin,
  checkPilotLimits,
  checkLiveFundedBalance,
  checkOrderSize,
  checkSymbolConcentration,
  checkTotalExposure,
  checkPositionCount,
  checkDailyTradeCount,
  checkDataQuality,
  checkExecutionCost,
  checkLearningInputs,
  checkCooldowns,
  checkRegimeEligibility,
  checkDailyLoss,
  checkDrawdown,
  checkAccountRestrictions,
];

/**
 * Run every risk check. All checks always run (no short-circuit) so the audit
 * record captures the complete picture. Any single failure blocks the trade.
 */
export function evaluateRisk(ctx: RiskContext): RiskEvaluation {
  const checks = ALL_CHECKS.map((check) => check(ctx));
  const blockReasons = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  return {
    overallResult: blockReasons.length === 0 ? "PASS" : "BLOCK",
    checks,
    blockReasons,
    evaluatedAt: (ctx.now ?? new Date()).toISOString(),
  };
}
