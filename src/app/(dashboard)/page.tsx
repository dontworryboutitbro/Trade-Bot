import Link from "next/link";
import { ApprovalList } from "@/components/approval-list";
import { Autopilot } from "@/components/autopilot";
import { CommandChart } from "@/components/command-chart";
import { EmergencyControls } from "@/components/emergency-controls";
import { Badge, Card, Empty, Stat, StatusRow, Td, Th, plTone } from "@/components/ui";
import { getDashboardData } from "@/lib/dashboard";
import { getStore } from "@/lib/store";
import { fmtDateTime, fmtPct, fmtUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default async function OverviewPage() {
  const data = await getDashboardData();
  const { account, positions, snapshots, settings } = data;
  const last = snapshots[snapshots.length - 1];
  const invested = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const totalPl = positions.reduce((sum, p) => sum + p.unrealizedPl, 0);
  const dailyPct =
    account && last && last.equity > 0 ? ((account.equity - last.equity) / last.equity) * 100 : null;
  const exposurePct = account && account.equity > 0 ? (invested / account.equity) * 100 : null;
  const excess =
    last && last.benchmarkReturnPct !== null ? last.totalReturnPct - last.benchmarkReturnPct : null;

  // AI Research Engine panel data (best-effort; renders without it).
  const store = await getStore();
  let learner: { date?: string; regime?: string; proposals?: number; noTrade?: number; calibration?: string } = {};
  let champions = 0;
  let challengers = 0;
  try {
    const runs = await store.listLearningRecords("learning_runs", { keys: { kind: "daily" }, limit: 1 });
    const report = runs[0]?.payload as any;
    if (report) {
      learner = {
        date: report.marketDate,
        regime: report.regime,
        proposals: report.proposalsGenerated,
        noTrade: report.noTradeDecisions,
        calibration: report.calibrationSummary,
      };
    }
    const versions = await store.listLearningRecords("strategy_versions", { limit: 200 });
    champions = versions.filter((v) => v.keys.status === "CHAMPION").length;
    challengers = versions.filter((v) => v.keys.status === "SHADOW_TESTING").length;
  } catch {
    // learning store unavailable — panel shows placeholders
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      {data.brokerageError && (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          Brokerage unavailable: {data.brokerageError} —{" "}
          <Link href="/setup" className="underline">check setup</Link>.
        </div>
      )}

      {/* Command center: metrics | chart | system status */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="grid grid-cols-2 gap-2 lg:col-span-2 lg:grid-cols-1 lg:content-start">
          <Stat label="Portfolio value" value={fmtUsd(account?.equity)} />
          <Stat label="Daily P&L" value={fmtPct(dailyPct)} tone={plTone(dailyPct)} />
          <Stat label="Unrealized P&L" value={fmtUsd(totalPl)} tone={plTone(totalPl)} />
          <Stat label="Buying power" value={fmtUsd(account?.buyingPower)} />
          <Stat label="Drawdown" value={fmtPct(last ? -Math.abs(last.drawdownPct) : null)} tone="negative" />
          <Stat label="Exposure" value={fmtPct(exposurePct)} sub={`${positions.length} positions`} />
          <Stat label="vs SPY" value={fmtPct(excess)} tone={plTone(excess)} />
          <Stat label="Cash" value={fmtUsd(account?.cash)} />
        </div>

        <section className="chart-aura panel-hover rounded-md border border-edge lg:col-span-7">
          <header className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              Portfolio equity
            </h2>
            <span className="font-num text-[10px] uppercase text-faint">
              {snapshots.length} daily snapshots
            </span>
          </header>
          <div className="p-4">
            <CommandChart
              points={snapshots.map((s) => ({
                capturedAt: s.capturedAt,
                equity: s.equity,
                totalReturnPct: s.totalReturnPct,
                benchmarkReturnPct: s.benchmarkReturnPct,
                drawdownPct: s.drawdownPct,
              }))}
            />
          </div>
        </section>

        <div className="space-y-4 lg:col-span-3">
          <Card title="AI Research Engine" glow="violet">
            <div className="space-y-0.5">
              <StatusRow label="Engine" state={learner.date ? "ACTIVE" : "STANDBY"} tone={learner.date ? "magenta" : "muted"} pulse={Boolean(learner.date)} />
              <StatusRow label="Last run" state={learner.date ?? "—"} tone="muted" />
              <StatusRow label="Regime" state={(learner.regime ?? "—").replace(/_/g, " ")} tone="violet" />
              <StatusRow label="Proposals" state={String(learner.proposals ?? 0)} tone="muted" />
              <StatusRow label="Abstentions" state={String(learner.noTrade ?? 0)} tone="muted" />
              <StatusRow label="Champions" state={String(champions)} tone="green" />
              <StatusRow label="Challengers" state={challengers > 0 ? `${challengers} SHADOW` : "0"} tone={challengers > 0 ? "violet" : "muted"} />
            </div>
            {learner.calibration && (
              <p className="mt-2 border-t border-edge pt-2 text-[10px] leading-relaxed text-faint">
                {learner.calibration}
              </p>
            )}
          </Card>

          <Card title="System status">
            <div className="space-y-0.5">
              <StatusRow label="Risk engine" state="30 CHECKS" tone="green" />
              <StatusRow label="Kill switch" state={settings.globalKillSwitch ? "ENGAGED" : "ARMED"} tone={settings.globalKillSwitch ? "red" : "muted"} />
              <StatusRow label="New orders" state={settings.stopNewOrders ? "STOPPED" : "ENABLED"} tone={settings.stopNewOrders ? "amber" : "green"} />
              <StatusRow label="Live trading" state="LOCKED" tone="muted" />
              <StatusRow label="Data feed" state="IEX LIMITED" tone="amber" />
              <StatusRow label="Mode" state={settings.tradingMode.replace(/_/g, " ")} tone={settings.tradingMode.startsWith("LIVE") ? "red" : "blue"} />
            </div>
          </Card>
        </div>
      </div>

      <Autopilot mode={settings.tradingMode} />

      {data.pendingProposals.length > 0 && (
        <Card title="Awaiting your approval" glow="accent">
          <ApprovalList proposals={data.pendingProposals} />
        </Card>
      )}

      {/* Lower strip */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Open positions" action={<Link href="/positions" className="text-[11px] uppercase tracking-wide text-accent hover:underline">All positions</Link>}>
          {positions.length === 0 ? (
            <Empty>No open positions</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">P&L</Th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-b border-edge/50 transition-colors last:border-0 hover:bg-raised/50">
                    <Td className="font-medium">{p.symbol}</Td>
                    <Td className="text-right">{p.quantity}</Td>
                    <Td className="text-right">{fmtUsd(p.marketValue)}</Td>
                    <Td className={`text-right ${p.unrealizedPl >= 0 ? "text-positive" : "text-negative"}`}>
                      {fmtPct(p.unrealizedPlPct)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent trades" action={<Link href="/activity" className="text-[11px] uppercase tracking-wide text-accent hover:underline">All activity</Link>}>
          {data.recentOrders.length === 0 ? (
            <Empty>No trades yet</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Trade</Th>
                  <Th className="text-right">Fill</Th>
                  <Th className="text-right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.slice(0, 6).map((o) => (
                  <tr key={o.id} className="border-b border-edge/50 transition-colors last:border-0 hover:bg-raised/50">
                    <Td>
                      <span className={o.side === "buy" ? "text-positive" : "text-negative"}>
                        {o.side.toUpperCase()}
                      </span>{" "}
                      {o.quantity} {o.symbol}
                      <span className="ml-2 text-[11px] text-faint">{fmtDateTime(o.submittedAt)}</span>
                    </Td>
                    <Td className="text-right">{o.filledAvgPrice ? fmtUsd(o.filledAvgPrice) : "—"}</Td>
                    <Td className="text-right text-[11px] uppercase text-muted">{o.status}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Rejected by risk engine">
          {data.blockedProposals.length === 0 ? (
            <Empty>Nothing blocked recently</Empty>
          ) : (
            <ul className="space-y-2">
              {data.blockedProposals.slice(0, 4).map((p) => (
                <li key={p.id} className="rounded-[5px] border border-edge bg-raised px-3 py-2 text-[13px]">
                  <div className="flex items-center gap-2">
                    <Badge tone="red">Rejected</Badge>
                    <span className="font-num">
                      {p.action} {p.quantity} {p.symbol}
                    </span>
                    {p.strategyId && <span className="text-[10px] uppercase text-faint">{p.strategyId}</span>}
                    <span className="ml-auto text-[11px] text-faint">{fmtDateTime(p.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{p.conciseReasoning}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Alerts" action={<Link href="/alerts" className="text-[11px] uppercase tracking-wide text-accent hover:underline">Console</Link>}>
          {data.notifications.length === 0 ? (
            <Empty>No alerts</Empty>
          ) : (
            <ul className="space-y-2">
              {data.notifications.slice(0, 5).map((n) => (
                <li key={n.id} className="flex items-start gap-2 text-[13px]">
                  <Badge tone={n.severity === "CRITICAL" ? "red" : n.severity === "WARNING" ? "amber" : "muted"}>
                    {n.severity}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-medium leading-tight">{n.title}</p>
                    <p className="truncate text-[11px] text-muted">{n.message}</p>
                    <p className="font-num mt-0.5 text-[10px] uppercase text-faint">{fmtDateTime(n.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Emergency controls">
        <EmergencyControls
          killSwitch={settings.globalKillSwitch}
          stopNewOrders={settings.stopNewOrders}
        />
      </Card>

      <p className="pb-2 text-center text-[10px] uppercase tracking-[0.18em] text-faint">
        Research, risk controls, and execution analysis in one workspace
      </p>
    </div>
  );
}
