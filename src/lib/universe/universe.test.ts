import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/types";
import type { QuoteSnapshot } from "@/lib/market-data/types";
import {
  classifyCrypto,
  classifyEquity,
  estimateCryptoCostBps,
  type CryptoEvidence,
  type EquityEvidence,
} from "./filters";
import { rankCandidates, scoreCandidate } from "./ranking";
import { MAX_AI_CANDIDATES, type UniverseAsset } from "./types";

function asset(overrides: Partial<UniverseAsset> = {}): UniverseAsset {
  return {
    symbol: "AAPL", name: "Apple Inc", assetClass: "us_equity", exchange: "NASDAQ",
    active: true, tradable: true, fractionable: true, shortable: true, marginable: true,
    firstSeenAt: "2026-01-01T00:00:00Z", refreshedAt: new Date().toISOString(),
    source: "alpaca_assets_api", ...overrides,
  };
}

function snapshot(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  const now = new Date().toISOString();
  return {
    symbol: "AAPL", timestamp: now, capturedAt: now, bid: 199.9, ask: 200.1, mid: 200,
    lastTrade: 200, spreadUsd: 0.2, spreadBps: 10, quoteAgeMs: 500, source: "alpaca_rest",
    session: "REGULAR", dailyVolume: 60_000_000, avgDailyVolume: null, volatilityEstimate: null,
    stale: false, liquidity: "OK", halted: false, ...overrides,
  };
}

function bars(days: number, base = 200, driftPct = 0.1): Bar[] {
  return Array.from({ length: days }, (_, i) => {
    const close = base * (1 + (i * driftPct) / 100);
    return {
      symbol: "AAPL",
      timestamp: new Date(Date.UTC(2026, 0, 2 + i)).toISOString(),
      open: close * 0.999, high: close * 1.005, low: close * 0.995, close,
      volume: 50_000_000,
    };
  });
}

function evidence(overrides: Partial<EquityEvidence> = {}): EquityEvidence {
  return {
    asset: asset(),
    snapshot: snapshot(),
    bars: bars(90),
    unresolvedDataQualityIncident: false,
    ...overrides,
  };
}

describe("equity universe filters", () => {
  it("a liquid seasoned large-cap reaches PAPER_EXECUTION_UNIVERSE", () => {
    const result = classifyEquity(evidence(), undefined, new Set());
    expect(result.layer).toBe("PAPER_EXECUTION_UNIVERSE");
    expect(result.reasons).toEqual([]);
  });

  it("fully rejects inactive, non-tradable, OTC, and denylisted assets", () => {
    expect(classifyEquity(evidence({ asset: asset({ active: false }) }), undefined, new Set()).layer).toBe("REJECTED");
    expect(classifyEquity(evidence({ asset: asset({ tradable: false }) }), undefined, new Set()).layer).toBe("REJECTED");
    expect(classifyEquity(evidence({ asset: asset({ exchange: "OTC" }) }), undefined, new Set()).layer).toBe("REJECTED");
    expect(classifyEquity(evidence(), undefined, new Set(["AAPL"])).layer).toBe("REJECTED");
  });

  it("missing or stale quotes stop at DISCOVERY (research needs data)", () => {
    expect(classifyEquity(evidence({ snapshot: null }), undefined, new Set()).layer).toBe("DISCOVERY_UNIVERSE");
    const stale = classifyEquity(evidence({ snapshot: snapshot({ stale: true }) }), undefined, new Set());
    expect(stale.layer).toBe("DISCOVERY_UNIVERSE");
    expect(stale.reasons.join(" ")).toContain("stale");
  });

  it("leveraged and inverse ETFs never reach paper execution", () => {
    const lev = classifyEquity(evidence({ asset: asset({ name: "ProShares UltraPro 3x QQQ" }) }), undefined, new Set());
    expect(lev.layer).toBe("RESEARCH_UNIVERSE");
    expect(lev.reasons.join(" ")).toContain("Leveraged");
    const inv = classifyEquity(evidence({ asset: asset({ name: "Direxion Inverse Bear ETF" }) }), undefined, new Set());
    expect(inv.reasons.join(" ")).toContain("Inverse");
  });

  it("enforces price, spread, dollar-volume, seasoning, halt, and vol-spike rules", () => {
    const cheap = classifyEquity(
      evidence({ snapshot: snapshot({ mid: 3, lastTrade: 3, bid: 2.99, ask: 3.01 }) }), undefined, new Set());
    expect(cheap.reasons.join(" ")).toContain("below $5");

    const wide = classifyEquity(evidence({ snapshot: snapshot({ spreadBps: 60 }) }), undefined, new Set());
    expect(wide.reasons.join(" ")).toContain("Spread");

    const thinBars = bars(90).map((b) => ({ ...b, volume: 1000 }));
    const thin = classifyEquity(evidence({ bars: thinBars }), undefined, new Set());
    expect(thin.reasons.join(" ")).toContain("dollar volume");

    const young = classifyEquity(evidence({ bars: bars(25) }), undefined, new Set());
    expect(young.layer).toBe("RESEARCH_UNIVERSE"); // 25 bars: research ok, execution blocked
    expect(young.reasons.join(" ")).toContain("recent bars");

    const halted = classifyEquity(evidence({ snapshot: snapshot({ halted: true }) }), undefined, new Set());
    expect(halted.reasons.join(" ")).toContain("halted");

    const wild = bars(90).map((b, i) => ({ ...b, close: 200 * (1 + Math.sin(i * 2.5) * 0.15) }));
    const spiky = classifyEquity(evidence({ bars: wild }), undefined, new Set());
    expect(spiky.reasons.join(" ")).toContain("spike");
  });
});

