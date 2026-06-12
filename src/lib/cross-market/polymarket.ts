import "server-only";
// Polymarket PUBLIC data access: Gamma API for discovery, CLOB public read
// endpoints for pricing. No authentication, no wallets, no order placement —
// this module exposes read functions only and never touches a brokerage.

/* eslint-disable @typescript-eslint/no-explicit-any */

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

export interface PolymarketQuote {
  slug: string;
  question: string;
  endDate: string | null;
  yesTokenId: string | null;
  yesBestBid: number | null;
  yesBestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  lastTrade: number | null;
  depthUsd: number | null;
  quoteAgeMs: number;
  capturedAt: string;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 120 },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Find an active market by free-text search; returns the best active match. */
export async function findMarket(query: string): Promise<any | null> {
  const data = await getJson(
    `${GAMMA}/markets?closed=false&limit=20&order=volumeNum&ascending=false&search=${encodeURIComponent(query)}`,
  );
  if (Array.isArray(data) && data.length > 0) return data[0];
  // Fallback: public-search endpoint shape differs between deployments.
  const events = await getJson(
    `${GAMMA}/events?closed=false&limit=10&search=${encodeURIComponent(query)}`,
  );
  const event = Array.isArray(events) ? events[0] : null;
  return event?.markets?.[0] ?? null;
}

export async function getMarketBySlug(slug: string): Promise<any | null> {
  const data = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/** Public CLOB pricing for the YES token of a market. */
export async function getQuote(market: any): Promise<PolymarketQuote | null> {
  if (!market) return null;
  const capturedAt = new Date().toISOString();
  let yesTokenId: string | null = null;
  try {
    const tokenIds = JSON.parse(market.clobTokenIds ?? "[]");
    yesTokenId = tokenIds[0] ?? null;
  } catch {
    yesTokenId = null;
  }

  let yesBestBid: number | null = null;
  let yesBestAsk: number | null = null;
  let midpoint: number | null = null;
  let spread: number | null = null;
  let lastTrade: number | null = null;
  let depthUsd: number | null = null;

  if (yesTokenId) {
    const [mid, book, last] = await Promise.all([
      getJson(`${CLOB}/midpoint?token_id=${yesTokenId}`),
      getJson(`${CLOB}/book?token_id=${yesTokenId}`),
      getJson(`${CLOB}/last-trade-price?token_id=${yesTokenId}`),
    ]);
    midpoint = mid?.mid ? Number(mid.mid) : null;
    lastTrade = last?.price ? Number(last.price) : null;
    if (book) {
      const bestBid = book.bids?.length ? Number(book.bids[book.bids.length - 1].price) : null;
      const bestAsk = book.asks?.length ? Number(book.asks[book.asks.length - 1].price) : null;
      yesBestBid = bestBid;
      yesBestAsk = bestAsk;
      if (bestBid !== null && bestAsk !== null) spread = bestAsk - bestBid;
      const near = (level: any) => Number(level.price) * Number(level.size);
      depthUsd =
        (book.bids ?? []).slice(-5).reduce((sum: number, l: any) => sum + near(l), 0) +
        (book.asks ?? []).slice(-5).reduce((sum: number, l: any) => sum + near(l), 0);
    }
  }
  // Gamma fallback pricing if CLOB endpoints fail.
  if (midpoint === null && market.lastTradePrice) midpoint = Number(market.lastTradePrice);
  if (spread === null && market.spread) spread = Number(market.spread);

  return {
    slug: market.slug ?? "",
    question: market.question ?? market.title ?? "Unknown market",
    endDate: market.endDate ?? market.endDateIso ?? null,
    yesTokenId,
    yesBestBid,
    yesBestAsk,
    midpoint,
    spread,
    lastTrade,
    depthUsd,
    quoteAgeMs: 0, // freshly fetched; history layer tracks persistence
    capturedAt,
  };
}
