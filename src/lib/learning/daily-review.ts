import "server-only";
// Nightly learning run. Observes, labels, calibrates, shadow-tests, and
// reports. It NEVER places orders, never changes settings/limits/modes, and
// never touches live trading. All decisions it produces are recommendations
// gated behind deterministic rules + manual approval.

import { BENCHMARK_SYMBOL } from "@/lib/config";
import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { classifyRegime } from "@/lib/regime/engine";
import { alert, audit } from "@/lib/services";
import { getStore } from "@/lib/store";
import type { Store } from "@/lib/store/types";
import { STRATEGIES, withParams, getStrategy } from "@/lib/strategies/definitions";
import { reconcileOrders } from "@/lib/trading/pipeline";
import { deriveRoundTrips } from "@/lib/journal-stats";
import { modeToEnvironment, type Bar, type TradingMode } from "@/lib/types";
import { computeCalibration, calibrationMinConfidence, type CalibrationSample } from "./calibration";
import {
  generateSystematicVariants,
  MAX_NEW_CHALLENGERS_PER_WEEK,
  nextVersionId,
} from "./challengers";
import { computeLabels } from "./labels";
import { stressTestPl, DEFAULT_REALISM } from "./realism";
import type {
  DailyLearningReport,
  FeatureObservation,
  ShadowProposal,
  StrategyVersion,
} from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SHADOW_UNIVERSE_LIMIT = 8;

async function getBars(
  mode: TradingMode,
  symbol: string,
  days: number,
): Promise<Bar[]> {
  try {
    return await getMarketDataClient(mode).getDailyBars(symbol, days);
  } catch {
    return [];
  }
}

/** Ensure every strategy family has a baseline CHAMPION version row. */
export async function ensureChampions(store: Store): Promise<StrategyVersion[]> {
  const rows = await store.listLearningRecords("strategy_versions", { limit: 500 });
  const versions = rows.map((r) => ({ ...(r.payload as StrategyVersion) }));
  for (const strategy of STRATEGIES) {
    if (!versions.some((v) => v.familyId === strategy.id && v.status === "CHAMPION")) {
      const version: StrategyVersion = {
        familyId: strategy.id,
        versionId: `${strategy.id}@1`,
        parentVersionId: null,
        createdAt: new Date().toISOString(),
        creator: "BASELINE",
        params: strategy.params,
        approvedRegimes: strategy.approvedRegimes,
        status: "CHAMPION",
        metrics: null,
        rejectionReasons: [],
        shadowStartedAt: null,
      };
      await store.putLearningRecord(
        "strategy_versions",
        { version_id: version.versionId, family_id: strategy.id, status: "CHAMPION" },
        version,
      );
      versions.push(version);
    }
  }
  return versions;
}

