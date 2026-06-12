import "server-only";
// Journal analytics: derive per-strategy paper stats (round trips, expectancy,
// win rate) from journal entries + orders. Used by Strategy Lab, the Paper
// Journal page, and the promotion gates.

import type { JournalEntryRow, StoredOrder } from "@/lib/store/types";
import type { StrategyPaperStats } from "@/lib/strategies/promotion";

export interface RoundTrip {
  symbol: string;
  strategyId: string | null;
  regime: string | null;
  confidence: number | null;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  plUsd: number;
  plPct: number;
  holdingDays: number;
  estimatedCostsUsd: number;
}

/** Pair buys with subsequent sells per symbol (FIFO) to form round trips. */
export function deriveRoundTrips(
  entries: JournalEntryRow[],
  orders: StoredOrder[],
): RoundTrip[] {
  const fills = orders
    .filter((o) => o.status === "FILLED" && o.filledAvgPrice)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const entryMetaByOrderId = new Map(entries.map((e) => [e.orderId, e]));
  const lots = new Map<
    string,
    { price: number; qty: number; at: string; meta: JournalEntryRow | undefined; costs: number }[]
  >();
  const trips: RoundTrip[] = [];

  for (const fill of fills) {
    const meta = entryMetaByOrderId.get(fill.id);
    const estCost =
      (meta?.costEstimate as { totalEstimatedCostUsd?: number } | null)?.totalEstimatedCostUsd ?? 0;
    if (fill.side === "buy") {
      const queue = lots.get(fill.symbol) ?? [];
      queue.push({
        price: fill.filledAvgPrice!,
        qty: fill.filledQuantity,
        at: fill.submittedAt,
        meta,
        costs: estCost,
      });
      lots.set(fill.symbol, queue);
    } else {
      let remaining = fill.filledQuantity;
      const queue = lots.get(fill.symbol) ?? [];
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0];
        const qty = Math.min(remaining, lot.qty);
        const plUsd = (fill.filledAvgPrice! - lot.price) * qty;
        trips.push({
          symbol: fill.symbol,
          strategyId: lot.meta?.strategyId ?? meta?.strategyId ?? null,
          regime: lot.meta?.regime ?? null,
          confidence: lot.meta?.confidence ?? null,
          entryAt: lot.at,
          exitAt: fill.submittedAt,
          entryPrice: lot.price,
          exitPrice: fill.filledAvgPrice!,
          quantity: qty,
          plUsd,
          plPct: (plUsd / (lot.price * qty)) * 100,
          holdingDays:
            (new Date(fill.submittedAt).getTime() - new Date(lot.at).getTime()) / 86_400_000,
          estimatedCostsUsd: lot.costs * (qty / Math.max(lot.qty, 1e-9)) + estCost,
        });
        lot.qty -= qty;
        remaining -= qty;
        if (lot.qty <= 1e-9) queue.shift();
      }
    }
  }
  return trips;
}

export function statsForStrategy(
  strategyId: string,
  trips: RoundTrip[],
  entries: JournalEntryRow[],
  outOfSampleScore: number | null,
): StrategyPaperStats {
  const mine = trips.filter((t) => t.strategyId === strategyId);
  const myEntries = entries.filter((e) => e.strategyId === strategyId);
  const days = new Set(myEntries.map((e) => e.createdAt.slice(0, 10))).size;
  const netPls = mine.map((t) => t.plUsd - t.estimatedCostsUsd);
  const expectancy = netPls.length ? netPls.reduce((s, v) => s + v, 0) / netPls.length : 0;

  // Equity-path drawdown across this strategy's round trips.
  let equity = 0;
  let peak = 0;
  let maxDdUsd = 0;
  for (const pl of netPls) {
    equity += pl;
    peak = Math.max(peak, equity);
    maxDdUsd = Math.max(maxDdUsd, peak - equity);
  }
  const grossInvested = mine.reduce((s, t) => s + t.entryPrice * t.quantity, 0);
  const maxDrawdownPct = grossInvested > 0 ? (maxDdUsd / grossInvested) * 100 : 0;

  const costBps = mine.length
    ? mine.reduce(
        (s, t) => s + (t.estimatedCostsUsd / Math.max(t.entryPrice * t.quantity, 1)) * 10_000,
        0,
      ) / mine.length
    : null;
  const recent = mine.filter(
    (t) => new Date(t.exitAt).getTime() > Date.now() - 30 * 86_400_000,
  );
  const recentPl = recent.reduce((s, t) => s + t.plUsd, 0);
  const recentBase = recent.reduce((s, t) => s + t.entryPrice * t.quantity, 0);

  return {
    paperTradeCount: mine.length,
    tradingDays: days,
    expectancyAfterCostsUsd: expectancy,
    maxDrawdownPct,
    excessReturnVsSpyPct: 0, // computed against SPY at page level when snapshots exist
    outOfSampleScore,
    avgExecutionCostBps: costBps,
    unresolvedReconciliationErrors: 0,
    staleDataIncidents30d: myEntries.filter((e) => !e.dataQualityOk).length,
    safetyViolations: 0,
    rolling30dReturnPct: recentBase > 0 ? (recentPl / recentBase) * 100 : null,
  };
}
