import { Card, Empty, Td, Th } from "@/components/ui";
import { getPositionsData } from "@/lib/dashboard";
import { fmtDateTime, fmtPct, fmtUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PositionsPage() {
  const { positions, account, orders, proposals, brokerageError } = await getPositionsData();
  const equity = account?.equity ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-lg font-semibold">Positions</h1>
      {brokerageError && (
        <div className="rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
          Brokerage unavailable: {brokerageError}
        </div>
      )}

      <Card>
        {positions.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th className="text-right">Quantity</Th>
                  <Th className="text-right">Avg entry</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Market value</Th>
                  <Th className="text-right">Allocation</Th>
                  <Th className="text-right">Unrealized P/L</Th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-b border-edge/50 last:border-0">
                    <Td className="font-semibold">{p.symbol}</Td>
                    <Td className="text-right">{p.quantity}</Td>
                    <Td className="text-right">{fmtUsd(p.averageEntryPrice)}</Td>
                    <Td className="text-right">{fmtUsd(p.currentPrice)}</Td>
                    <Td className="text-right">{fmtUsd(p.marketValue)}</Td>
                    <Td className="text-right">
                      {equity > 0 ? `${((p.marketValue / equity) * 100).toFixed(1)}%` : "—"}
                    </Td>
                    <Td
                      className={`text-right ${p.unrealizedPl >= 0 ? "text-positive" : "text-negative"}`}
                    >
                      {fmtUsd(p.unrealizedPl)} ({fmtPct(p.unrealizedPlPct)})
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {positions.map((p) => {
        const related = orders.filter((o) => o.symbol === p.symbol).slice(0, 5);
        const reasoning = proposals.filter(
          (x) => x.symbol === p.symbol && x.status === "EXECUTED",
        );
        if (related.length === 0 && reasoning.length === 0) return null;
        return (
          <Card key={p.symbol} title={`${p.symbol} — history & reasoning`}>
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
                  Related trades
                </h3>
                {related.length === 0 ? (
                  <Empty>No recorded trades.</Empty>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {related.map((o) => (
                      <li key={o.id} className="flex items-center gap-2">
                        <span className={o.side === "buy" ? "text-positive" : "text-negative"}>
                          {o.side.toUpperCase()}
                        </span>
                        <span>
                          {o.quantity} @ {o.filledAvgPrice ? fmtUsd(o.filledAvgPrice) : "—"}
                        </span>
                        <span className="ml-auto text-xs text-faint">
                          {fmtDateTime(o.submittedAt)} · {o.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
                  AI reasoning
                </h3>
                {reasoning.length === 0 ? (
                  <Empty>No stored reasoning.</Empty>
                ) : (
                  <ul className="space-y-2 text-sm text-muted">
                    {reasoning.slice(0, 3).map((r) => (
                      <li key={r.id}>
                        <p>{r.conciseReasoning}</p>
                        <p className="mt-0.5 text-xs text-faint">
                          {fmtDateTime(r.createdAt)} · confidence {r.confidence}/100 · risk:{" "}
                          {r.keyRisk}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
