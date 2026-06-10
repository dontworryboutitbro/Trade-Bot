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
  /** Executed trade count for the current market day in this environment. */
  executedTradesToday: number;
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
  if (a === "HOLD" || a === "NO_ACTION") {
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

const checkAssetType: Check = (ctx) => {
  const entry = ctx.approvedSymbols.find((s) => s.symbol === ctx.proposal.symbol);
  if (!entry) return fail("asset_type", `${ctx.proposal.symbol} has no validated asset record.`);
  if (!entry.tradable) return fail("asset_type", `${entry.symbol} is not tradable.`);
  if (entry.assetClass !== "us_equity")
    return fail("asset_type", `Asset class ${entry.assetClass} is not permitted (us_equity only).`);
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
  if (!ctx.quote) return fail("min_share_price", "No quote to validate price.");
  return ctx.quote.price >= ctx.limits.minSharePrice
    ? pass("min_share_price", `$${ctx.quote.price.toFixed(2)} ≥ $${ctx.limits.minSharePrice}.`)
    : fail(
        "min_share_price",
        `$${ctx.quote.price.toFixed(2)} is below minimum $${ctx.limits.minSharePrice}.`,
      );
};

const checkMarketOpen: Check = (ctx) => {
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

const checkDailyTradeCount: Check = (ctx) =>
  ctx.executedTradesToday < ctx.limits.maxTradesPerDay
    ? pass(
        "daily_trade_count",
        `${ctx.executedTradesToday} of ${ctx.limits.maxTradesPerDay} daily trades used.`,
      )
    : fail(
        "daily_trade_count",
        `Daily trade limit of ${ctx.limits.maxTradesPerDay} already reached.`,
      );

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

const checkAccountRestrictions: Check = (ctx) => {
  if (ctx.account.accountBlocked) return fail("account_restrictions", "Brokerage account is blocked.");
  if (ctx.account.tradingBlocked)
    return fail("account_restrictions", "Brokerage trading is blocked on this account.");
  return pass("account_restrictions", "No blocking account restrictions.");
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
  checkLiveFundedBalance,
  checkOrderSize,
  checkSymbolConcentration,
  checkTotalExposure,
  checkPositionCount,
  checkDailyTradeCount,
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
