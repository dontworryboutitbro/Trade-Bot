// Deterministic quote-quality rules. Pure functions — unit-testable, no I/O.

import type { QualityAssessment, QualityConfig, QuoteSnapshot } from "./types";
import { DEFAULT_QUALITY_CONFIG } from "./types";

export function isCryptoSymbol(symbol: string): boolean {
  return symbol.includes("/");
}

export function assessQuote(
  snapshot: QuoteSnapshot | null,
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): QualityAssessment {
  if (!snapshot) {
    return { ok: false, reasons: ["No quote snapshot available; freshness cannot be verified."] };
  }
  const reasons: string[] = [];
  const crypto = isCryptoSymbol(snapshot.symbol);

  if (snapshot.halted === true) reasons.push(`${snapshot.symbol} is halted.`);
  if (snapshot.stale || snapshot.quoteAgeMs > config.maxQuoteAgeMs) {
    reasons.push(
      `Quote stale: ${Math.round(snapshot.quoteAgeMs / 1000)}s old (max ${config.maxQuoteAgeMs / 1000}s).`,
    );
  }
  if (snapshot.bid === null || snapshot.ask === null || snapshot.bid <= 0 || snapshot.ask <= 0) {
    reasons.push("Missing or non-positive bid/ask.");
  } else {
    const cap = crypto ? config.cryptoMaxSpreadBps : config.maxSpreadBps;
    if (snapshot.spreadBps !== null && snapshot.spreadBps > cap) {
      reasons.push(
        `Spread ${snapshot.spreadBps.toFixed(1)} bps exceeds the ${cap} bps cap.`,
      );
    }
    if (snapshot.ask < snapshot.bid) reasons.push("Crossed market (ask < bid).");
  }
  if (!crypto && snapshot.dailyVolume !== null && snapshot.dailyVolume < config.minDailyVolume) {
    reasons.push(
      `Low liquidity: daily volume ${snapshot.dailyVolume.toLocaleString()} below ${config.minDailyVolume.toLocaleString()}.`,
    );
  }
  if (snapshot.liquidity === "LOW") reasons.push("Liquidity flagged LOW by the data layer.");

  return { ok: reasons.length === 0, reasons };
}

/** Build derived fields (mid/spread/staleness) from raw bid/ask inputs. */
export function deriveQuoteFields(input: {
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  quoteAgeMs: number;
  config?: QualityConfig;
}): Pick<QuoteSnapshot, "mid" | "spreadUsd" | "spreadBps" | "stale"> {
  const config = input.config ?? DEFAULT_QUALITY_CONFIG;
  const { bid, ask } = input;
  if (bid === null || ask === null || bid <= 0 || ask <= 0) {
    return { mid: input.lastTrade, spreadUsd: null, spreadBps: null, stale: input.quoteAgeMs > config.maxQuoteAgeMs };
  }
  const mid = (bid + ask) / 2;
  const spreadUsd = ask - bid;
  return {
    mid,
    spreadUsd,
    spreadBps: mid > 0 ? (spreadUsd / mid) * 10_000 : null,
    stale: input.quoteAgeMs > config.maxQuoteAgeMs,
  };
}
