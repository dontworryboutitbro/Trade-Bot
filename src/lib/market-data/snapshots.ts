import "server-only";
// QuoteSnapshot acquisition: Alpaca REST for paper/live, synthetic for mock.
// A small in-memory TTL cache avoids hammering the data API within a request
// burst. REST + reconciliation remains the source of truth (no HFT streaming).

import { getEnv } from "@/lib/env";
import type { TradingMode } from "@/lib/types";
import { getMarketDataClient } from "@/lib/brokerage/factory";
import { deriveQuoteFields, isCryptoSymbol } from "./quality";
import type { MarketSession, QuoteSnapshot } from "./types";

 

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; snapshot: QuoteSnapshot }>();

function sessionFor(symbol: string, marketOpen: boolean | null): MarketSession {
  if (isCryptoSymbol(symbol)) return "CRYPTO_24_7";
  if (marketOpen === null) return "CLOSED";
  return marketOpen ? "REGULAR" : "CLOSED";
}

async function alpacaHeaders(mode: TradingMode) {
  const env = getEnv();
  const paper = mode === "PAPER_MANUAL" || mode === "PAPER_AUTONOMOUS";
  return {
    "APCA-API-KEY-ID": (paper ? env.ALPACA_PAPER_API_KEY : env.ALPACA_LIVE_API_KEY) ?? "",
    "APCA-API-SECRET-KEY": (paper ? env.ALPACA_PAPER_API_SECRET : env.ALPACA_LIVE_API_SECRET) ?? "",
  };
}

async function fetchAlpacaSnapshot(
  mode: TradingMode,
  symbol: string,
  marketOpen: boolean | null,
): Promise<QuoteSnapshot | null> {
  const env = getEnv();
  const headers = await alpacaHeaders(mode);
  const now = Date.now();
  const capturedAt = new Date(now).toISOString();

  if (isCryptoSymbol(symbol)) {
    const res = await fetch(
      `${env.ALPACA_DATA_BASE_URL}/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(symbol)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return null;
    const snap = (await res.json()).snapshots?.[symbol];
    if (!snap) return null;
    const bid = snap.latestQuote?.bp ? Number(snap.latestQuote.bp) : null;
    const ask = snap.latestQuote?.ap ? Number(snap.latestQuote.ap) : null;
    const lastTrade = snap.latestTrade?.p ? Number(snap.latestTrade.p) : null;
    const quoteTs = snap.latestQuote?.t ?? snap.latestTrade?.t ?? capturedAt;
    const quoteAgeMs = Math.max(0, now - new Date(quoteTs).getTime());
    const derived = deriveQuoteFields({ bid, ask, lastTrade, quoteAgeMs });
    return {
      symbol,
      timestamp: quoteTs,
      capturedAt,
      bid,
      ask,
      lastTrade,
      ...derived,
      quoteAgeMs,
      source: "alpaca_rest",
      session: "CRYPTO_24_7",
      dailyVolume: snap.dailyBar?.v ? Number(snap.dailyBar.v) : null,
      avgDailyVolume: null,
      volatilityEstimate: null,
      liquidity: bid && ask ? "OK" : "UNKNOWN",
      halted: null,
    };
  }

  const res = await fetch(
    `${env.ALPACA_DATA_BASE_URL}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbol)}&feed=iex`,
    { headers, cache: "no-store" },
  );
  if (!res.ok) return null;
  const snap = (await res.json())[symbol];
  if (!snap) return null;
  const bid = snap.latestQuote?.bp ? Number(snap.latestQuote.bp) : null;
  const ask = snap.latestQuote?.ap ? Number(snap.latestQuote.ap) : null;
  const lastTrade = snap.latestTrade?.p ? Number(snap.latestTrade.p) : null;
  const quoteTs = snap.latestQuote?.t ?? snap.latestTrade?.t ?? capturedAt;
  const quoteAgeMs = Math.max(0, now - new Date(quoteTs).getTime());
  const derived = deriveQuoteFields({ bid, ask, lastTrade, quoteAgeMs });
  const dailyVolume = snap.dailyBar?.v ? Number(snap.dailyBar.v) : null;
  return {
    symbol,
    timestamp: quoteTs,
    capturedAt,
    bid,
    ask,
    lastTrade,
    ...derived,
    quoteAgeMs,
    source: "alpaca_rest",
    session: sessionFor(symbol, marketOpen),
    dailyVolume,
    avgDailyVolume: null,
    volatilityEstimate: null,
    liquidity: dailyVolume === null ? "UNKNOWN" : dailyVolume > 100_000 ? "OK" : "LOW",
    halted: null,
  };
}

function mockSnapshot(symbol: string, price: number, marketOpen: boolean | null): QuoteSnapshot {
  const now = new Date();
  const half = price * 0.0003; // 6 bps synthetic spread
  const derived = deriveQuoteFields({
    bid: price - half,
    ask: price + half,
    lastTrade: price,
    quoteAgeMs: 0,
  });
  return {
    symbol,
    timestamp: now.toISOString(),
    capturedAt: now.toISOString(),
    bid: price - half,
    ask: price + half,
    lastTrade: price,
    ...derived,
    quoteAgeMs: 0,
    source: "mock",
    session: sessionFor(symbol, marketOpen),
    dailyVolume: 5_000_000,
    avgDailyVolume: 5_000_000,
    volatilityEstimate: 0.15,
    liquidity: "OK",
    halted: false,
  };
}

export async function getQuoteSnapshot(
  mode: TradingMode,
  symbol: string,
  marketOpen: boolean | null,
): Promise<QuoteSnapshot | null> {
  const key = `${mode}:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Recompute age so cached snapshots still go stale correctly.
    const ageMs = Date.now() - new Date(hit.snapshot.timestamp).getTime();
    return { ...hit.snapshot, quoteAgeMs: Math.max(0, ageMs) };
  }

  let snapshot: QuoteSnapshot | null = null;
  if (mode === "MOCK") {
    const quote = await getMarketDataClient(mode).getQuote(symbol);
    snapshot = quote ? mockSnapshot(symbol, quote.price, marketOpen) : null;
  } else {
    snapshot = await fetchAlpacaSnapshot(mode, symbol, marketOpen).catch(() => null);
  }
  if (snapshot) cache.set(key, { at: Date.now(), snapshot });
  return snapshot;
}
