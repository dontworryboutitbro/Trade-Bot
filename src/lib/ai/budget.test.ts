import { afterEach, describe, expect, it } from "vitest";
import { actionablePreflight, getAiDailyBudget, type PreflightInputs } from "./budget";
import { PAPER_DEFAULT_LIMITS } from "@/lib/risk/defaults";
import type { MarketClock } from "@/lib/types";

const OPEN: MarketClock = {
  isOpen: true,
  nextOpen: "2026-06-13T13:30:00Z",
  nextClose: "2026-06-12T20:00:00Z",
  asOf: "2026-06-12T15:00:00Z",
};
const CLOSED: MarketClock = { ...OPEN, isOpen: false };

function inputs(overrides: Partial<PreflightInputs> = {}): PreflightInputs {
  return {
    mode: "PAPER_AUTONOMOUS",
    marketClock: OPEN,
    limits: PAPER_DEFAULT_LIMITS,
    activeSymbols: ["SPY", "QQQ"],
    candidatePool: ["SPY", "QQQ"],
    positionSymbols: [],
    equityTradesToday: 0,
    cryptoTradesToday: 0,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.AI_DAILY_BUDGET;
});

describe("AI daily budget", () => {
  it("defaults: mock unlimited, paper small, live larger", () => {
    expect(getAiDailyBudget("MOCK")).toBe(Number.POSITIVE_INFINITY);
    expect(getAiDailyBudget("PAPER_AUTONOMOUS")).toBe(4);
    expect(getAiDailyBudget("PAPER_MANUAL")).toBe(4);
    expect(getAiDailyBudget("LIVE_MANUAL_PILOT")).toBe(12);
  });

  it("honors the AI_DAILY_BUDGET env override", () => {
    process.env.AI_DAILY_BUDGET = "1";
    expect(getAiDailyBudget("PAPER_AUTONOMOUS")).toBe(1);
    process.env.AI_DAILY_BUDGET = "0";
    expect(getAiDailyBudget("PAPER_AUTONOMOUS")).toBe(0);
  });
});

describe("actionable preflight (skip the Claude call when no trade is possible)", () => {
  it("proceeds when the equity market is open with candidates and headroom", () => {
    expect(actionablePreflight(inputs())).toBeNull();
  });

  it("skips when the market is closed and no crypto is eligible", () => {
    const reason = actionablePreflight(inputs({ marketClock: CLOSED }));
    expect(reason).toContain("Market closed");
  });

  it("still runs when closed if an eligible crypto pair exists (24/7)", () => {
    const reason = actionablePreflight(
      inputs({
        marketClock: CLOSED,
        limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: true },
        activeSymbols: ["BTC/USD"],
        candidatePool: ["BTC/USD"],
      }),
    );
    expect(reason).toBeNull();
  });

  it("skips crypto when crypto is disabled in the risk profile", () => {
    const reason = actionablePreflight(
      inputs({
        marketClock: CLOSED,
        limits: { ...PAPER_DEFAULT_LIMITS, allowCrypto: false },
        activeSymbols: ["BTC/USD"],
        candidatePool: ["BTC/USD"],
      }),
    );
    expect(reason).toContain("Market closed");
  });

  it("skips when the daily equity trade cap is exhausted and no crypto headroom", () => {
    const reason = actionablePreflight(
      inputs({ equityTradesToday: PAPER_DEFAULT_LIMITS.maxTradesPerDay }),
    );
    expect(reason).toContain("capacity exhausted");
  });

  it("skips when there are no candidates and no open positions", () => {
    const reason = actionablePreflight(inputs({ candidatePool: [], activeSymbols: [] }));
    expect(reason).toContain("No ranked candidates");
  });
});
