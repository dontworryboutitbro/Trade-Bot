import { BenchmarkChart, EquityChart } from "@/components/equity-chart";
import { Card, Empty, Stat, Td, Th, plTone } from "@/components/ui";
import { getPerformanceData } from "@/lib/dashboard";
import { fmtPct, fmtUsd } from "@/lib/utils";
import type { Environment } from "@/lib/types";

export const dynamic = "force-dynamic";

const ENVS: Environment[] = ["MOCK", "PAPER", "LIVE"];

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ env?: string }>;
}) {
  const params = await searchParams;
  const data = await getPerformanceData();
  const defaultEnv = (["MOCK", "PAPER", "LIVE"] as const).includes(
    params.env as Environment,
  )
    ? (params.env as Environment)
    : data.byEnvironment.LIVE.length > 0
      ? "LIVE"
      : data.byEnvironment.PAPER.length > 0
        ? "PAPER"
        : "MOCK";

  const snapshots = data.byEnvironment[defaultEnv];
  const orders = data.ordersByEnvironment[defaultEnv];
  const last = snapshots[snapshots.length - 1];
  const maxDrawdown = snapshots.reduce((max, s) => Math.max(max, s.drawdownPct), 0);
  const excess =
    last && last.benchmarkReturnPct !== null ? last.totalReturnPct - last.benchmarkReturnPct : null;
  const unrealized = data.positions.reduce((sum, p) => sum + p.unrealizedPl, 0);

  // Realized P/L by symbol from filled orders (sell proceeds - buy cost, FIFO-free approximation).
  const bySymbol = new Map<string, { bought: number; sold: number; buyQty: number; sellQty: number }>();
  for (const o of orders) {
    if (o.status !== "FILLED" || !o.filledAvgPrice) continue;
    const entry = bySymbol.get(o.symbol) ?? { bought: 0, sold: 0, buyQty: 0, sellQty: 0 };
    if (o.side === "buy") {
      entry.bought += o.filledAvgPrice * o.filledQuantity;
      entry.buyQty += o.filledQuantity;
    } else {
      entry.sold += o.filledAvgPrice * o.filledQuantity;
      entry.sellQty += o.filledQuantity;
    }
    bySymbol.set(o.symbol, entry);
  }
  const realized = Array.from(bySymbol.entries())
    .filter(([, v]) => v.sellQty > 0)
    .map(([symbol, v]) => {
      const avgBuy = v.buyQty > 0 ? v.bought / v.buyQty : 0;
      return { symbol, pl: v.sold - avgBuy * v.sellQty };
    });
  const realizedTotal = realized.reduce((sum, r) => sum + r.pl, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-lg font-semibold">Performance</h1>
        {ENVS.map((env) => (
          <a
            key={env}
            href={`/performance?env=${env}`}
            className={`rounded-full border px-3 py-1 text-xs ${
              env === defaultEnv
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-edge text-muted hover:text-foreground"
            }`}
          >
            {env}
            {data.byEnvironment[env].length === 0 && " (no data)"}
          </a>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Total return"
          value={fmtPct(last?.totalReturnPct)}
          tone={plTone(last?.totalReturnPct)}
        />
        <Stat
          label="SPY benchmark"
          value={fmtPct(last?.benchmarkReturnPct)}
          tone={plTone(last?.benchmarkReturnPct)}
        />
        <Stat
          label="Excess vs SPY"
          value={fmtPct(excess)}
          tone={plTone(excess)}
          sub={
            excess === null
              ? "No benchmark data"
              : excess >= 0
                ? "Outperforming SPY"
                : "Underperforming SPY"
          }
        />
        <Stat label="Max drawdown" value={fmtPct(-Math.abs(maxDrawdown))} tone="negative" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Realized P/L" value={fmtUsd(realizedTotal)} tone={plTone(realizedTotal)} />
        <Stat label="Unrealized P/L" value={fmtUsd(unrealized)} tone={plTone(unrealized)} />
        <Stat label="Equity" value={fmtUsd(last?.equity)} />
        <Stat label="Snapshots" value={snapshots.length} sub="daily captures" />
      </div>

      <p className="text-xs text-faint">
        Profit alone is not proof of skill — compare against the SPY line. Mock, paper, and live
        results are tracked separately and are not comparable to each other.
      </p>

      <Card title={`Equity — ${defaultEnv}`}>
        <EquityChart
          points={snapshots.map((s) => ({
            capturedAt: s.capturedAt,
            equity: s.equity,
            benchmarkReturnPct: s.benchmarkReturnPct,
            totalReturnPct: s.totalReturnPct,
          }))}
        />
      </Card>

      <Card title="Bot vs SPY (cumulative return)">
        <BenchmarkChart
          points={snapshots.map((s) => ({
            capturedAt: s.capturedAt,
            equity: s.equity,
            benchmarkReturnPct: s.benchmarkReturnPct,
            totalReturnPct: s.totalReturnPct,
          }))}
        />
        <div className="mt-2 flex gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-accent" /> Bot
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-faint" /> SPY
          </span>
        </div>
      </Card>

      <Card title="Returns by symbol">
        {data.positions.length === 0 && realized.length === 0 ? (
          <Empty>No position data.</Empty>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge">
                <Th>Symbol</Th>
                <Th className="text-right">Unrealized</Th>
                <Th className="text-right">Realized</Th>
              </tr>
            </thead>
            <tbody>
              {Array.from(
                new Set([...data.positions.map((p) => p.symbol), ...realized.map((r) => r.symbol)]),
              ).map((symbol) => {
                const pos = data.positions.find((p) => p.symbol === symbol);
                const real = realized.find((r) => r.symbol === symbol);
                return (
                  <tr key={symbol} className="border-b border-edge/50 last:border-0">
                    <Td className="font-medium">{symbol}</Td>
                    <Td
                      className={`text-right ${(pos?.unrealizedPl ?? 0) >= 0 ? "text-positive" : "text-negative"}`}
                    >
                      {pos ? `${fmtUsd(pos.unrealizedPl)} (${fmtPct(pos.unrealizedPlPct)})` : "—"}
                    </Td>
                    <Td
                      className={`text-right ${(real?.pl ?? 0) >= 0 ? "text-positive" : "text-negative"}`}
                    >
                      {real ? fmtUsd(real.pl) : "—"}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
