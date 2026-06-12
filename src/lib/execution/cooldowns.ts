// Deterministic cooldown rules derived from stored order/proposal history.
// Pure function over inputs the pipeline assembles — no I/O here.

export interface CooldownConfig {
  /** Minimum minutes between new entries into the same symbol. */
  perSymbolEntryMinutes: number;
  /** Hours to wait before re-buying a symbol after a realized-loss exit. */
  afterLossHours: number;
  /** Minutes to wait after an order rejection/failure on a symbol. */
  afterRejectionMinutes: number;
  /** Minutes to wait after a kill-switch reset before any new entry. */
  afterKillSwitchResetMinutes: number;
  /** Minutes to wait after a stale-data incident on a symbol. */
  afterStaleDataMinutes: number;
}

export const DEFAULT_COOLDOWNS: CooldownConfig = {
  perSymbolEntryMinutes: 60,
  afterLossHours: 24,
  afterRejectionMinutes: 30,
  afterKillSwitchResetMinutes: 30,
  afterStaleDataMinutes: 15,
};

export interface CooldownInputs {
  symbol: string;
  side: "buy" | "sell";
  now: Date;
  lastEntryAt: string | null; // last buy order for this symbol
  lastLossExitAt: string | null; // last realized-loss sell for this symbol
  lastRejectionAt: string | null; // last REJECTED/FAILED order for this symbol
  lastKillSwitchResetAt: string | null;
  lastStaleDataIncidentAt: string | null; // for this symbol
}

export function activeCooldowns(
  inputs: CooldownInputs,
  config: CooldownConfig = DEFAULT_COOLDOWNS,
): string[] {
  // Cooldowns gate new entries only; exits are always allowed.
  if (inputs.side === "sell") return [];
  const reasons: string[] = [];
  const now = inputs.now.getTime();
  const minutesSince = (iso: string | null) =>
    iso === null ? Infinity : (now - new Date(iso).getTime()) / 60_000;

  if (minutesSince(inputs.lastEntryAt) < config.perSymbolEntryMinutes) {
    reasons.push(
      `Re-entry cooldown: bought ${inputs.symbol} less than ${config.perSymbolEntryMinutes} minutes ago.`,
    );
  }
  if (minutesSince(inputs.lastLossExitAt) < config.afterLossHours * 60) {
    reasons.push(
      `Post-loss cooldown: ${inputs.symbol} exited at a loss within the last ${config.afterLossHours}h (no averaging down / revenge entries).`,
    );
  }
  if (minutesSince(inputs.lastRejectionAt) < config.afterRejectionMinutes) {
    reasons.push(
      `Post-rejection cooldown: an order on ${inputs.symbol} was rejected/failed within ${config.afterRejectionMinutes} minutes.`,
    );
  }
  if (minutesSince(inputs.lastKillSwitchResetAt) < config.afterKillSwitchResetMinutes) {
    reasons.push(
      `Kill-switch cooldown: the kill switch was reset within the last ${config.afterKillSwitchResetMinutes} minutes.`,
    );
  }
  if (minutesSince(inputs.lastStaleDataIncidentAt) < config.afterStaleDataMinutes) {
    reasons.push(
      `Data-quality cooldown: ${inputs.symbol} had a stale-data incident within ${config.afterStaleDataMinutes} minutes.`,
    );
  }
  return reasons;
}
