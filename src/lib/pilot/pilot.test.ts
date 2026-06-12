import { describe, expect, it } from "vitest";
import { evaluateRisk, type RiskContext } from "@/lib/risk/engine";
import { LIVE_DEFAULT_LIMITS } from "@/lib/risk/defaults";
import { validateModeChange, LIVE_PILOT_CONFIRMATION_PHRASE } from "@/lib/trading/modes";
import { getPilotConfig, stageCapitalUsd } from "./config";
import { drillsValidForActivation } from "./drills";
import type { PilotContext } from "./config";
import type { QuoteSnapshot } from "@/lib/market-data/types";

const NOW = new Date("2026-06-12T15:00:00.000Z");

function snapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    symbol: "SPY", timestamp: NOW.toISOString(), capturedAt: NOW.toISOString(),
    bid: 49.95, ask: 50.05, mid: 50, lastTrade: 50, spreadUsd: 0.1, spreadBps: 20,
    quoteAgeMs: 500, source: "alpaca_rest", session: "REGULAR", dailyVolume: 50_000_000,
    avgDailyVolume: null, volatilityEstimate: null, stale: false, liquidity: "OK",
    halted: false, ...overrides,
  };
}

function pilotCtx(
  pilotOverrides: Partial<PilotContext> = {},
  ctxOverrides: Partial<RiskContext> = {},
): RiskContext {
  const config = getPilotConfig();
  const pilot: PilotContext = {
    config,
    capitalStage: "PILOT_250",
    enabledCapitalUsd: 250,
    entriesToday: 0,
    dailyLossUsd: 0,
    weeklyLossPct: 0,
    assetClass: "us_equity",
    reconciliationHealthy: true,
    streamingFreshnessVerifiable: true,
    ...pilotOverrides,
  };
  return {
    proposal: {
      // $20 order: inside BOTH the pilot's $50 cap AND the pre-existing
      // 10%-of-equity concentration rule (pilot layers on top, never loosens).
      id: "pilot-1", environment: "LIVE", symbol: "SPY", action: "BUY", quantity: 0.4,
      proposedNotional: 20, orderType: "LIMIT", limitPrice: 50.05, confidence: 70,
      conciseReasoning: "t", keyRisk: "t",
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      status: "PENDING_RISK", createdAt: NOW.toISOString(),
    },
    limits: LIVE_DEFAULT_LIMITS,
    account: {
      equity: 240, cash: 200, buyingPower: 200, totalMarketValue: 40, currency: "USD",
      accountBlocked: false, tradingBlocked: false, patternDayTrader: false,
      maintenanceMargin: 0, asOf: NOW.toISOString(),
    },
    positions: [],
    quote: { symbol: "SPY", price: 50, asOf: NOW.toISOString() },
    marketClock: {
      isOpen: true,
      nextOpen: new Date(NOW.getTime() + 3600_000).toISOString(),
      nextClose: new Date(NOW.getTime() + 7200_000).toISOString(),
      asOf: NOW.toISOString(),
    },
    approvedSymbols: [{
      symbol: "SPY", displayName: "SPY", assetClass: "us_equity", tradable: true,
      leveraged: false, inverse: false, otc: false, active: true,
    }],
    tradingMode: "LIVE_MANUAL_PILOT",
    globalKillSwitch: false,
    stopNewOrders: false,
    executedTradesToday: 0,
    executedCryptoTradesToday: 0,
    dailyReturnPct: 0,
    drawdownPct: 0,
    hasEquivalentPendingOrder: false,
    proposalAlreadyExecuted: false,
    now: NOW,
    quoteSnapshot: snapshot(),
    costEstimate: {
      symbol: "SPY", side: "buy", quantity: 0.9, referencePrice: 50, estimatedFillPrice: 50.06,
      bidAskCostUsd: 0.045, estimatedSlippageUsd: 0.01, totalEstimatedCostUsd: 0.055,
      totalEstimatedCostBps: 12, notionalAtReference: 45, notionalAtEstimatedFill: 45.05,
      maxPriceDeviationPct: 1, participationOfDailyVolume: 0.0000001,
    },
    hasPortfolioSnapshot: true,
    calibrationMinConfidence: null,
    pilot,
    ...ctxOverrides,
  };
}