async function labelRecentObservations(
  store: Store,
  mode: TradingMode,
  now: Date,
): Promise<{ labeled: number; samples: CalibrationSample[] }> {
  const cutoff = new Date(now.getTime() - 35 * 86_400_000).toISOString();
  const observations = await store.listLearningRecords("feature_observations", {
    sinceIso: cutoff,
    limit: 400,
  });
  const existingLabels = await store.listLearningRecords("outcome_labels", {
    sinceIso: cutoff,
    limit: 2000,
  });
  const finalLabeled = new Set(
    existingLabels
      .filter((l) => !(l.payload as any).interim)
      .map((l) => `${(l.payload as any).sourceId}:${(l.payload as any).horizonDays}`),
  );

  const samples: CalibrationSample[] = [];
  let labeled = 0;
  const barsCache = new Map<string, Bar[]>();
  const spyBars = await getBars(mode, BENCHMARK_SYMBOL, 70);

  for (const record of observations) {
    const obs = record.payload as FeatureObservation;
    const entryPrice = obs.actualFillPrice ?? obs.hypotheticalEntryPrice;
    if (!entryPrice || entryPrice <= 0) continue;
    if (!barsCache.has(obs.symbol)) barsCache.set(obs.symbol, await getBars(mode, obs.symbol, 70));
    const bars = barsCache.get(obs.symbol)!;
    const entryDate = obs.observedAt.slice(0, 10);
    const startIdx = bars.findIndex((b) => b.timestamp.slice(0, 10) >= entryDate);
    if (startIdx === -1) continue;
    const barsAfter = bars.slice(startIdx);
    const spyStart = spyBars.findIndex((b) => b.timestamp.slice(0, 10) >= entryDate);
    const spyCloses = spyStart === -1 ? [] : spyBars.slice(spyStart).map((b) => b.close);

    const labels = computeLabels({
      sourceType: "observation",
      sourceId: record.id,
      symbol: obs.symbol,
      entryAtIso: obs.observedAt,
      entryPrice,
      stopLossPct: null,
      estimatedCostBps: obs.estimatedCostBps,
      barsAfterEntry: barsAfter,
      spyClosesAfterEntry: spyCloses,
      now,
    });
    for (const label of labels) {
      const key = `${label.sourceId}:${label.horizonDays}`;
      if (finalLabeled.has(key)) continue; // final labels are immutable
      await store.putLearningRecord(
        "outcome_labels",
        {
          source_id: label.sourceId,
          horizon: String(label.horizonDays),
          interim: label.interim ? "1" : "0",
          symbol: label.symbol,
        },
        label,
      );
      labeled++;
      if (label.horizonDays === 5 && obs.confidence !== null) {
        samples.push({
          confidence: obs.confidence,
          executed: obs.source === "EXECUTED",
          afterCostReturnPct: label.returnAfterCostsPct,
          excessVsSpyPct: label.excessReturnPct,
          abstainWasBetter: label.abstainWasBetter,
        });
      }
    }
  }
  return { labeled, samples };
}

/** Daily shadow tick: open/close hypothetical trades for SHADOW_TESTING versions. */
async function shadowTick(
  store: Store,
  mode: TradingMode,
  versions: StrategyVersion[],
  activeRegime: string,
  now: Date,
): Promise<string[]> {
  const updates: string[] = [];
  const shadowVersions = versions.filter((v) => v.status === "SHADOW_TESTING");
  const shadowRows = await store.listLearningRecords("shadow_proposals", { limit: 800 });
  const barsCache = new Map<string, Bar[]>();

  for (const version of shadowVersions) {
    const base = getStrategy(version.familyId);
    if (!base?.signal) continue;
    const variant = withParams(base, version.params);
    if (!variant.approvedRegimes.includes(activeRegime as never)) continue;

    const approved = await store.getApprovedSymbols();
    const universe = (
      variant.universe === "ALL_ACTIVE_EQUITIES"
        ? approved.filter((s) => s.active && s.assetClass === "us_equity").map((s) => s.symbol)
        : variant.universe
    ).slice(0, SHADOW_UNIVERSE_LIMIT);

    for (const symbol of universe) {
      if (!barsCache.has(symbol)) barsCache.set(symbol, await getBars(mode, symbol, 120));
      const bars = barsCache.get(symbol)!;
      if (bars.length < 60) continue;
      const lastClose = bars[bars.length - 1].close;
      const openShadow = shadowRows.find(
        (r) =>
          r.keys.version_id === version.versionId &&
          (r.payload as ShadowProposal).symbol === symbol &&
          (r.payload as ShadowProposal).status === "OPEN",
      );

      if (openShadow) {
        // Close on stop / exit signal / max holding — using only realized bars.
        const proposal = openShadow.payload as ShadowProposal;
        const entryIdx = bars.findIndex(
          (b) => b.timestamp.slice(0, 10) >= proposal.proposedAt.slice(0, 10),
        );
        const since = entryIdx === -1 ? [] : bars.slice(entryIdx);
        const heldDays = Math.max(0, since.length - 1);
        const stopPrice = proposal.entryPrice * (1 - proposal.stopLossPct / 100);
        const stopHit = since.some((b) => b.low <= stopPrice);
        const sig = variant.signal!(bars);
        let exitReason: string | null = null;
        let exitPrice = lastClose;
        if (stopHit) {
          exitReason = "STOP";
          exitPrice = stopPrice;
        } else if (sig.exit) exitReason = "SIGNAL";
        else if (heldDays >= variant.maxHoldingDays) exitReason = "TIME";

        if (exitReason) {
          const grossPl = (exitPrice - proposal.entryPrice) * 1; // unit-quantity shadow
          const stressed = stressTestPl(
            {
              grossPlUsd: grossPl,
              notionalUsd: proposal.entryPrice,
              dataQualityOk: true,
              lowLiquidity: false,
              volatilitySpikeRegime: activeRegime === "VOLATILITY_SPIKE",
            },
            DEFAULT_REALISM,
          );
          const closed: ShadowProposal = {
            ...proposal,
            status: "CLOSED",
            exitPrice,
            exitReason,
            plPctAfterCosts: (stressed.stressedPlUsd / proposal.entryPrice) * 100,
            closedAt: now.toISOString(),
          };
          await store.updateLearningRecord("shadow_proposals", openShadow.id, {
            keys: { status: "CLOSED" },
            payload: closed,
          });
          await store.putLearningRecord(
            "shadow_trade_results",
            { version_id: version.versionId, symbol, exit_reason: exitReason },
            { ...closed, stressed },
          );
          updates.push(
            `${version.versionId} shadow ${exitReason} exit on ${symbol}: ${closed.plPctAfterCosts?.toFixed(2)}% (stressed)`,
          );
        }
      } else {
        const sig = variant.signal!(bars);
        if (sig.enter) {
          const proposal: ShadowProposal = {
            versionId: version.versionId,
            familyId: version.familyId,
            symbol,
            proposedAt: now.toISOString(),
            entryPrice: lastClose,
            stopLossPct: variant.stopLossPct,
            maxHoldingDays: variant.maxHoldingDays,
            status: "OPEN",
            exitPrice: null,
            exitReason: null,
            plPctAfterCosts: null,
            closedAt: null,
          };
          await store.putLearningRecord(
            "shadow_proposals",
            { version_id: version.versionId, symbol, status: "OPEN" },
            proposal,
          );
          updates.push(`${version.versionId} opened shadow position in ${symbol} @ ${lastClose.toFixed(2)}`);
        }
      }
    }
  }
  return updates;
}

