import { describe, expect, it } from "vitest";
import { assessExecutionCost, estimateExecution } from "./cost-model";
import { planOrder } from "./order-policy";
import { activeCooldowns } from "./cooldowns";
import type { QuoteSnapshot } from "@/lib/market-data/types";

function snapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  const now = new Date().toISOString();
  return {
    symbol: "SPY",
    timestamp: now,
    capturedAt: now,
    bid: 599.9,
    ask: 600.1,
    mid: 600,
    lastTrade: 600,
    spreadUsd: 0.2,
    spreadBps: 3.33,
    quoteAgeMs: 500,
    source: "alpaca_rest",
    session: "REGULAR",
    dailyVolume: 50_000_000,
    avgDailyVolume: null,
    volatilityEstimate: null,
    stale: false,
    liquidity: "OK",
    halted: false,
    ...overrides,
  };
}

describe("execution cost model", () => {
  it("estimates buy fill above mid (crossing the spread)", () => {
    const est = estimateExecution(snapshot(), "buy", 2)!;
    expect(est.estimatedFillPrice).toBeGreaterThan(600);
    expect(est.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(assessExecutionCost(est).ok).toBe(true);
  });

  it("rejects when total cost exceeds the bps cap", () => {
    const wide = snapshot({ bid: 590, ask: 610, mid: 600, spreadUsd: 20, spreadBps: 333 });
    const est = estimateExecution(wide, "buy", 2)!;
    const result = assessExecutionCost(est);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("bps");
  });

  it("rejects orders that are too large relative to daily volume", () => {
    const thin = snapshot({ dailyVolume: 10_000 });
    const est = estimateExecution(thin, "buy", 500)!; // 5% of volume
    expect(assessExecutionCost(est).ok).toBe(false);
  });

  it("returns null when no usable price exists", () => {
    expect(estimateExecution(snapshot({ mid: null, lastTrade: null }), "buy", 1)).toBeNull();
  });
});

describe("order policy", () => {
  it("keeps market orders on tight spreads", () => {
    expect(planOrder("MARKET", null, "buy", snapshot()).type).toBe("MARKET");
  });

  it("converts market orders to marketable limits on wide spreads", () => {
    const wide = snapshot({ spreadBps: 60 });
    const plan = planOrder("MARKET", null, "buy", wide);
    expect(plan.type).toBe("LIMIT");
    expect(plan.limitPrice).toBeGreaterThan(600);
  });

  it("always routes crypto as a limit", () => {
    const btc = snapshot({ symbol: "BTC/USD", mid: 100_000, bid: 99_990, ask: 100_010, spreadBps: 2 });
    expect(planOrder("MARKET", null, "buy", btc).type).toBe("LIMIT");
  });

  it("respects AI-specified limit prices", () => {
    const plan = planOrder("LIMIT", 595, "buy", snapshot());
    expect(plan.limitPrice).toBe(595);
  });
});

describe("cooldowns", () => {
  const base = {
    symbol: "SPY",
    side: "buy" as const,
    now: new Date("2026-06-12T15:00:00Z"),
    lastEntryAt: null,
    lastLossExitAt: null,
    lastRejectionAt: null,
    lastKillSwitchResetAt: null,
    lastStaleDataIncidentAt: null,
  };

  it("no cooldowns with clean history", () => {
    expect(activeCooldowns(base)).toEqual([]);
  });

  it("blocks rapid re-entry into the same symbol", () => {
    const reasons = activeCooldowns({ ...base, lastEntryAt: "2026-06-12T14:30:00Z" });
    expect(reasons.join(" ")).toContain("Re-entry");
  });

  it("blocks averaging down after a loss", () => {
    const reasons = activeCooldowns({ ...base, lastLossExitAt: "2026-06-12T10:00:00Z" });
    expect(reasons.join(" ")).toContain("Post-loss");
  });

  it("blocks after rejections, kill-switch resets, and stale-data incidents", () => {
    expect(activeCooldowns({ ...base, lastRejectionAt: "2026-06-12T14:45:00Z" })).not.toEqual([]);
    expect(activeCooldowns({ ...base, lastKillSwitchResetAt: "2026-06-12T14:45:00Z" })).not.toEqual([]);
    expect(activeCooldowns({ ...base, lastStaleDataIncidentAt: "2026-06-12T14:50:00Z" })).not.toEqual([]);
  });

  it("never blocks exits", () => {
    expect(
      activeCooldowns({ ...base, side: "sell", lastLossExitAt: "2026-06-12T14:59:00Z" }),
    ).toEqual([]);
  });
});
