import { Badge, Card, Empty, Stat, Td, Th } from "@/components/ui";
import { LearningRunButtons } from "@/components/learning-client";
import { getStore } from "@/lib/store";
import { getStreamHealth } from "@/lib/streaming/market-stream";
import type {
  CalibrationBucket,
  DailyLearningReport,
  ShadowProposal,
  StrategyVersion,
  WeeklyValidationReport,
} from "@/lib/learning/types";
import { fmtDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function LearningPage() {
  const store = await getStore();
  const [runs, versionRows, shadowRows, calRows, promoRows, rollbackRows] = await Promise.all([
    store.listLearningRecords("learning_runs", { limit: 30 }),
    store.listLearningRecords("strategy_versions", { limit: 200 }),
    store.listLearningRecords("shadow_proposals", { limit: 500 }),
    store.listLearningRecords("confidence_calibration_buckets", { limit: 1 }),
    store.listLearningRecords("promotion_reviews", { limit: 20 }),
    store.listLearningRecords("rollback_events", { limit: 20 }),
  ]);

  const daily = runs.find((r) => r.keys.kind === "daily")?.payload as DailyLearningReport | undefined;
  const weekly = runs.find((r) => r.keys.kind === "weekly")?.payload as WeeklyValidationReport | undefined;
  const versions = versionRows.map((r) => r.payload as StrategyVersion);
  const champions = versions.filter((v) => v.status === "CHAMPION");
  const challengers = versions.filter((v) => v.status === "SHADOW_TESTING");
  const shadows = shadowRows.map((r) => r.payload as ShadowProposal);
  const closedShadows = shadows.filter((s) => s.status === "CLOSED");
  const calibration = (calRows[0]?.payload as { buckets?: CalibrationBucket[]; minConfidence?: number }) ?? {};
  const streamHealth = getStreamHealth();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Learning</h1>
        <span className="text-xs text-faint">
          The system learns from paper results; deterministic gates and manual approval control
          every change. It can never modify risk limits or live settings.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Last daily run"
          value={daily ? daily.marketDate : "—"}
          sub={daily ? `Regime ${daily.regime.replace(/_/g, " ")}` : "Not yet run"}
        />
        <Stat
          label="Last weekly validation"
          value={weekly ? weekly.weekOf : "—"}
          sub={weekly ? `${weekly.challengerRankings.length} challengers ranked` : "Not yet run"}
        />
        <Stat label="Champions / challengers" value={`${champions.length} / ${challengers.length}`} />
        <Stat
          label="Shadow trades"
          value={closedShadows.length}
          sub={`${shadows.filter((s) => s.status === "OPEN").length} open`}
        />
      </div>

      <Card title="Run controls">
        <LearningRunButtons />
      </Card>

      {daily && (
        <Card title={`Daily learning report — ${daily.marketDate}`}>
          <p className="text-sm text-muted">{daily.narrative}</p>
          <div className="tabular mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><span className="text-faint">Proposals:</span> {daily.proposalsGenerated}</div>
            <div><span className="text-faint">Executed:</span> {daily.executed}</div>
            <div><span className="text-faint">Rejected:</span> {daily.rejected}</div>
            <div><span className="text-faint">NO_TRADE:</span> {daily.noTradeDecisions}</div>
            <div><span className="text-faint">Paper P/L:</span> {daily.paperPlToday === null ? "—" : `$${daily.paperPlToday.toFixed(2)}`}</div>
            <div><span className="text-faint">Stress-tested:</span> {daily.stressTestedPlToday === null ? "—" : `$${daily.stressTestedPlToday.toFixed(2)}`}</div>
            <div><span className="text-faint">Best:</span> {daily.bestDecision ?? "—"}</div>
            <div><span className="text-faint">Worst:</span> {daily.worstDecision ?? "—"}</div>
          </div>
          {daily.challengerUpdates.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {daily.challengerUpdates.slice(0, 6).map((u, i) => (
                <li key={i}>· {u}</li>
              ))}
            </ul>
          )}
          {daily.reviewItems.length > 0 && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              {daily.reviewItems.map((item, i) => (
                <p key={i}>⚠ {item}</p>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Confidence calibration">
        {!calibration.buckets ? (
          <Empty>Insufficient sample size — calibration appears after labeled outcomes accumulate.</Empty>
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Confidence</Th>
                  <Th className="text-right">Proposals</Th>
                  <Th className="text-right">Win rate</Th>
                  <Th className="text-right">Avg after-cost</Th>
                  <Th className="text-right">Abstain better</Th>
                  <Th>Verdict</Th>
                </tr>
              </thead>
              <tbody>
                {calibration.buckets.map((b) => (
                  <tr key={b.bucket} className="border-b border-edge/50 last:border-0">
                    <Td className="font-medium">{b.bucket}</Td>
                    <Td className="text-right">{b.proposalCount}</Td>
                    <Td className="text-right">{b.winRatePct?.toFixed(0) ?? "—"}%</Td>
                    <Td className={`text-right ${(b.avgAfterCostReturnPct ?? 0) >= 0 ? "text-positive" : "text-negative"}`}>
                      {b.avgAfterCostReturnPct?.toFixed(2) ?? "—"}%
                    </Td>
                    <Td className="text-right">{b.abstainBetterPct?.toFixed(0) ?? "—"}%</Td>
                    <Td>
                      <Badge
                        tone={
                          b.verdict === "OVERCONFIDENT"
                            ? "red"
                            : b.verdict === "RELIABLE"
                              ? "green"
                              : "muted"
                        }
                      >
                        {b.verdict.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-faint">
              Calibration-adjusted minimum confidence for autonomous entries:{" "}
              <span className="text-foreground">{calibration.minConfidence ?? 55}</span>. The
              penalty only tightens; it never overrides the risk engine.
            </p>
          </>
        )}
      </Card>

      <Card title="Champion vs challenger">
        {versions.length === 0 ? (
          <Empty>Versions appear after the first daily learning run.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Version</Th>
                  <Th>Status</Th>
                  <Th>Creator</Th>
                  <Th>Parameters</Th>
                  <Th className="text-right">Shadow trades</Th>
                  <Th className="text-right">Created</Th>
                </tr>
              </thead>
              <tbody>
                {versions
                  .sort((a, b) => a.familyId.localeCompare(b.familyId) || a.versionId.localeCompare(b.versionId))
                  .map((v) => (
                    <tr key={v.versionId} className="border-b border-edge/50 last:border-0">
                      <Td className="font-medium">{v.versionId}</Td>
                      <Td>
                        <Badge
                          tone={
                            v.status === "CHAMPION"
                              ? "green"
                              : v.status === "SHADOW_TESTING"
                                ? "amber"
                                : v.status === "ROLLED_BACK" || v.status === "VALIDATION_FAILED"
                                  ? "red"
                                  : "muted"
                          }
                        >
                          {v.status.replace(/_/g, " ")}
                        </Badge>
                      </Td>
                      <Td className="text-xs text-muted">{v.creator}</Td>
                      <Td className="max-w-[220px] truncate font-mono text-xs text-faint">
                        {JSON.stringify(v.params)}
                      </Td>
                      <Td className="text-right">
                        {closedShadows.filter((s) => s.versionId === v.versionId).length}
                      </Td>
                      <Td className="text-right text-xs text-faint">{fmtDateTime(v.createdAt)}</Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {weekly && (
        <Card title={`Weekly validation — week of ${weekly.weekOf}`}>
          <div className="space-y-2 text-sm">
            {weekly.challengerRankings.length > 0 && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-faint">Challenger rankings</h3>
                <ul className="tabular mt-1 space-y-1 text-xs text-muted">
                  {weekly.challengerRankings.map((c) => (
                    <li key={c.versionId}>
                      {c.versionId}: {c.stressedExpectancyPct?.toFixed(2) ?? "—"}%/trade over {c.trades} trades — {c.verdict}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {weekly.promotionsEligible.length > 0 && (
              <p className="text-positive">
                Eligible for manual promotion review: {weekly.promotionsEligible.join(", ")}
              </p>
            )}
            {weekly.rollbacksTriggered.length > 0 && (
              <p className="text-critical">Rollbacks: {weekly.rollbacksTriggered.join("; ")}</p>
            )}
            {weekly.overfittingWarnings.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-faint">
                  {weekly.overfittingWarnings.length} overfitting/cost warnings
                </summary>
                <ul className="mt-1 space-y-0.5 text-xs text-warning">
                  {weekly.overfittingWarnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-xs text-faint">{weekly.calibrationSummary}</p>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Pending promotion reviews">
          {promoRows.length === 0 ? (
            <Empty>Promotion requirements not met by any challenger yet.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {promoRows.slice(0, 5).map((r) => (
                <li key={r.id} className="rounded border border-edge bg-raised p-2 text-xs">
                  <span className="font-medium">{r.keys.version_id}</span> — all deterministic gates
                  passed. Manual approval required (promotion is never automatic).
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Rollback events">
          {rollbackRows.length === 0 ? (
            <Empty>No rollbacks.</Empty>
          ) : (
            <ul className="space-y-2 text-xs text-muted">
              {rollbackRows.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <Badge tone="red">Rollback</Badge> {r.keys.version_id}:{" "}
                  {((r.payload as any).reasons ?? []).join(" ")}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Streaming health">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge
            tone={
              streamHealth.status === "CONNECTED"
                ? "green"
                : streamHealth.status === "DEGRADED"
                  ? "amber"
                  : "muted"
            }
          >
            {streamHealth.status.replace(/_/g, " ")}
          </Badge>
          <span className="text-xs text-muted">
            {streamHealth.usingFallback
              ? "REST snapshots in use (authoritative fallback)."
              : `Live stream: ${streamHealth.subscribedSymbols.length} symbols.`}
          </span>
          {streamHealth.lastError && (
            <span className="text-xs text-faint">{streamHealth.lastError}</span>
          )}
        </div>
        <p className="mt-2 text-xs text-faint">
          Streaming improves freshness when a long-lived process is running; REST + reconciliation
          remain authoritative. When freshness cannot be verified, autonomous and live entries are
          blocked (fail-closed).
        </p>
      </Card>
    </div>
  );
}
