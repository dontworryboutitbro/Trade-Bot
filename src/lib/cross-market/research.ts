import "server-only";
// Assembles the featured Cross-Market Research rows. Read-only: outputs are
// research rows; there is no execution path from here to any brokerage.

import { getStore } from "@/lib/store";
import { getMarketDataClient } from "@/lib/brokerage/factory";
import { classifyMatch, isNotable, scoreDivergence } from "./scoring";
import { findMarket, getQuote } from "./polymarket";
import type { CrossMarketRow } from "./types";

 

interface FeaturedSpec {
  key: string;
  event: string;
  searchQuery: string;
  intendedExpiry: string;
  externalMethod: string;
  /** Returns [probability 0..1 | null, isProxy]. */
  externalProbability: () => Promise<[number | null, boolean]>;
  settlementRulesComparable: boolean;
}

/** Normal CDF approximation (Abramowitz–Stegun). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return x > 0 ? p : 1 - (1 - p);
}

/**
 * Proxy probability that an asset closes above `threshold` at `expiry`, from a
 * lognormal model on the current price and realized volatility. Clearly a
 * model-based proxy — rows using it are at best CLOSE_PROXY.
 */
async function thresholdProxyProbability(
  symbol: string,
  threshold: number,
  expiryIso: string,
): Promise<[number | null, boolean]> {
  try {
    const store = await getStore();
    const settings = await store.getSettings();
    const marketData = getMarketDataClient(settings.tradingMode);
    const bars = await marketData.getDailyBars(symbol, 40);
    if (bars.length < 20) return [null, true];
    const closes = bars.map((b) => b.close);
    const price = closes[closes.length - 1];
    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const vol = Math.sqrt(
      rets.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, rets.length - 1),
    );
    const daysToExpiry = Math.max(
      1,
      (new Date(expiryIso).getTime() - Date.now()) / 86_400_000,
    );
    const sigma = vol * Math.sqrt(daysToExpiry);
    if (sigma <= 0) return [null, true];
    const z = Math.log(threshold / price) / sigma; // drift ≈ 0 over short windows
    return [Math.max(0.001, Math.min(0.999, 1 - normCdf(z))), true];
  } catch {
    return [null, true];
  }
}

function endOfMonth(monthsAhead: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + monthsAhead + 1, 0);
  d.setUTCHours(23, 59, 59, 0);
  return d.toISOString();
}

function featuredSpecs(): FeaturedSpec[] {
  return [
    {
      key: "fomc-next",
      event: "Fed rate cut at the next FOMC meeting",
      searchQuery: "fed rate cut",
      intendedExpiry: endOfMonth(1),
      externalMethod: "No free executable external market (CME FedWatch is unlicensed data)",
      externalProbability: async () => [null, true],
      settlementRulesComparable: true,
    },
    {
      key: "fomc-following",
      event: "Fed rate cut at the following FOMC meeting",
      searchQuery: "fed rate cut september",
      intendedExpiry: endOfMonth(3),
      externalMethod: "No free executable external market",
      externalProbability: async () => [null, true],
      settlementRulesComparable: true,
    },
    {
      key: "btc-threshold",
      event: "BTC above $120k at month end",
      searchQuery: "bitcoin 120",
      intendedExpiry: endOfMonth(0),
      externalMethod: "Lognormal proxy from Alpaca BTC/USD spot + 40d realized vol",
      externalProbability: () => thresholdProxyProbability("BTC/USD", 120_000, endOfMonth(0)),
      settlementRulesComparable: true,
    },
    {
      key: "spx-threshold",
      event: "S&P 500 above 7000 at year end (SPY proxy comparison)",
      searchQuery: "s&p 7000",
      intendedExpiry: `${new Date().getUTCFullYear()}-12-31T23:59:59Z`,
      externalMethod:
        "Lognormal proxy from SPY spot + 40d realized vol (SPY ≈ SPX/10 — clearly a proxy)",
      externalProbability: () =>
        thresholdProxyProbability("SPY", 700, `${new Date().getUTCFullYear()}-12-31T23:59:59Z`),
      settlementRulesComparable: false, // SPY price vs SPX index settlement differs
    },
  ];
}

export async function buildCrossMarketRows(): Promise<CrossMarketRow[]> {
  const specs = featuredSpecs();
  const rows = await Promise.all(
    specs.map(async (spec): Promise<CrossMarketRow> => {
      const capturedAt = new Date().toISOString();
      const market = await findMarket(spec.searchQuery);
      const quote = market ? await getQuote(market) : null;
      const [externalProb, externalIsProxy] = await spec.externalProbability();

      const { quality, explanation } = classifyMatch({
        hasPolymarketData: Boolean(quote && quote.midpoint !== null),
        hasExternalProbability: externalProb !== null,
        externalIsProxy,
        intendedExpiry: spec.intendedExpiry,
        actualExpiry: quote?.endDate ?? null,
        settlementRulesComparable: spec.settlementRulesComparable,
        quoteAgeMs: quote?.quoteAgeMs ?? null,
        depthUsd: quote?.depthUsd ?? null,
      });
      const { rawDivergence, netDivergence } = scoreDivergence({
        midpoint: quote?.midpoint ?? null,
        spread: quote?.spread ?? null,
        externalImpliedProbability: externalProb,
      });

      return {
        key: spec.key,
        event: spec.event,
        polymarketSlug: quote?.slug ?? null,
        intendedExpiry: spec.intendedExpiry,
        actualExpiry: quote?.endDate ?? null,
        yesBestBid: quote?.yesBestBid ?? null,
        yesBestAsk: quote?.yesBestAsk ?? null,
        midpoint: quote?.midpoint ?? null,
        spread: quote?.spread ?? null,
        lastTrade: quote?.lastTrade ?? null,
        depthUsd: quote?.depthUsd ?? null,
        quoteAgeMs: quote?.quoteAgeMs ?? null,
        liquidityOk: (quote?.depthUsd ?? 0) >= 500,
        externalImpliedProbability: externalProb,
        externalMethod: spec.externalMethod,
        rawDivergence,
        netDivergence,
        matchQuality: quality,
        mismatchExplanation: explanation,
        dataSource: quote ? "polymarket_gamma+clob" : "fallback",
        sourceStatus: quote ? (quote.midpoint !== null ? "OK" : "DEGRADED") : "UNAVAILABLE",
        sparkline: [],
        capturedAt,
      };
    }),
  );

  // Persist snapshots for sparkline history + notable-divergence alerts.
  try {
    const store = await getStore();
    for (const row of rows) {
      await store.saveCrossMarketSnapshot?.(row);
      if (isNotable(row)) {
        await store.createNotification({
          notificationType: "CROSS_MARKET_DIVERGENCE",
          severity: "INFO",
          title: `Cross-market divergence: ${row.event}`,
          message: `Net divergence ${(row.netDivergence! * 100).toFixed(1)} pts (${row.matchQuality}). Research only — not executable arbitrage.`,
        });
      }
    }
    // Attach 7-day sparkline history.
    for (const row of rows) {
      row.sparkline = (await store.listCrossMarketHistory?.(row.key, 7)) ?? [];
    }
  } catch {
    // History/alerts are best-effort; rows still render.
  }
  return rows;
}
