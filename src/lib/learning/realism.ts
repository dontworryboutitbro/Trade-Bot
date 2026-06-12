// Paper-trading realism penalties. Paper fills are optimistic; promotion
// decisions use stress-tested P/L, never raw paper P/L. Pure functions.

export interface RealismConfig {
  extraSpreadBps: number;
  extraSlippageBps: number;
  partialFillHaircutPct: number; // % of profit assumed lost to partial fills
  staleQuoteBps: number; // applied when data quality was degraded
  marketImpactBps: number;
  lowLiquidityBps: number; // applied when liquidity was flagged
  highVolBps: number; // applied in VOLATILITY_SPIKE regime
}

export const DEFAULT_REALISM: RealismConfig = {
  extraSpreadBps: 5,
  extraSlippageBps: 8,
  partialFillHaircutPct: 5,
  staleQuoteBps: 15,
  marketImpactBps: 4,
  lowLiquidityBps: 10,
  highVolBps: 10,
};

export interface RealismInputs {
  grossPlUsd: number;
  notionalUsd: number;
  dataQualityOk: boolean;
  lowLiquidity: boolean;
  volatilitySpikeRegime: boolean;
}

export interface StressedResult {
  rawPlUsd: number;
  penaltyUsd: number;
  stressedPlUsd: number;
  penaltyBpsApplied: number;
}

export function stressTestPl(
  inputs: RealismInputs,
  config: RealismConfig = DEFAULT_REALISM,
): StressedResult {
  let bps = config.extraSpreadBps + config.extraSlippageBps + config.marketImpactBps;
  if (!inputs.dataQualityOk) bps += config.staleQuoteBps;
  if (inputs.lowLiquidity) bps += config.lowLiquidityBps;
  if (inputs.volatilitySpikeRegime) bps += config.highVolBps;

  let penaltyUsd = inputs.notionalUsd * (bps / 10_000);
  // Partial-fill haircut applies only to profits (you don't get the full size
  // of winners; losers fill fine).
  if (inputs.grossPlUsd > 0) {
    penaltyUsd += inputs.grossPlUsd * (config.partialFillHaircutPct / 100);
  }
  return {
    rawPlUsd: inputs.grossPlUsd,
    penaltyUsd,
    stressedPlUsd: inputs.grossPlUsd - penaltyUsd,
    penaltyBpsApplied: bps,
  };
}