async function generateChallengers(
  store: Store,
  versions: StrategyVersion[],
  now: Date,
): Promise<string[]> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const recentChallengers = versions.filter(
    (v) => v.creator !== "BASELINE" && v.createdAt >= weekAgo,
  );
  const budget = MAX_NEW_CHALLENGERS_PER_WEEK - recentChallengers.length;
  if (budget <= 0) return ["Challenger budget for this week exhausted."];

  const notes: string[] = [];
  const dateSeed = now.toISOString().slice(0, 10);
  let created = 0;
  for (const champion of versions.filter((v) => v.status === "CHAMPION")) {
    if (created >= budget) break;
    const base = getStrategy(champion.familyId);
    if (!base?.backtestable) continue;
    const variants = generateSystematicVariants(champion.familyId, champion.params, dateSeed, 1);
    for (const params of variants) {
      if (created >= budget) break;
      const exists = versions.some(
        (v) => v.familyId === champion.familyId && JSON.stringify(v.params) === JSON.stringify(params),
      );
      if (exists) continue;
      const version: StrategyVersion = {
        familyId: champion.familyId,
        versionId: nextVersionId(champion.familyId, versions),
        parentVersionId: champion.versionId,
        createdAt: now.toISOString(),
        creator: "SYSTEMATIC_VARIANT",
        params,
        approvedRegimes: champion.approvedRegimes,
        status: "SHADOW_TESTING",
        metrics: null,
        rejectionReasons: [],
        shadowStartedAt: now.toISOString(),
      };
      await store.putLearningRecord(
        "strategy_versions",
        { version_id: version.versionId, family_id: version.familyId, status: version.status },
        version,
      );
      versions.push(version);
      created++;
      notes.push(`Generated challenger ${version.versionId} (${JSON.stringify(params)}) → shadow mode.`);
    }
  }
  return notes.length ? notes : ["No new challengers generated today."];
}

