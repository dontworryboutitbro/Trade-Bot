import "server-only";
// Weekly deep validation: full backtests + walk-forward for champions and
// challengers, promotion-gate evaluation (manual approval always required),
// and automatic rollback checks. Never touches live settings.

import { getMarketDataClient } from "@/lib/brokerage/factory";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "@/lib/backtest/engine";
import { computeMetrics } from "@/lib/backtest/metrics";
import { runWalkForward } from "@/lib/backtest/walk-forward";
import { classifyRegime } from "@/lib/regime/engine";
import { BENCHMARK_SYMBOL } from "@/lib/config";
import { alert, audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import { getStrategy, withParams } from "@/lib/strategies/definitions";
import { modeToEnvironment, type Bar } from "@/lib/types";
import { evaluateChallengerPromotion, evaluateRollback, type ShadowStats } from "./promotion";
import { ensureChampions } from "./daily-review";
import { deriveRoundTrips } from "@/lib/journal-stats";
import { stressTestPl } from "./realism";
import type { ShadowProposal, StrategyVersion, WeeklyValidationReport } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

function shadowStatsFor(
  version: StrategyVersion,
  closedShadows: ShadowProposal[],
  championExpectancy: number | null,
  outOfSampleScore: number | null,
): ShadowStats {
  const mine = closedShadows.filter((s) => s.versionId === version.versionId);
  const pls = mine.map((s) => s.plPctAfterCosts ?? 0);
  const expectancy = pls.length ? pls.reduce((a, b) => a + b, 0) / pls.length : null;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pl of pls) {
    equity += pl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const totalProfit = pls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const biggest = Math.max(0, ...pls);
  const shadowDays = version.shadowStartedAt
    ? Math.floor((Date.now() - new Date(version.shadowStartedAt).getTime()) / 86_400_000)
    : 0;
  return {
    shadowTradingDays: shadowDays,
    closedShadowTrades: mine.length,
    stressedExpectancyPct: expectancy,
    outOfSampleScore,
    maxDrawdownPct: pls.length ? maxDd : null,
    championStressedExpectancyPct: championExpectancy,
    largestSingleTradeShareOfProfit: totalProfit > 0 ? biggest / totalProfit : null,
    regimeWorstExpectancyPct: null,
    costSensitivityOk: true, // refined below via double-cost backtest
    unresolvedDataQualityIncidents: 0,
    unresolvedReconciliationIncidents: 0,
    safetyViolations: 0,
  };
}

export async function runWeeklyValidation(): Promise<WeeklyValidationReport> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const now = new Date();
  const weekOf = now.toISOString().slice(0, 10);
  const marketData = getMarketDataClient(mode);

  const versions = await ensureChampions(store);
  const shadowRows = await store.listLearningRecords("shadow_proposals", { limit: 1000 });
  const closedShadows = shadowRows
    .map((r) => r.payload as ShadowProposal)
    .filter((s) => s.status === "CLOSED");

  // Champion stress-tested expectancy from the live paper journal.
  const [entries, orders] = await Promise.all([
    store.listJournalEntries({ environment, limit: 500 }),
    store.listOrders({ environment, limit: 500 }),
  ]);
  const trips = deriveRoundTrips(entries, orders);
  const championExpectancyByFamily = new Map<string, number | null>();
  for (const champion of versions.filter((v) => v.status === "CHAMPION")) {
    const mine = trips.filter((t) => t.strategyId === champion.familyId);
    if (mine.length === 0) {
      championExpectancyByFamily.set(champion.familyId, null);
      continue;
    }
    const stressed = mine.map(
      (t) =>
        (stressTestPl({
          grossPlUsd: t.plUsd,
          notionalUsd: t.entryPrice * t.quantity,
          dataQualityOk: true,
          lowLiquidity: false,
          volatilitySpikeRegime: t.regime === "VOLATILITY_SPIKE",
        }).stressedPlUsd /
          (t.entryPrice * t.quantity)) *
        100,
    );
    championExpectancyByFamily.set(
      champion.familyId,
      stressed.reduce((a, b) => a + b, 0) / stressed.length,
    );
  }

  // Backtests + walk-forward + cost sensitivity for backtestable versions.
  const approved = await store.getApprovedSymbols();
  const equitySymbols = approved
    .filter((s) => s.active && s.assetClass === "us_equity")
    .map((s) => s.symbol)
    .slice(0, 12);
  const barsBySymbol: Record<string, Bar[]> = {};
  await Promise.all(
    equitySymbols.map(async (symbol) => {
      try {
        const bars = await marketData.getDailyBars(symbol, 500);
        if (bars.length >= 150) barsBySymbol[symbol] = bars;
      } catch {
        // skipped symbols simply don't contribute
      }
    }),
  );

  const overfittingWarnings: string[] = [];
  const costSensitivityNotes: string[] = [];
  const challengerRankings: WeeklyValidationReport["challengerRankings"] = [];
  const promotionsEligible: string[] = [];
  const challengersRejected: string[] = [];

  const activeVersions = versions.filter((v) =>
    ["CHAMPION", "SHADOW_TESTING"].includes(v.status),
  );
  for (const version of activeVersions) {
    const base = getStrategy(version.familyId);
    if (!base?.backtestable || Object.keys(barsBySymbol).length === 0) continue;
    const strategy = withParams(base, version.params);
    let osScore: number | null = null;
    let costOk = true;
    try {
      const wf = runWalkForward(strategy, barsBySymbol, DEFAULT_BACKTEST_CONFIG);
      osScore = wf.outOfSampleScore;
      overfittingWarnings.push(...wf.warnings.map((w) => `${version.versionId}: ${w}`));
      const normal = computeMetrics(runBacktest(strategy, barsBySymbol, DEFAULT_BACKTEST_CONFIG));
      const doubled = computeMetrics(
        runBacktest(strategy, barsBySymbol, { ...DEFAULT_BACKTEST_CONFIG, costBpsPerSide: 20 }),
      );
      costOk = !(normal.totalReturnPct > 0 && doubled.totalReturnPct <= 0);
      if (!costOk) {
        costSensitivityNotes.push(
          `${version.versionId}: edge disappears when costs double (${normal.totalReturnPct.toFixed(1)}% → ${doubled.totalReturnPct.toFixed(1)}%).`,
        );
      }
      const versionRows = await store.listLearningRecords("strategy_versions", { limit: 500 });
      const versionRow = versionRows.find((r) => r.keys.version_id === version.versionId);
      if (versionRow) {
        await store.updateLearningRecord("strategy_versions", versionRow.id, {
          payload: { ...version, metrics: normal },
        });
      }
    } catch {
      // backtest failure leaves metrics unchanged
    }

    if (version.status === "SHADOW_TESTING") {
      const stats = shadowStatsFor(
        version,
        closedShadows,
        championExpectancyByFamily.get(version.familyId) ?? null,
        osScore,
      );
      stats.costSensitivityOk = costOk;
      const gate = evaluateChallengerPromotion(stats);
      challengerRankings.push({
        versionId: version.versionId,
        stressedExpectancyPct: stats.stressedExpectancyPct,
        trades: stats.closedShadowTrades,
        verdict: gate.eligible
          ? "Eligible — manual approval required"
          : (gate.failed[0] ?? "Promotion requirements not met"),
      });
      if (gate.eligible) {
        promotionsEligible.push(version.versionId);
        await store.putLearningRecord(
          "promotion_reviews",
          { version_id: version.versionId, status: "PENDING_MANUAL_APPROVAL" },
          { version, stats, gate, createdAt: now.toISOString() },
        );
        await alert({
          notificationType: "CHALLENGER_PROMOTION_REVIEW",
          severity: "INFO",
          title: `Challenger ${version.versionId} passed all gates`,
          message:
            "All deterministic promotion gates passed. Manual approval is required on the Learning page. Past paper performance does not guarantee live results.",
        });
      } else if (stats.closedShadowTrades >= 30 && (stats.stressedExpectancyPct ?? 0) < 0) {
        challengersRejected.push(version.versionId);
        const rows = await store.listLearningRecords("strategy_versions", { limit: 500 });
        const row = rows.find((r) => r.keys.version_id === version.versionId);
        if (row) {
          await store.updateLearningRecord("strategy_versions", row.id, {
            keys: { status: "VALIDATION_FAILED" },
            payload: { ...version, status: "VALIDATION_FAILED", rejectionReasons: gate.failed },
          });
        }
      }
    }
  }

  // Rollback checks for champions.
  const spyBars = await marketData.getDailyBars(BENCHMARK_SYMBOL, 130).catch(() => [] as Bar[]);
  const regime = spyBars.length ? classifyRegime(spyBars).regime : "INSUFFICIENT_DATA";
  const rollbacksTriggered: string[] = [];
  for (const champion of versions.filter((v) => v.status === "CHAMPION")) {
    const base = getStrategy(champion.familyId);
    const mine = trips.filter((t) => t.strategyId === champion.familyId).slice(0, 20);
    if (mine.length < 5 || !base) continue; // not enough evidence either way
    const stressedPls = mine.map(
      (t) =>
        (stressTestPl({
          grossPlUsd: t.plUsd,
          notionalUsd: t.entryPrice * t.quantity,
          dataQualityOk: true,
          lowLiquidity: false,
          volatilitySpikeRegime: t.regime === "VOLATILITY_SPIKE",
        }).stressedPlUsd /
          (t.entryPrice * t.quantity)) *
        100,
    );
    const expectancy = stressedPls.reduce((a, b) => a + b, 0) / stressedPls.length;
    let eq = 0, peak = 0, maxDd = 0;
    for (const pl of stressedPls) { eq += pl; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, peak - eq); }
    const totalProfit = stressedPls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const decision = evaluateRollback({
      rolling20TradeStressedExpectancyPct: expectancy,
      maxDrawdownPct: maxDd,
      strategyDrawdownLimitPct: 8,
      excessVsSpy30dPct: null,
      staleQuoteIncidents7d: 0,
      reconciliationFailures7d: 0,
      calibrationDeterioratingSeverely: false,
      approvedRegimeExpectancyPct: null,
      largestSingleTradeShareOfProfit: totalProfit > 0 ? Math.max(0, ...stressedPls) / totalProfit : null,
      currentRegimeSupported: base.approvedRegimes.includes(regime as never),
    });
    if (decision.shouldRollback) {
      rollbacksTriggered.push(`${champion.versionId}: ${decision.reasons[0]}`);
      await store.putLearningRecord(
        "rollback_events",
        { version_id: champion.versionId, family_id: champion.familyId },
        { reasons: decision.reasons, at: now.toISOString(), action: "ENTRIES_DISABLED" },
      );
      await alert({
        notificationType: "STRATEGY_ROLLBACK",
        severity: "WARNING",
        title: `Strategy entries disabled: ${champion.familyId}`,
        message: `${decision.reasons.join(" ")} Exits remain allowed. Review on the Learning page.`,
      });
      await audit({
        actorType: "SYSTEM",
        actorId: "validate-weekly",
        action: "STRATEGY_ROLLBACK",
        entityType: "strategy",
        entityId: champion.familyId,
        severity: "WARNING",
        summary: `Rollback triggered for ${champion.versionId}: ${decision.reasons.join("; ")}`,
        metadata: {},
      });
    }
  }

  const calRows = await store.listLearningRecords("confidence_calibration_buckets", { limit: 1 });
  const calibrationSummary = calRows.length
    ? `Latest minimum autonomous confidence: ${(calRows[0].payload as any).minConfidence}.`
    : "No calibration data yet.";

  const report: WeeklyValidationReport = {
    weekOf,
    championSummaries: versions
      .filter((v) => v.status === "CHAMPION")
      .map((v) => ({
        versionId: v.versionId,
        note: `Stressed expectancy ${championExpectancyByFamily.get(v.familyId)?.toFixed(2) ?? "—"}%/trade from live paper journal.`,
      })),
    challengerRankings: challengerRankings.sort(
      (a, b) => (b.stressedExpectancyPct ?? -99) - (a.stressedExpectancyPct ?? -99),
    ),
    promotionsEligible,
    challengersRejected,
    rollbacksTriggered,
    calibrationSummary,
    overfittingWarnings: overfittingWarnings.slice(0, 12),
    costSensitivityNotes,
    dataQualitySummary: "See data-quality incidents on the Learning page.",
    researchPriorities: [
      promotionsEligible.length
        ? "Review pending challenger promotions."
        : "Accumulate more shadow samples before promotion decisions.",
      "Verify calibration trend after the next 20 labeled trades.",
    ],
  };

  await store.putLearningRecord("learning_runs", { kind: "weekly", date: weekOf }, report);
  return report;
}
