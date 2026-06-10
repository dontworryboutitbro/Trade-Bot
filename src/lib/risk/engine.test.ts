import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskContext } from "./engine";
import { PAPER_DEFAULT_LIMITS, LIVE_DEFAULT_LIMITS, MAX_QUOTE_AGE_MS } from "./defaults";
import type { ApprovedSymbol, Position, TradeProposal } from "@/lib/types";

const NOW = new Date("2026-06-10T15:00:00.000Z"); // during US market hours

const approvedSymbols: ApprovedSymbol[] = [
  {
    symbol: "SPY",
    displayName: "SPDR S&P 500 ETF",
    assetClass: "us_equity",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: false,
    active: true,
  },
  {
    symbol: "QQQ",
    displayName: "Invesco QQQ",
    assetClass: "us_equity",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: false,
    active: true,
  },
  {
    symbol: "TQQQ",
    displayName: "ProShares UltraPro QQQ",
    assetClass: "us_equity",
    tradable: true,
    leveraged: true,
    inverse: false,
    otc: false,
    active: true,
  },
  {
    symbol: "SQQQ",
    displayName: "ProShares UltraPro Short QQQ",
    assetClass: "us_equity",
    tradable: true,
    leveraged: true,
    inverse: true,
    otc: false,
    active: true,
  },
  {
    symbol: "BTCUSD",
    displayName: "Bitcoin",
    assetClass: "crypto",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: false,
    active: true,
  },
  {
    symbol: "SPY260918C00500000",
    displayName: "SPY Call Option",
    assetClass: "us_option",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: false,
    active: true,
  },
  {
    symbol: "PINKCO",
    displayName: "Pink Sheet Co",
    assetClass: "us_equity",
    tradable: true,
    leveraged: false,
    inverse: false,
    otc: true,
    active: true,
  },
];

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    id: "prop-1",
    environment: "PAPER",
    symbol: "SPY",
    action: "BUY",
    quantity: 1,
    proposedNotional: 500,
    orderType: "MARKET",
    limitPrice: null,
    confidence: 70,
    conciseReasoning: "Test",
    keyRisk: "Test",
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    status: "PENDING_RISK",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    proposal: proposal(),
    limits: PAPER_DEFAULT_LIMITS,
    account: {
      equity: 10000,
      cash: 8000,
      buyingPower: 8000,
      totalMarketValue: 2000,
      currency: "USD",
      accountBlocked: false,
      tradingBlocked: false,
      patternDayTrader: false,
      asOf: NOW.toISOString(),
    },
    positions: [],
    quote: { symbol: "SPY", price: 500, asOf: NOW.toISOString() },
    marketClock: {
      isOpen: true,
      nextOpen: "2026-06-11T13:30:00.000Z",
      nextClose: "2026-06-10T20:00:00.000Z",
      asOf: NOW.toISOString(),
    },
    approvedSymbols,
    tradingMode: "PAPER_MANUAL",
    globalKillSwitch: false,
    stopNewOrders: false,
    executedTradesToday: 0,
    dailyReturnPct: 0,
    drawdownPct: 0,
    hasEquivalentPendingOrder: false,
    proposalAlreadyExecuted: false,
    now: NOW,
    ...overrides,
  };
}

function blockedBy(result: ReturnType<typeof evaluateRisk>, name: string) {
  expect(result.overallResult).toBe("BLOCK");
  expect(result.checks.find((c) => c.name === name)?.passed).toBe(false);
}

