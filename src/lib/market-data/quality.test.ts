import { describe, expect, it } from "vitest";
import { assessQuote, deriveQuoteFields } from "./quality";
import type { QuoteSnapshot } from "./types";

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
    quoteAgeMs: 1000,
    source: "alpaca_rest",
    session: "REGULAR",
    dailyVolume: 50_000_000,
    avgDailyVolume: 60_000_000,
    volatilityEstimate: 0.14,
    stale: false,
    liquidity: "OK",
    halted: false,
    ...overrides,
  };
}

describe("quote quality", () => {
  it("passes a clean fresh quote", () => {
    expect(assessQuote(snapshot()).ok).toBe(true);
  });

  it("rejects a missing snapshot (freshness unverifiable)", () => {
    const result = assessQuote(null);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("freshness");
  });

  it("rejects stale quotes", () => {
    const result = assessQuote(snapshot({ quoteAgeMs: 10 * 60 * 1000, stale: true }));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("stale");
  });

  it("rejects missing bid/ask", () => {
    expect(assessQuote(snapshot({ bid: null })).ok).toBe(false);
    expect(assessQuote(snapshot({ ask: null })).ok).toBe(false);
  });

  it("rejects unusually wide spreads", () => {
    const result = assessQuote(snapshot({ spreadBps: 80 }));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("Spread");
  });

  it("allows wider spreads for crypto than equities", () => {
    expect(assessQuote(snapshot({ symbol: "BTC/USD", spreadBps: 80 })).ok).toBe(true);
    expect(assessQuote(snapshot({ symbol: "BTC/USD", spreadBps: 150 })).ok).toBe(false);
  });

  it("rejects insufficient liquidity", () => {
    expect(assessQuote(snapshot({ dailyVolume: 5_000 })).ok).toBe(false);
    expect(assessQuote(snapshot({ liquidity: "LOW" })).ok).toBe(false);
  });

  it("rejects halted securities", () => {
    expect(assessQuote(snapshot({ halted: true })).ok).toBe(false);
  });

  it("derives mid and spread correctly", () => {
    const derived = deriveQuoteFields({ bid: 99, ask: 101, lastTrade: 100, quoteAgeMs: 0 });
    expect(derived.mid).toBe(100);
    expect(derived.spreadUsd).toBe(2);
    expect(derived.spreadBps).toBeCloseTo(200);
    expect(derived.stale).toBe(false);
  });
});
