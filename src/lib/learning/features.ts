// Feature-observation assembly. Pure: callers supply bars/snapshots/context.

import type { Bar } from "@/lib/types";
import type { QuoteSnapshot } from "@/lib/market-data/types";
import type { FeatureObservation } from "./types";

function retOver(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - n];
  return ((last - prior) / prior) * 100;
}

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((s, v) => s + v, 0) / n;
}

export function buildObservation(input: {
  source: FeatureObservation["source"];
  proposalId: string | null;
  symbol: string;
  assetClass: "us_equity" | "crypto";
  strategyId: string | null;
  strategyVersionId: string | null;
  regime: string | null;
  action: string;
  confidence: number | null;
  thesis: string | null;
  counterargument: string | null;
  invalidationCondition: string | null;
  symbolBars: Bar[];
  spyBars: Bar[];
  snapshot: QuoteSnapshot | null;
  positionsCount: number | null;
  cash: number | null;
  exposurePct: number | null;
  cooldownActive: boolean;
  riskResult: "PASS" | "BLOCK" | null;
  rejectionReasons: string[];
  actualFillPrice: number | null;
  estimatedCostBps: number | null;
  now: Date;
}): FeatureObservation {
  const closes = input.symbolBars.map((b) => b.close);
  const spyCloses = input.spyBars.map((b) => b.close);
  const close = closes[closes.length - 1] ?? null;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const high20 = closes.length >= 20 ? Math.max(...closes.slice(-20)) : null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const vol20 =
    rets.length >= 20
      ? Math.sqrt(
          rets.slice(-20).reduce((s, v) => s + v * v, 0) / 20,
        ) * Math.sqrt(252) * 100
      : null;
  const sym20 = retOver(closes, 20);
  const spy20 = retOver(spyCloses, 20);

  return {
    observedAt: input.now.toISOString(),
    source: input.source,
    proposalId: input.proposalId,
    symbol: input.symbol,
    assetClass: input.assetClass,
    strategyId: input.strategyId,
    strategyVersionId: input.strategyVersionId,
    regime: input.regime,
    action: input.action,
    confidence: input.confidence,
    thesis: input.thesis,
    counterargument: input.counterargument,
    invalidationCondition: input.invalidationCondition,
    spyReturns: {
      d1: retOver(spyCloses, 1),
      d5: retOver(spyCloses, 5),
      d20: spy20,
      d60: retOver(spyCloses, 60),
    },
    symbolReturns: {
      d1: retOver(closes, 1),
      d5: retOver(closes, 5),
      d20: sym20,
      d60: retOver(closes, 60),
    },
    relativeStrength20d: sym20 !== null && spy20 !== null ? sym20 - spy20 : null,
    bid: input.snapshot?.bid ?? null,
    ask: input.snapshot?.ask ?? null,
    mid: input.snapshot?.mid ?? null,
    spreadBps: input.snapshot?.spreadBps ?? null,
    quoteAgeMs: input.snapshot?.quoteAgeMs ?? null,
    dailyVolume: input.snapshot?.dailyVolume ?? null,
    realizedVolPct: vol20,
    maRelation: {
      aboveMa20: close !== null && ma20 !== null ? close > ma20 : null,
      aboveMa50: close !== null && ma50 !== null ? close > ma50 : null,
      ma20VsMa50: ma20 !== null && ma50 !== null ? ((ma20 - ma50) / ma50) * 100 : null,
    },
    drawdownFromHighPct:
      close !== null && high20 !== null ? ((high20 - close) / high20) * 100 : null,
    positionsCount: input.positionsCount,
    cash: input.cash,
    exposurePct: input.exposurePct,
    cooldownActive: input.cooldownActive,
    riskResult: input.riskResult,
    rejectionReasons: input.rejectionReasons,
    hypotheticalEntryPrice: input.snapshot?.mid ?? close,
    actualFillPrice: input.actualFillPrice,
    estimatedCostBps: input.estimatedCostBps,
  };
}