describe("risk engine", () => {
  it("passes a valid paper trade", () => {
    const result = evaluateRisk(ctx());
    expect(result.overallResult).toBe("PASS");
    expect(result.blockReasons).toEqual([]);
  });

  it("runs every check even when one fails (full audit record)", () => {
    const result = evaluateRisk(ctx({ globalKillSwitch: true }));
    expect(result.checks.length).toBeGreaterThanOrEqual(22);
  });

  it("blocks when symbol is not approved", () => {
    const result = evaluateRisk(ctx({ proposal: proposal({ symbol: "GME" }) }));
    blockedBy(result, "symbol_approved");
  });

  it("blocks inactive approved symbols", () => {
    const symbols = approvedSymbols.map((s) =>
      s.symbol === "SPY" ? { ...s, active: false } : s,
    );
    blockedBy(evaluateRisk(ctx({ approvedSymbols: symbols })), "symbol_approved");
  });

  it("blocks options", () => {
    const result = evaluateRisk(
      ctx({ proposal: proposal({ symbol: "SPY260918C00500000" }) }),
    );
    blockedBy(result, "asset_type");
  });

  it("blocks crypto", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ symbol: "BTCUSD" }) })), "asset_type");
  });

  it("blocks leveraged ETFs", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ symbol: "TQQQ" }) })), "asset_type");
  });

  it("blocks inverse ETFs", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ symbol: "SQQQ" }) })), "asset_type");
  });

  it("blocks OTC securities", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ symbol: "PINKCO" }) })), "asset_type");
  });

  it("blocks short sales (selling with no position)", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ action: "SELL" }) })), "no_shorting");
  });

  it("blocks selling more than held", () => {
    const positions: Position[] = [
      {
        symbol: "SPY",
        quantity: 1,
        averageEntryPrice: 480,
        currentPrice: 500,
        marketValue: 500,
        unrealizedPl: 20,
        unrealizedPlPct: 4.2,
      },
    ];
    blockedBy(
      evaluateRisk(ctx({ positions, proposal: proposal({ action: "SELL", quantity: 2 }) })),
      "no_shorting",
    );
  });

  it("allows selling within held quantity", () => {
    const positions: Position[] = [
      {
        symbol: "SPY",
        quantity: 2,
        averageEntryPrice: 480,
        currentPrice: 500,
        marketValue: 1000,
        unrealizedPl: 40,
        unrealizedPlPct: 4.2,
      },
    ];
    const result = evaluateRisk(
      ctx({ positions, proposal: proposal({ action: "SELL", quantity: 1 }) }),
    );
    expect(result.overallResult).toBe("PASS");
  });

  it("blocks share price below minimum", () => {
    blockedBy(
      evaluateRisk(ctx({ quote: { symbol: "SPY", price: 9.5, asOf: NOW.toISOString() } })),
      "min_share_price",
    );
  });

  it("blocks stale quotes", () => {
    const stale = new Date(NOW.getTime() - MAX_QUOTE_AGE_MS - 1000).toISOString();
    blockedBy(
      evaluateRisk(ctx({ quote: { symbol: "SPY", price: 500, asOf: stale } })),
      "quote_fresh",
    );
  });

  it("blocks missing quotes", () => {
    blockedBy(evaluateRisk(ctx({ quote: null })), "quote_fresh");
  });

  it("blocks expired proposals", () => {
    const expired = proposal({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    blockedBy(evaluateRisk(ctx({ proposal: expired })), "proposal_not_expired");
  });

  it("blocks when market is closed", () => {
    blockedBy(
      evaluateRisk(
        ctx({
          marketClock: {
            isOpen: false,
            nextOpen: "2026-06-11T13:30:00.000Z",
            nextClose: "2026-06-11T20:00:00.000Z",
            asOf: NOW.toISOString(),
          },
        }),
      ),
      "market_open",
    );
  });

  it("blocks insufficient cash", () => {
    blockedBy(
      evaluateRisk(ctx({ proposal: proposal({ quantity: 100 }) })), // $50k > $8k cash
      "sufficient_cash",
    );
  });

  it("blocks symbol concentration violations", () => {
    // 3 shares × $500 = $1500 = 15% of $10k equity > 10% cap
    const result = evaluateRisk(ctx({ proposal: proposal({ quantity: 3 }) }));
    blockedBy(result, "symbol_concentration");
  });

  it("blocks total exposure violations", () => {
    const positions: Position[] = ["QQQ", "VTI", "DIA", "IWM"].map((symbol, i) => ({
      symbol,
      quantity: 3,
      averageEntryPrice: 480,
      currentPrice: 500,
      marketValue: 1450 + i, // ~58% total of 10k equity
      unrealizedPl: 0,
      unrealizedPlPct: 0,
    }));
    // adding $500 takes total exposure over 60%
    const result = evaluateRisk(ctx({ positions, proposal: proposal({ quantity: 1 }) }));
    blockedBy(result, "total_exposure");
  });

  it("blocks position-count violations", () => {
    const positions: Position[] = ["QQQ", "VTI", "DIA", "IWM", "SCHD"].map((symbol) => ({
      symbol,
      quantity: 1,
      averageEntryPrice: 100,
      currentPrice: 100,
      marketValue: 100,
      unrealizedPl: 0,
      unrealizedPlPct: 0,
    }));
    blockedBy(evaluateRisk(ctx({ positions })), "position_count");
  });

  it("blocks daily-trade-count violations", () => {
    blockedBy(evaluateRisk(ctx({ executedTradesToday: 3 })), "daily_trade_count");
  });

  it("blocks when daily loss threshold is breached", () => {
    blockedBy(evaluateRisk(ctx({ dailyReturnPct: -2.5 })), "daily_loss");
  });

  it("blocks when drawdown threshold is breached", () => {
    blockedBy(evaluateRisk(ctx({ drawdownPct: 9 })), "drawdown");
  });

  it("blocks when kill switch is engaged", () => {
    blockedBy(evaluateRisk(ctx({ globalKillSwitch: true })), "kill_switch");
  });

  it("blocks when stop-new-orders is active", () => {
    blockedBy(evaluateRisk(ctx({ stopNewOrders: true })), "stop_new_orders");
  });

  it("blocks execution in LIVE_LOCKED mode", () => {
    blockedBy(
      evaluateRisk(
        ctx({
          tradingMode: "LIVE_LOCKED",
          proposal: proposal({ environment: "LIVE" }),
        }),
      ),
      "trading_mode",
    );
  });

  it("blocks environment mismatch (paper proposal in live mode)", () => {
    blockedBy(evaluateRisk(ctx({ tradingMode: "LIVE_MANUAL" })), "trading_mode");
  });

  it("blocks duplicate orders (proposal already executed)", () => {
    blockedBy(evaluateRisk(ctx({ proposalAlreadyExecuted: true })), "not_duplicate");
  });

  it("blocks when an equivalent order is pending", () => {
    blockedBy(evaluateRisk(ctx({ hasEquivalentPendingOrder: true })), "not_duplicate");
  });

  it("blocks HOLD and NO_ACTION from executing", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ action: "HOLD" }) })), "actionable");
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ action: "NO_ACTION" }) })), "actionable");
  });

  it("blocks zero or negative quantity", () => {
    blockedBy(evaluateRisk(ctx({ proposal: proposal({ quantity: 0 }) })), "actionable");
  });

  it("blocks blocked brokerage accounts", () => {
    const base = ctx();
    blockedBy(
      evaluateRisk({ ...base, account: { ...base.account, tradingBlocked: true } }),
      "account_restrictions",
    );
  });

  describe("live limits", () => {
    function liveCtx(overrides: Partial<RiskContext> = {}): RiskContext {
      return ctx({
        limits: LIVE_DEFAULT_LIMITS,
        tradingMode: "LIVE_MANUAL",
        proposal: proposal({ environment: "LIVE", quantity: 1 }),
        account: {
          equity: 900,
          cash: 800,
          buyingPower: 800,
          totalMarketValue: 100,
          currency: "USD",
          accountBlocked: false,
          tradingBlocked: false,
          patternDayTrader: false,
          asOf: NOW.toISOString(),
        },
        quote: { symbol: "SPY", price: 50, asOf: NOW.toISOString() },
        ...overrides,
      });
    }

    it("passes a small valid live trade", () => {
      expect(evaluateRisk(liveCtx()).overallResult).toBe("PASS");
    });

    it("enforces the absolute $100 order cap in live", () => {
      blockedBy(
        evaluateRisk(
          liveCtx({ proposal: proposal({ environment: "LIVE", quantity: 3 }) }), // $150
        ),
        "order_size",
      );
    });

    it("blocks live trading when funded balance exceeds the cap", () => {
      const base = liveCtx();
      blockedBy(
        evaluateRisk({ ...base, account: { ...base.account, equity: 1500 } }),
        "live_funded_balance",
      );
    });
  });

  it("enforces the percent-based order cap in paper", () => {
    // 10% of $10k = $1000 cap; 2 shares × $501 = $1002 — wait, quote is 500.
    // Use quantity such that notional > 1000 but concentration would also trip.
    // Tighten: equity 10000, quote 350 → 3 shares = $1050 > $1000 cap.
    const result = evaluateRisk(
      ctx({
        quote: { symbol: "SPY", price: 350, asOf: NOW.toISOString() },
        proposal: proposal({ quantity: 3 }),
      }),
    );
    blockedBy(result, "order_size");
  });
});