function blockedBy(result: ReturnType<typeof evaluateRisk>, name: string, fragment?: string) {
  const check = result.checks.find((c) => c.name === name)!;
  expect(check.passed).toBe(false);
  if (fragment) expect(check.detail).toContain(fragment);
}

describe("LIVE_MANUAL_PILOT mode", () => {
  it("a small compliant pilot order passes every check", () => {
    const result = evaluateRisk(pilotCtx());
    expect(result.blockReasons).toEqual([]);
    expect(result.overallResult).toBe("PASS");
  });

  it("requires the pilot context (fail-closed)", () => {
    blockedBy(evaluateRisk(pilotCtx({}, { pilot: null })), "pilot_limits", "Pilot context missing");
  });

  it("enforces the $50 position cap", () => {
    const ctx = pilotCtx();
    ctx.proposal = { ...ctx.proposal, quantity: 1.5, proposedNotional: 75 };
    blockedBy(evaluateRisk(ctx), "pilot_limits", "position cap");
  });

  it("enforces max 2 simultaneous positions", () => {
    const positions = ["QQQ", "VTI"].map((symbol) => ({
      symbol, quantity: 0.5, averageEntryPrice: 50, currentPrice: 50,
      marketValue: 25, unrealizedPl: 0, unrealizedPlPct: 0,
    }));
    blockedBy(evaluateRisk(pilotCtx({}, { positions })), "pilot_limits", "simultaneous positions");
  });

  it("enforces max 2 new entries per day", () => {
    blockedBy(evaluateRisk(pilotCtx({ entriesToday: 2 })), "pilot_limits", "entries per day");
  });

  it("halts on the $10 daily loss", () => {
    blockedBy(evaluateRisk(pilotCtx({ dailyLossUsd: 10 })), "pilot_limits", "Daily loss");
  });

  it("halts on the 3% weekly loss", () => {
    blockedBy(evaluateRisk(pilotCtx({ weeklyLossPct: 3.2 })), "pilot_limits", "Weekly loss");
  });

  it("blocks crypto execution in the pilot", () => {
    blockedBy(evaluateRisk(pilotCtx({ assetClass: "crypto" })), "pilot_limits", "Crypto");
  });

  it("blocks entries when the account exceeds enabled capital", () => {
    const ctx = pilotCtx();
    ctx.account = { ...ctx.account, equity: 600 };
    blockedBy(evaluateRisk(ctx), "pilot_limits", "exceeds the enabled pilot capital");
  });

  it("blocks entries at REVIEW_REQUIRED ($0 enabled)", () => {
    blockedBy(
      evaluateRisk(pilotCtx({ capitalStage: "REVIEW_REQUIRED", enabledCapitalUsd: 0 })),
      "pilot_limits",
      "enables $0",
    );
  });

  it("blocks entries on unhealthy reconciliation or unverifiable freshness; exits stay allowed", () => {
    blockedBy(evaluateRisk(pilotCtx({ reconciliationHealthy: false })), "pilot_limits", "reconciliation");
    blockedBy(
      evaluateRisk(pilotCtx({ streamingFreshnessVerifiable: false })),
      "pilot_limits",
      "freshness",
    );
    // Exit is allowed even with everything degraded.
    const exitCtx = pilotCtx({ reconciliationHealthy: true, streamingFreshnessVerifiable: false });
    exitCtx.positions = [{
      symbol: "SPY", quantity: 1, averageEntryPrice: 50, currentPrice: 50,
      marketValue: 50, unrealizedPl: 0, unrealizedPlPct: 0,
    }];
    exitCtx.proposal = { ...exitCtx.proposal, action: "EXIT", quantity: 1 };
    const exitCheck = evaluateRisk(exitCtx).checks.find((c) => c.name === "pilot_limits")!;
    expect(exitCheck.passed).toBe(true);
  });

  it("enforces the pilot's stricter spread and quote-age caps", () => {
    blockedBy(evaluateRisk(pilotCtx({}, { quoteSnapshot: snapshot({ spreadBps: 30 }) })), "pilot_limits", "Spread");
    blockedBy(
      evaluateRisk(pilotCtx({}, { quoteSnapshot: snapshot({ quoteAgeMs: 90_000 }) })),
      "pilot_limits",
      "old exceeds",
    );
  });

  it("enforces the slippage cap", () => {
    const ctx = pilotCtx();
    ctx.costEstimate = { ...ctx.costEstimate!, totalEstimatedCostBps: 45 };
    blockedBy(evaluateRisk(ctx), "pilot_limits", "exceeds the pilot's 30 bps");
  });

  it("pilot checks are inert outside pilot mode", () => {
    const ctx = pilotCtx({}, { tradingMode: "PAPER_MANUAL", pilot: null });
    ctx.proposal = { ...ctx.proposal, environment: "PAPER" };
    const check = evaluateRisk(ctx).checks.find((c) => c.name === "pilot_limits")!;
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("not applicable");
  });
});

