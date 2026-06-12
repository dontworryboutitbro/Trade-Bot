import { Badge, Card, Empty, Stat, Td, Th, plTone } from "@/components/ui";
import { BacktestRunner } from "@/components/backtest-runner";
import { getStore } from "@/lib/store";
import { getMarketDataClient } from "@/lib/brokerage/factory";
import { classifyRegime } from "@/lib/regime/engine";
import { STRATEGIES } from "@/lib/strategies/definitions";
import { evaluateDemotion, evaluatePromotion } from "@/lib/strategies/promotion";
import { deriveRoundTrips, statsForStrategy } from "@/lib/journal-stats";
import { modeToEnvironment } from "@/lib/types";
import { fmtDateTime, fmtUsd } from "@/lib/utils";
import { BENCHMARK_SYMBOL } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function StrategyLabPage() {
  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);
  const [entries, orders, backtests] = await Promise.all([
    store.listJournalEntries({ environment, limit: 500 }),
    store.listOrders({ environment, limit: 500 }),
    store.listBacktestRuns(30),
  ]);
  let regime: string = "INSUFFICIENT_DATA";
  try {
    const bars = await getMarketDataClient(settings.tradingMode).getDailyBars(BENCHMARK_SYMBOL, 130);
    regime = classifyRegime(bars).regime;
  } catch {
    regime = "INSUFFICIENT_DATA";
  }
  const trips = deriveRoundTrips(entries, orders);

  const rows = STRATEGIES.map((strategy) => {
    const latestBacktest = backtests.find((b) => b.strategyId === strategy.id);
    const osScore =
      (latestBacktest?.walkForward as { outOfSampleScore?: number | null } | null)
        ?.outOfSampleScore ?? null;
    const stats = statsForStrategy(strategy.id, trips, entries, osScore);
    const promotion = evaluatePromotion("PAPER_MANUAL", stats, strategy.backtestable);
    const demotion = evaluateDemotion(stats);
    const eligibleNow = strategy.approvedRegimes.includes(regime as never);
    const myTrips = trips.filter((t) => t.strategyId === strategy.id);
    const netPl = myTrips.reduce((s, t) => s + t.plUsd - t.estimatedCostsUsd, 0);
    const wins = myTrips.filter((t) => t.plUsd > 0).length;
    return { strategy, stats, promotion, demotion, eligibleNow, netPl, wins, tripCount: myTrips.length, latestBacktest };
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Strategy Lab</h1>
        <Badge tone="muted">Regime: {regime.replace(/_/g, " ")}</Badge>
        <span className="ml-auto text-xs text-faint">
          Past paper performance does not guarantee live results.
        </span>
      </div>

      <Card title="Strategy comparison">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-edge">
                <Th>Strategy</Th>
                <Th>Stage</Th>
                <Th>Regime fit</Th>
                <Th className="text-right">Paper trades</Th>
                <Th className="text-right">Net paper P/L</Th>
                <Th className="text-right">Win rate</Th>
                <Th className="text-right">Expectancy</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.strategy.id} className="border-b border-edge/50 last:border-0 align-top">
                  <Td>
                    <div className="font-medium">{row.strategy.name}</div>
                    <div className="mt-0.5 max-w-[260px] text-xs text-faint">
                      {row.strategy.description}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone="amber">Paper</Badge>
                  </Td>
                  <Td>
                    <Badge tone={row.eligibleNow ? "green" : "muted"}>
                      {row.eligibleNow ? "Eligible" : "Ineligible"}
                    </Badge>
                  </Td>
                  <Td className="text-right">{row.tripCount}</Td>
                  <Td className={`text-right ${row.netPl >= 0 ? "text-positive" : "text-negative"}`}>
                    {fmtUsd(row.netPl)}
                  </Td>
                  <Td className="text-right">
                    {row.tripCount > 0 ? `${((row.wins / row.tripCount) * 100).toFixed(0)}%` : "—"}
                  </Td>
                  <Td className="text-right">{fmtUsd(row.stats.expectancyAfterCostsUsd)}</Td>
                  <Td>
                    {row.demotion.shouldDemote ? (
                      <Badge tone="red">Demotion risk</Badge>
                    ) : row.promotion.eligible ? (
                      <Badge tone="green">Promotion ready</Badge>
                    ) : (
                      <span className="text-xs text-faint">
                        {row.promotion.failed[0] ?? "Collecting data"}
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Round trips (all strategies)" value={trips.length} />
        <Stat
          label="Net paper P/L"
          value={fmtUsd(rows.reduce((s, r) => s + r.netPl, 0))}
          tone={plTone(rows.reduce((s, r) => s + r.netPl, 0))}
        />
        <Stat label="Journal entries" value={entries.length} />
        <Stat label="Backtests run" value={backtests.length} />
      </div>

      <Card title="Run a backtest (walk-forward validated)">
        <BacktestRunner
          strategies={STRATEGIES.filter((s) => s.backtestable).map((s) => ({ id: s.id, name: s.name }))}
        />
      </Card>

      {backtests.length > 0 && (
        <Card title="Recent backtests">
          <ul className="space-y-2 text-sm">
            {backtests.slice(0, 8).map((run) => {
              const metrics = run.metrics as {
                totalReturnPct?: number;
                benchmarkReturnPct?: number | null;
                maxDrawdownPct?: number;
                tradeCount?: number;
              } | null;
              const wf = run.walkForward as { outOfSampleScore?: number | null } | null;
              return (
                <li key={run.id} className="flex flex-wrap items-center gap-2 border-b border-edge/40 pb-2 last:border-0">
                  <span className="font-medium">{run.strategyId}</span>
                  <span className="tabular text-muted">
                    {metrics?.totalReturnPct?.toFixed(1)}% vs SPY{" "}
                    {metrics?.benchmarkReturnPct?.toFixed(1) ?? "—"}% · DD{" "}
                    {metrics?.maxDrawdownPct?.toFixed(1)}% · {metrics?.tradeCount} trades · OS score{" "}
                    {wf?.outOfSampleScore?.toFixed(2) ?? "—"}
                  </span>
                  {(run.warnings?.length ?? 0) > 0 && <Badge tone="amber">{run.warnings.length} warnings</Badge>}
                  <span className="ml-auto text-xs text-faint">{fmtDateTime(run.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card title="Promotion gates">
        {rows.every((r) => r.tripCount === 0) ? (
          <Empty>
            No paper round trips yet. Strategies are evaluated for promotion once they accumulate
            ≥20 paper trades over ≥30 trading days with positive expectancy after costs.
          </Empty>
        ) : (
          <div className="space-y-3 text-sm">
            {rows.map((row) => (
              <div key={row.strategy.id} className="rounded-md border border-edge bg-raised p-3">
                <div className="font-medium">{row.strategy.name}</div>
                <div className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
                  {row.promotion.passed.map((p) => (
                    <span key={p} className="text-positive">✓ {p}</span>
                  ))}
                  {row.promotion.failed.map((f) => (
                    <span key={f} className="text-faint">○ {f}</span>
                  ))}
                </div>
                {row.demotion.shouldDemote && (
                  <p className="mt-2 text-xs text-critical">
                    Demotion triggers: {row.demotion.reasons.join(" ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
