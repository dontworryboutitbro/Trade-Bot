// Outcome labeling — pure functions over daily bars. No look-ahead: a label at
// horizon H only exists once H trading days have elapsed since entry.

import type { Bar } from "@/lib/types";
import type { OutcomeLabel } from "./types";

export const LABEL_HORIZONS = [1, 3, 5, 10, 20];

export interface LabelInputs {
  sourceType: "observation" | "shadow";
  sourceId: string;
  symbol: string;
  entryAtIso: string;
  entryPrice: number;
  stopLossPct: number | null;
  estimatedCostBps: number | null;
  /** Daily bars from entry date onward (oldest→newest), entry day first. */
  barsAfterEntry: Bar[];
  /** SPY closes aligned to the same dates (entry day first). */
  spyClosesAfterEntry: number[];
  now: Date;
}

export function computeLabels(inputs: LabelInputs): OutcomeLabel[] {
  const labels: OutcomeLabel[] = [];
  const { barsAfterEntry: bars, entryPrice } = inputs;
  if (entryPrice <= 0 || bars.length === 0) return labels;
  const costPct = (inputs.estimatedCostBps ?? 20) / 100; // bps→pct, default 20 bps round trip

  for (const horizon of LABEL_HORIZONS) {
    const completed = bars.length > horizon;
    const window = bars.slice(0, horizon + 1);
    const last = window[window.length - 1];
    const exitPrice = last.close;
    const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const mfe = (Math.max(...window.map((b) => b.high)) / entryPrice - 1) * 100;
    const mae = (Math.min(...window.map((b) => b.low)) / entryPrice - 1) * 100;
    const stopTriggered =
      inputs.stopLossPct !== null ? mae <= -Math.abs(inputs.stopLossPct) : null;
    const spyWindow = inputs.spyClosesAfterEntry.slice(0, horizon + 1);
    const spyReturnPct =
      spyWindow.length >= 2 ? ((spyWindow[spyWindow.length - 1] - spyWindow[0]) / spyWindow[0]) * 100 : null;
    const afterCosts = returnPct - costPct;
    labels.push({
      sourceType: inputs.sourceType,
      sourceId: inputs.sourceId,
      symbol: inputs.symbol,
      horizonDays: horizon,
      interim: !completed,
      entryPrice,
      exitPrice,
      returnPct,
      returnAfterCostsPct: afterCosts,
      spyReturnPct,
      excessReturnPct: spyReturnPct === null ? null : returnPct - spyReturnPct,
      maxFavorableExcursionPct: mfe,
      maxAdverseExcursionPct: mae,
      stopWouldHaveTriggered: stopTriggered,
      abstainWasBetter: afterCosts < 0,
      labeledAt: inputs.now.toISOString(),
    });
  }
  return labels;
}