describe("pilot activation gating", () => {
  it("requires the dedicated typed phrase + full ceremony from LIVE_LOCKED", () => {
    const base = {
      from: "LIVE_LOCKED" as const,
      to: "LIVE_MANUAL_PILOT" as const,
      acknowledgmentsComplete: true,
      killSwitchTested: true,
      liveConnectivityVerified: true,
    };
    expect(validateModeChange({ ...base }).allowed).toBe(false);
    expect(
      validateModeChange({ ...base, confirmationPhrase: "ENABLE LIVE MANUAL TRADING" }).allowed,
    ).toBe(false);
    expect(
      validateModeChange({ ...base, confirmationPhrase: LIVE_PILOT_CONFIRMATION_PHRASE }).allowed,
    ).toBe(true);
  });

  it("is unreachable except from LIVE_LOCKED", () => {
    for (const from of ["MOCK", "PAPER_MANUAL", "PAPER_AUTONOMOUS"] as const) {
      expect(
        validateModeChange({
          from,
          to: "LIVE_MANUAL_PILOT",
          confirmationPhrase: LIVE_PILOT_CONFIRMATION_PHRASE,
          acknowledgmentsComplete: true,
          killSwitchTested: true,
          liveConnectivityVerified: true,
        }).allowed,
      ).toBe(false);
    }
  });

  it("drill gating: never-run, failing, and stale runs all block", () => {
    expect(drillsValidForActivation(null).ok).toBe(false);
    expect(
      drillsValidForActivation({
        ranAt: new Date().toISOString(),
        results: [{ name: "kill_switch", mandatory: true, status: "FAIL", detail: "x" }],
        allMandatoryPassed: false,
      }).ok,
    ).toBe(false);
    expect(
      drillsValidForActivation({
        ranAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        results: [],
        allMandatoryPassed: true,
      }).ok,
    ).toBe(false);
    expect(
      drillsValidForActivation({
        ranAt: new Date().toISOString(),
        results: [],
        allMandatoryPassed: true,
      }).ok,
    ).toBe(true);
  });
});

describe("capital stages", () => {
  it("maps stages to capital with the env ceiling applied", () => {
    const config = getPilotConfig();
    expect(stageCapitalUsd("CANARY_100", config)).toBe(100);
    expect(stageCapitalUsd("PILOT_250", config)).toBe(250);
    expect(stageCapitalUsd("PILOT_500", config)).toBe(Math.min(500, config.maxCapitalUsd));
    expect(stageCapitalUsd("REVIEW_REQUIRED", config)).toBe(0);
    expect(stageCapitalUsd("NONSENSE", config)).toBe(0);
  });
});
