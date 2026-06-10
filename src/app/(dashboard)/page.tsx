import Link from "next/link";
import { ApprovalList } from "@/components/approval-list";
import { EmergencyControls } from "@/components/emergency-controls";
import { EquityChart } from "@/components/equity-chart";
import { Badge, Card, Empty, Stat, Td, Th, plTone } from "@/components/ui";
import { getDashboardData } from "@/lib/dashboard";
import { fmtDateTime, fmtPct, fmtUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const data = await getDashboardData();
  const { account, positions, snapshots, settings } = data;
  const last = snapshots[snapshots.length - 1];
  const invested = positions.reduce((sum, p) => sum + p.marketValue, 0);
  const totalPl = positions.reduce((sum, p) => sum + p.unrealizedPl, 0);
  const dailyPct =
    account && last && last.equity > 0 ? ((account.equity - last.equity) / last.equity) * 100 : null;
  const excess =
    last && last.benchmarkReturnPct !== null ? last.totalReturnPct - last.benchmarkReturnPct : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {data.brokerageError && (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
          Brokerage unavailable: {data.brokerageError} —{" "}
          <Link href="/setup" className="underline">
            check setup
          </Link>
          .
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Portfolio value" value={fmtUsd(account?.equity)} />
        <Stat label="Cash" value={fmtUsd(account?.cash)} sub={`Buying power ${fmtUsd(account?.buyingPower)}`} />
        <Stat label="Invested" value={fmtUsd(invested)} sub={`${positions.length} position${positions.length === 1 ? "" : "s"}`} />
        <Stat
          label="Today"
          value={fmtPct(dailyPct)}
          tone={plTone(dailyPct)}
          sub={last ? `Drawdown ${fmtPct(-Math.abs(last.drawdownPct))}` : undefined}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Unrealized P/L" value={fmtUsd(totalPl)} tone={plTone(totalPl)} />
        <Stat label="Total return" value={fmtPct(last?.totalReturnPct)} tone={plTone(last?.totalReturnPct)} />
        <Stat label="SPY return" value={fmtPct(last?.benchmarkReturnPct)} tone={plTone(last?.benchmarkReturnPct)} />
        <Stat
          label="vs SPY"
          value={fmtPct(excess)}
          tone={plTone(excess)}
          sub={excess === null ? undefined : excess >= 0 ? "Outperforming" : "Underperforming"}
        />
      </div>

      <Card title="Equity">
        <EquityChart
          points={snapshots.map((s) => ({
            capturedAt: s.capturedAt,
            equity: s.equity,
            benchmarkReturnPct: s.benchmarkReturnPct,
            totalReturnPct: s.totalReturnPct,
          }))}
        />
      </Card>

      {data.pendingProposals.length > 0 && (
        <Card title="Awaiting your approval">
          <ApprovalList proposals={data.pendingProposals} />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Open positions" action={<Link href="/positions" className="text-xs text-accent hover:underline">All positions</Link>}>
          {positions.length === 0 ? (
            <Empty>No open positions.</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">P/L</Th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-b border-edge/50 last:border-0">
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

        <Card title="Recent trades" action={<Link href="/activity" className="text-xs text-accent hover:underline">All activity</Link>}>
          {data.recentOrders.length === 0 ? (
            <Empty>No trades yet.</Empty>
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
                  <tr key={o.id} className="border-b border-edge/50 last:border-0">
                    <Td>
                      <span className={o.side === "buy" ? "text-positive" : "text-negative"}>
                        {o.side.toUpperCase()}
                      </span>{" "}
                      {o.quantity} {o.symbol}
                      <span className="ml-2 text-xs text-faint">{fmtDateTime(o.submittedAt)}</span>
                    </Td>
                    <Td className="text-right">{o.filledAvgPrice ? fmtUsd(o.filledAvgPrice) : "—"}</Td>
                    <Td className="text-right text-xs text-muted">{o.status}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Blocked proposals">
          {data.blockedProposals.length === 0 ? (
            <Empty>Nothing blocked recently.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.blockedProposals.slice(0, 4).map((p) => (
                <li key={p.id} className="rounded-md border border-edge bg-raised px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge tone="red">Blocked</Badge>
                    <span>
                      {p.action} {p.quantity} {p.symbol}
                    </span>
                    <span className="ml-auto text-xs text-faint">{fmtDateTime(p.createdAt)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{p.conciseReasoning}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Alerts">
          {data.notifications.length === 0 ? (
            <Empty>No alerts.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.notifications.slice(0, 5).map((n) => (
                <li key={n.id} className="flex items-start gap-2 text-sm">
                  <Badge tone={n.severity === "CRITICAL" ? "red" : n.severity === "WARNING" ? "amber" : "muted"}>
                    {n.severity}
                  </Badge>
                  <div>
                    <p className="font-medium">{n.title}</p>
                    <p className="text-xs text-muted">{n.message}</p>
                    <p className="mt-0.5 text-[11px] text-faint">{fmtDateTime(n.createdAt)}</p>
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
    </div>
  );
}
