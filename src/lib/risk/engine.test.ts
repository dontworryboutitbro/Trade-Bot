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
    symbol: "BTC/USD",
    displayName: "Bitcoin / USD",
    assetClass: "crypto",
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
    executedCryptoTradesToday: 0,
    dailyReturnPct: 0,
    drawdownPct: 0,
    hasEquivalentPendingOrder: false,
    proposalAlreadyExecuted: false,
    now: NOW,
    // Quality-layer defaults: a clean snapshot + cost estimate so fail-closed
    // checks pass unless a test explicitly nulls them out.
    quoteSnapshot: {
      symbol: overrides.proposal?.symbol ?? "SPY",
      timestamp: NOW.toISOString(),
      capturedAt: NOW.toISOString(),
      bid: 499.9,
      ask: 500.1,
      mid: 500,
      lastTrade: 500,
      spreadUsd: 0.2,
      spreadBps: 4,
      quoteAgeMs: 500,
      source: "mock",
      session: "REGULAR",
      dailyVolume: 50_000_000,
      avgDailyVolume: null,
      volatilityEstimate: null,
      stale: false,
      liquidity: "OK",
      halted: false,
    },
    costEstimate: {
      symbol: overrides.proposal?.symbol ?? "SPY",
      side: "buy",
      quantity: 1,
      referencePrice: 500,
      estimatedFillPrice: 500.15,
      bidAskCostUsd: 0.1,
      estimatedSlippageUsd: 0.05,
      totalEstimatedCostUsd: 0.15,
      totalEstimatedCostBps: 3,
      notionalAtReference: 500,
      notionalAtEstimatedFill: 500.15,
      maxPriceDeviationPct: 1,
      participationOfDailyVolume: 0.0000001,
    },
    hasPortfolioSnapshot: true,
    calibrationMinConfidence: null,
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

  describe("crypto", () => {
    const cryptoQuote = { symbol: "BTC/USD", price: 101250, asOf: NOW.toISOString() };
    const cryptoProposal = proposal({ symbol: "BTC/USD", quantity: 0.005 }); // ~$506

    it("blocks crypto when allowCrypto is off (default)", () => {
      blockedBy(
        evaluateRisk(ctx({ proposal: cryptoProposal, quote: cryptoQuote })),
        "asset_type",
      );
    });

    it("allows crypto when allowCrypto is on", () => {
      const result = evaluateRisk(
        ctx({
          proposal: cryptoProposal,
          quote: cryptoQuote,
          limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true },
        }),
      );
      expect(result.overallResult).toBe("PASS");
    });

    it("crypto trades while the market is closed; equities still cannot", () => {
      const closedClock = {
        isOpen: false,
        nextOpen: "2026-06-11T13:30:00.000Z",
        nextClose: "2026-06-11T20:00:00.000Z",
        asOf: NOW.toISOString(),
      };
      const cryptoResult = evaluateRisk(
        ctx({
          proposal: cryptoProposal,
          quote: cryptoQuote,
          marketClock: closedClock,
          limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true },
        }),
      );
      expect(cryptoResult.overallResult).toBe("PASS");
      blockedBy(
        evaluateRisk(
          ctx({ marketClock: closedClock, limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true } }),
        ),
        "market_open",
      );
    });

    it("crypto is exempt from the minimum share price rule", () => {
      const result = evaluateRisk(
        ctx({
          proposal: proposal({ symbol: "BTC/USD", quantity: 1 }),
          quote: { symbol: "BTC/USD", price: 5, asOf: NOW.toISOString() }, // sub-$10 price
          limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true },
        }),
      );
      expect(result.checks.find((c) => c.name === "min_share_price")?.passed).toBe(true);
    });

    it("crypto trades are exempt from the equity daily cap and use their own", () => {
      const limits = { ...PAPER_DEFAULT_LIMITS, allowCrypto: true };
      // Equity cap exhausted, crypto still allowed.
      const cryptoOk = evaluateRisk(
        ctx({ proposal: cryptoProposal, quote: cryptoQuote, limits, executedTradesToday: 3 }),
      );
      expect(cryptoOk.overallResult).toBe("PASS");
      // Crypto cap exhausted blocks crypto…
      blockedBy(
        evaluateRisk(
          ctx({
            proposal: cryptoProposal,
            quote: cryptoQuote,
            limits,
            executedCryptoTradesToday: limits.maxCryptoTradesPerDay,
          }),
        ),
        "daily_trade_count",
      );
      // …but does not block equities.
      const equityOk = evaluateRisk(
        ctx({ limits, executedCryptoTradesToday: limits.maxCryptoTradesPerDay }),
      );
      expect(equityOk.overallResult).toBe("PASS");
    });

    it("crypto still respects order-size and exposure caps", () => {
      blockedBy(
        evaluateRisk(
          ctx({
            proposal: proposal({ symbol: "BTC/USD", quantity: 0.02 }), // ~$2025 > $1000 cap
            quote: cryptoQuote,
            limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true },
          }),
        ),
        "order_size",
      );
    });
  });

  describe("intraday margin layer (legacy PDT deprecated 2026-06-04)", () => {
    it("unlimited day-trade counts never trigger a rejection by themselves", () => {
      const base = ctx();
      const result = evaluateRisk({
        ...base,
        account: {
          ...base.account,
          patternDayTrader: true,
          dayTradeCount: 250, // analytics only
          equity: 10_000, // below the old $25k threshold
        },
      });
      expect(result.overallResult).toBe("PASS");
      expect(result.checks.some((c) => c.name.toLowerCase().includes("pdt"))).toBe(false);
      expect(
        result.blockReasons.join(" ").toLowerCase().includes("day trade"),
      ).toBe(false);
    });

    it("rejects orders exceeding buying power", () => {
      const base = ctx();
      blockedBy(
        evaluateRisk({
          ...base,
          // cash high but broker-reported buying power low → effective BP is the min
          account: { ...base.account, cash: 8000, buyingPower: 100 },
        }),
        "intraday_margin",
      );
    });

    it("caps at 1× cash even when Alpaca offers leverage (never use offered margin)", () => {
      const base = ctx();
      blockedBy(
        evaluateRisk({
          ...base,
          proposal: proposal({ quantity: 1 }), // $500 order
          account: { ...base.account, cash: 300, buyingPower: 4000 }, // 4× leverage offered
        }),
        "intraday_margin",
      );
    });

    it("below-$2,000 equity is restricted to 1× buying power like everyone else", () => {
      const base = ctx();
      const small = {
        ...base,
        account: { ...base.account, equity: 1500, cash: 400, buyingPower: 3000 },
        // keep allocation/exposure caps from being the failing checks
        limits: { ...PAPER_DEFAULT_LIMITS, maxSymbolExposurePct: 100, maxTotalExposurePct: 100, maxOrderNotionalIsPct: false, maxOrderNotional: 1000 },
        positions: [],
        quote: { symbol: "SPY", price: 450, asOf: NOW.toISOString() },
      };
      blockedBy(evaluateRisk(small), "intraday_margin"); // $450 > $400 cash
    });

    it("rejects orders that would breach the maintenance-margin cushion", () => {
      const base = ctx();
      blockedBy(
        evaluateRisk({
          ...base,
          account: { ...base.account, equity: 10_000, maintenanceMargin: 9_800 },
        }),
        "intraday_margin",
      );
    });

    it("rejects execution on stale account data in autonomous mode; warns in manual", () => {
      const base = ctx({ tradingMode: "PAPER_AUTONOMOUS" });
      const staleIso = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
      blockedBy(
        evaluateRisk({ ...base, account: { ...base.account, asOf: staleIso } }),
        "account_freshness",
      );
      const manual = evaluateRisk({
        ...ctx({ tradingMode: "PAPER_MANUAL" }),
        account: { ...ctx().account, asOf: staleIso },
      });
      const check = manual.checks.find((c) => c.name === "account_freshness")!;
      expect(check.passed).toBe(true);
      expect(check.detail).toContain("WARNING");
    });

    it("rejects execution when the account snapshot is missing a timestamp (autonomous)", () => {
      const base = ctx({ tradingMode: "PAPER_AUTONOMOUS" });
      blockedBy(
        evaluateRisk({ ...base, account: { ...base.account, asOf: "" } }),
        "account_freshness",
      );
    });

    it("margin and short selling remain disabled by default in every profile", () => {
      expect(PAPER_DEFAULT_LIMITS.allowMargin).toBe(false);
      expect(PAPER_DEFAULT_LIMITS.allowShorting).toBe(false);
      expect(LIVE_DEFAULT_LIMITS.allowMargin).toBe(false);
      expect(LIVE_DEFAULT_LIMITS.allowShorting).toBe(false);
      // and the engine enforces no_shorting structurally:
      blockedBy(evaluateRisk(ctx({ proposal: proposal({ action: "SELL" }) })), "no_shorting");
    });

    it("autonomous paper mode is capped at 1× cash", () => {
      const base = ctx({ tradingMode: "PAPER_AUTONOMOUS" });
      blockedBy(
        evaluateRisk({
          ...base,
          account: { ...base.account, cash: 499, buyingPower: 10_000 },
        }),
        "intraday_margin",
      );
    });

    it("sells are never blocked by the margin layer", () => {
      const base = ctx();
      const result = evaluateRisk({
        ...base,
        positions: [
          {
            symbol: "SPY", quantity: 2, averageEntryPrice: 480, currentPrice: 500,
            marketValue: 1000, unrealizedPl: 40, unrealizedPlPct: 4,
          },
        ],
        proposal: proposal({ action: "SELL", quantity: 1 }),
        account: { ...base.account, cash: 0, buyingPower: 0 },
      });
      expect(result.checks.find((c) => c.name === "intraday_margin")!.passed).toBe(true);
    });
  });

  describe("fail-closed quality inputs (18.11)", () => {
    it("MOCK and PAPER_MANUAL: missing snapshot/cost estimate warn but pass", () => {
      for (const tradingMode of ["MOCK", "PAPER_MANUAL"] as const) {
        const proposalEnv = tradingMode === "MOCK" ? "MOCK" : "PAPER";
        const result = evaluateRisk(
          ctx({
            tradingMode,
            proposal: proposal({ environment: proposalEnv as never }),
            quoteSnapshot: null,
            costEstimate: null,
          }),
        );
        const dq = result.checks.find((c) => c.name === "data_quality")!;
        const ec = result.checks.find((c) => c.name === "execution_cost")!;
        expect(dq.passed).toBe(true);
        expect(dq.detail).toContain("WARNING");
        expect(ec.passed).toBe(true);
        expect(ec.detail).toContain("WARNING");
      }
    });

    it("PAPER_AUTONOMOUS: missing quote snapshot blocks", () => {
      blockedBy(
        evaluateRisk(ctx({ tradingMode: "PAPER_AUTONOMOUS", quoteSnapshot: null })),
        "data_quality",
      );
    });

    it("PAPER_AUTONOMOUS: missing cost estimate blocks", () => {
      blockedBy(
        evaluateRisk(ctx({ tradingMode: "PAPER_AUTONOMOUS", costEstimate: null })),
        "execution_cost",
      );
    });

    it("PAPER_AUTONOMOUS: missing portfolio snapshot blocks", () => {
      blockedBy(
        evaluateRisk(ctx({ tradingMode: "PAPER_AUTONOMOUS", hasPortfolioSnapshot: false })),
        "learning_inputs",
      );
    });

    it("PAPER_AUTONOMOUS: missing regime reading blocks strategy proposals", () => {
      blockedBy(
        evaluateRisk(
          ctx({
            tradingMode: "PAPER_AUTONOMOUS",
            proposal: proposal({ strategyId: "trend-pullback" }),
            regimeEligibility: null,
          }),
        ),
        "learning_inputs",
      );
    });

    it("LIVE_MANUAL: missing quality inputs block", () => {
      blockedBy(
        evaluateRisk(
          ctx({
            tradingMode: "LIVE_MANUAL",
            proposal: proposal({ environment: "LIVE" }),
            limits: LIVE_DEFAULT_LIMITS,
            quoteSnapshot: null,
          }),
        ),
        "data_quality",
      );
    });

    it("calibration penalty blocks low-confidence autonomous entries", () => {
      blockedBy(
        evaluateRisk(
          ctx({
            tradingMode: "PAPER_AUTONOMOUS",
            proposal: proposal({ confidence: 62 }),
            calibrationMinConfidence: 80,
          }),
        ),
        "learning_inputs",
      );
      // Same proposal passes in manual mode (penalty is autonomous-only).
      const manual = evaluateRisk(
        ctx({
          tradingMode: "PAPER_MANUAL",
          proposal: proposal({ confidence: 62 }),
          calibrationMinConfidence: 80,
        }),
      );
      expect(manual.checks.find((c) => c.name === "learning_inputs")!.passed).toBe(true);
    });
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