describe("crypto universe filters", () => {
  function cryptoEvidence(overrides: Partial<CryptoEvidence> = {}): CryptoEvidence {
    return {
      asset: asset({ symbol: "BTC/USD", name: "Bitcoin", assetClass: "crypto", exchange: "CRYPTO" }),
      snapshot: snapshot({ symbol: "BTC/USD", mid: 100_000, bid: 99_980, ask: 100_020, spreadBps: 4, dailyVolume: 500 }),
      bars: bars(60, 100_000, 0.05),
      accountCryptoEligible: true,
      unresolvedDataQualityIncident: false,
      ...overrides,
    };
  }

  it("an eligible liquid pair reaches PAPER_EXECUTION_UNIVERSE", () => {
    expect(classifyCrypto(cryptoEvidence(), undefined, new Set()).layer).toBe("PAPER_EXECUTION_UNIVERSE");
  });

  it("non-USD pairs are rejected", () => {
    const result = classifyCrypto(
      cryptoEvidence({ asset: asset({ symbol: "BTC/USDT", assetClass: "crypto" }) }), undefined, new Set());
    expect(result.layer).toBe("REJECTED");
  });

  it("unknown account eligibility blocks execution (research only)", () => {
    const result = classifyCrypto(cryptoEvidence({ accountCryptoEligible: null }), undefined, new Set());
    expect(result.layer).toBe("RESEARCH_UNIVERSE");
    expect(result.reasons.join(" ")).toContain("eligibility");
  });

  it("includes the fee model and blocks when spread blows the cost budget", () => {
    const fee = estimateCryptoCostBps(cryptoEvidence().snapshot!);
    expect(fee).not.toBeNull();
    expect(fee!).toBeGreaterThanOrEqual(25); // taker fee floor
    const wide = classifyCrypto(
      cryptoEvidence({ snapshot: snapshot({ symbol: "BTC/USD", mid: 100_000, spreadBps: 90, dailyVolume: 500 }) }),
      undefined, new Set());
    expect(wide.reasons.join(" ")).toContain("Spread");
  });

  it("rejects thin 24h dollar volume", () => {
    const thin = classifyCrypto(
      cryptoEvidence({ snapshot: snapshot({ symbol: "DUST/USD", mid: 2, bid: 1.99, ask: 2.01, spreadBps: 10, dailyVolume: 1000 }) }),
      undefined, new Set());
    expect(thin.reasons.join(" ")).toContain("dollar volume");
  });
});

describe("candidate ranking", () => {
  it("scores deterministically and caps the AI candidate set", () => {
    const now = new Date("2026-06-12T15:00:00Z");
    const scores = Array.from({ length: 30 }, (_, i) =>
      scoreCandidate({
        symbol: `SYM${i}`,
        assetClass: "us_equity",
        snapshot: snapshot({ spreadBps: 5 + i }),
        bars: bars(90, 100 + i, 0.2),
        spyBars: bars(90, 500, 0.1),
        eligibleLayer: "PAPER_EXECUTION_UNIVERSE",
        now,
      }),
    );
    const a = rankCandidates(scores, MAX_AI_CANDIDATES);
    const b = rankCandidates(scores, MAX_AI_CANDIDATES);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(MAX_AI_CANDIDATES);
    expect(a[0].score).toBeGreaterThanOrEqual(a[a.length - 1].score);
  });

  it("never ranks assets outside the paper-execution universe", () => {
    const blocked = scoreCandidate({
      symbol: "BAD",
      assetClass: "us_equity",
      snapshot: snapshot(),
      bars: bars(90),
      spyBars: bars(90, 500, 0.1),
      eligibleLayer: "RESEARCH_UNIVERSE",
      now: new Date(),
    });
    expect(rankCandidates([blocked], 10)).toEqual([]);
  });

  it("MAX_AI_CANDIDATES stays small — the whole market is never prompted", () => {
    expect(MAX_AI_CANDIDATES).toBeLessThanOrEqual(10);
  });
});