export async function runDailyLearning(): Promise<DailyLearningReport> {
  const store = await getStore();
  const settings = await store.getSettings();
  const mode = settings.tradingMode;
  const environment = modeToEnvironment(mode);
  const now = new Date();
  const marketDate = now.toISOString().slice(0, 10);

  // 1–2. Snapshot present? Reconcile orders.
  const snapshots = await store.listSnapshots(environment, 5);
  const snapshotToday = snapshots.some((s) => s.capturedAt.slice(0, 10) === marketDate);
  await reconcileOrders("learn-daily").catch(() => undefined);

  // Regime.
  const spyBars = await getBars(mode, BENCHMARK_SYMBOL, 130);
  const regime = classifyRegime(spyBars);
  await store.putLearningRecord(
    "learning_runs",
    { kind: "regime_snapshot", date: marketDate },
    { regime: regime.regime, metrics: regime.metrics, rules: regime.rules },
  );

  // 3–6. Labels for observations (executed, rejected, NO_TRADE alike).
  const { labeled, samples } = await labelRecentObservations(store, mode, now);

  // 7. Calibration.
  const buckets = computeCalibration(samples);
  const minConfidence = calibrationMinConfidence(buckets);
  await store.putLearningRecord(
    "confidence_calibration_buckets",
    { date: marketDate, kind: "daily" },
    { buckets, minConfidence, sampleCount: samples.length },
  );
  const calBad = buckets.filter((b) => b.verdict === "OVERCONFIDENT");
  const calibrationSummary = calBad.length
    ? `Overconfident buckets: ${calBad.map((b) => b.bucket).join(", ")} — autonomous minimum confidence raised to ${minConfidence}.`
    : `No overconfidence detected (${samples.length} labeled samples). Autonomous minimum confidence: ${minConfidence}.`;

  // 8. Strategy stats (journal round trips).
  const [entries, orders] = await Promise.all([
    store.listJournalEntries({ environment, limit: 500 }),
    store.listOrders({ environment, limit: 500 }),
  ]);
  const trips = deriveRoundTrips(entries, orders);
  const strategyFindings = STRATEGIES.map((s) => {
    const mine = trips.filter((t) => t.strategyId === s.id);
    if (mine.length === 0) return { strategyId: s.id, note: "No closed trades yet." };
    const net = mine.reduce((sum, t) => sum + t.plUsd - t.estimatedCostsUsd, 0);
    const stressed = mine.reduce((sum, t) => {
      const result = stressTestPl({
        grossPlUsd: t.plUsd,
        notionalUsd: t.entryPrice * t.quantity,
        dataQualityOk: true,
        lowLiquidity: false,
        volatilitySpikeRegime: t.regime === "VOLATILITY_SPIKE",
      });
      return sum + result.stressedPlUsd;
    }, 0);
    return {
      strategyId: s.id,
      note: `${mine.length} trips, net $${net.toFixed(2)}, stress-tested $${stressed.toFixed(2)}.`,
    };
  });

  // 9–11. Champions, challengers, shadow tick.
  const versions = await ensureChampions(store);
  const challengerUpdates = [
    ...(await generateChallengers(store, versions, now)),
    ...(await shadowTick(store, mode, versions, regime.regime, now)),
  ];

  // Account + today's decisions.
  let equity: number | null = null;
  let cash: number | null = null;
  let brokerDayTradeCount: number | null = null;
  try {
    const account = await getBrokerageClient(mode).getAccount();
    equity = account.equity;
    cash = account.cash;
    brokerDayTradeCount = account.dayTradeCount ?? null;
  } catch {
    // brokerage may be unavailable after hours — report renders without it
  }
  const todayProposals = (await store.listProposals({ environment, limit: 100 })).filter(
    (p) => p.createdAt.slice(0, 10) === marketDate,
  );
  const auditEvents = await store.listAuditEvents(300);
  const noTradeToday = auditEvents.filter(
    (e) => e.action === "AI_DECISION_PASSIVE" && e.createdAt.slice(0, 10) === marketDate,
  ).length;
  const dataQualityIncidents = auditEvents.filter(
    (e) => e.action === "DATA_QUALITY_INCIDENT" && e.createdAt.slice(0, 10) === marketDate,
  ).length;

  const lastSnapshot = snapshots[snapshots.length - 1];
  const prevSnapshot = snapshots[snapshots.length - 2];
  const paperPlToday =
    equity !== null && lastSnapshot ? equity - (prevSnapshot?.equity ?? lastSnapshot.equity) : null;

  // Best/worst decision from today's 1-day labels would need tomorrow's data;
  // use most recent completed labels instead.
  const tripToday = trips.filter((t) => t.exitAt.slice(0, 10) === marketDate);
  const best = [...tripToday].sort((a, b) => b.plUsd - a.plUsd)[0];
  const worst = [...tripToday].sort((a, b) => a.plUsd - b.plUsd)[0];

  // Intraday round trips (entered AND exited the same day) — analytics only,
  // never a rejection reason since Alpaca deprecated legacy PDT protection.
  const intradayRoundTripsToday = trips.filter(
    (t) => t.exitAt.slice(0, 10) === marketDate && t.entryAt.slice(0, 10) === marketDate,
  ).length;

  const reviewItems: string[] = [];
  if (!snapshotToday) reviewItems.push("No portfolio snapshot was captured today — check the snapshot cron.");
  if (intradayRoundTripsToday >= 5) {
    reviewItems.push(
      `Overtrading signal: ${intradayRoundTripsToday} same-day round trips today. Frequent intraday turnover usually erodes edge through costs — review strategy behavior.`,
    );
  }
  if (calBad.length) reviewItems.push("Confidence calibration shows overconfident buckets.");
  if (dataQualityIncidents > 2) reviewItems.push(`${dataQualityIncidents} data-quality incidents today.`);

  const report: DailyLearningReport = {
    marketDate,
    regime: regime.regime,
    account: { equity, cash },
    paperPlToday,
    stressTestedPlToday:
      paperPlToday === null
        ? null
        : stressTestPl({
            grossPlUsd: paperPlToday,
            notionalUsd: equity ?? 0,
            dataQualityOk: dataQualityIncidents === 0,
            lowLiquidity: false,
            volatilitySpikeRegime: regime.regime === "VOLATILITY_SPIKE",
          }).stressedPlUsd,
    spyRelativeToday: null,
    proposalsGenerated: todayProposals.length,
    executed: todayProposals.filter((p) => p.status === "EXECUTED").length,
    rejected: todayProposals.filter((p) => ["BLOCKED", "REJECTED"].includes(p.status)).length,
    noTradeDecisions: noTradeToday,
    bestDecision: best
      ? `${best.symbol} +$${best.plUsd.toFixed(2)} (${best.strategyId ?? "manual"})`
      : null,
    worstDecision: worst && worst.plUsd < 0 ? `${worst.symbol} $${worst.plUsd.toFixed(2)}` : null,
    strongestRejected: null,
    calibrationSummary,
    strategyFindings,
    dataQualityIncidents,
    intradayRoundTripsToday,
    brokerDayTradeCount,
    challengerUpdates,
    rollbacks: [],
    reviewItems,
    narrative:
      `Learning run complete for ${marketDate}. Regime ${regime.regime}. ` +
      `${todayProposals.length} proposals, ${noTradeToday} passive decisions, ${labeled} outcome labels written. ` +
      calibrationSummary,
  };

  await store.putLearningRecord("learning_runs", { kind: "daily", date: marketDate }, report);
  await audit({
    actorType: "SYSTEM",
    actorId: "learn-daily",
    action: "LEARNING_RUN_COMPLETE",
    entityType: "learning_runs",
    entityId: marketDate,
    severity: "INFO",
    summary: report.narrative.slice(0, 300),
    metadata: {},
  });
  if (reviewItems.length > 0) {
    await alert({
      notificationType: "LEARNING_REVIEW",
      severity: "WARNING",
      title: "Daily learning: items need review",
      message: reviewItems.join(" "),
    });
  }
  return report;
}
