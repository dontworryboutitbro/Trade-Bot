import { Badge, Card, Empty, Stat, Td, Th, plTone } from "@/components/ui";
import { getStore } from "@/lib/store";
import { deriveRoundTrips } from "@/lib/journal-stats";
import { STRATEGIES } from "@/lib/strategies/definitions";
import { modeToEnvironment } from "@/lib/types";
import { fmtDateTime, fmtPct, fmtUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PaperJournalPage({
  searchParams,
}: {
  searchParams: Promise<{ strategy?: string; regime?: string; symbol?: string }>;
}) {
  const params = await searchParams;
  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);
  const [entries, orders, auditEvents] = await Promise.all([
    store.listJournalEntries({ environment, limit: 500 }),
    store.listOrders({ environment, limit: 500 }),
    store.listAuditEvents(300),
  ]);

  let trips = deriveRoundTrips(entries, orders);
  let filteredEntries = entries;
  if (params.strategy) {
    trips = trips.filter((t) => t.strategyId === params.strategy);
    filteredEntries = filteredEntries.filter((e) => e.strategyId === params.strategy);
  }
  if (params.regime) {
    trips = trips.filter((t) => t.regime === params.regime);
    filteredEntries = filteredEntries.filter((e) => e.regime === params.regime);
  }
  if (params.symbol) {
    trips = trips.filter((t) => t.symbol === params.symbol);
    filteredEntries = filteredEntries.filter((e) => e.symbol === params.symbol);
  }

  const realized = trips.reduce((s, t) => s + t.plUsd, 0);
  const realizedNet = trips.reduce((s, t) => s + t.plUsd - t.estimatedCostsUsd, 0);
  const wins = trips.filter((t) => t.plUsd > 0);
  const noTradeCount = auditEvents.filter(
    (e) => e.action === "AI_DECISION_PASSIVE",
  ).length;
  const rejectedCount = auditEvents.filter((e) =>
    ["PROPOSAL_BLOCKED", "EXECUTION_BLOCKED"].includes(e.action),
  ).length;
  const regimes = Array.from(new Set(entries.map((e) => e.regime).filter(Boolean))) as string[];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-lg font-semibold">Paper Journal</h1>
        <a href="/paper-journal" className={`rounded-full border px-3 py-1 text-xs ${!params.strategy && !params.regime ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-muted"}`}>
          All
        </a>
        {STRATEGIES.map((s) => (
          <a
            key={s.id}
            href={`/paper-journal?strategy=${s.id}`}
            className={`rounded-full border px-3 py-1 text-xs ${params.strategy === s.id ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-muted hover:text-foreground"}`}
          >
            {s.name.split(" ")[0]}
          </a>
        ))}
        {regimes.map((r) => (
          <a
            key={r}
            href={`/paper-journal?regime=${r}`}
            className={`rounded-full border px-3 py-1 text-xs ${params.regime === r ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-faint hover:text-foreground"}`}
          >
            {r.replace(/_/g, " ")}
          </a>
        ))}
        <a
          href="/api/journal-export"
          className="ml-auto rounded border border-edge-strong px-3 py-1 text-xs text-muted hover:border-accent hover:text-foreground"
        >
          Export CSV
        </a>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Closed round trips" value={trips.length} sub={`${entries.length} journal entries`} />
        <Stat label="Realized P/L (gross)" value={fmtUsd(realized)} tone={plTone(realized)} />
        <Stat label="Realized P/L (after est. costs)" value={fmtUsd(realizedNet)} tone={plTone(realizedNet)} />
        <Stat
          label="Win rate"
          value={trips.length ? `${((wins.length / trips.length) * 100).toFixed(0)}%` : "—"}
          sub={`Expectancy ${trips.length ? fmtUsd(realizedNet / trips.length) : "—"}/trade`}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="HOLD / NO_TRADE decisions" value={noTradeCount} sub="abstaining is a feature" />
        <Stat label="Blocked / rejected" value={rejectedCount} sub="by the risk engine" />
        <Stat
          label="Avg holding"
          value={trips.length ? `${(trips.reduce((s, t) => s + t.holdingDays, 0) / trips.length).toFixed(1)}d` : "—"}
        />
        <Stat
          label="Data quality"
          value={`${entries.filter((e) => e.dataQualityOk).length}/${entries.length || "—"}`}
          sub="entries with clean quotes"
        />
      </div>

      <Card title="Closed round trips">
        {trips.length === 0 ? (
          <Empty>No closed round trips match this filter yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th>Strategy</Th>
                  <Th>Regime</Th>
                  <Th className="text-right">Entry → Exit</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">P/L</Th>
                  <Th className="text-right">Held</Th>
                </tr>
              </thead>
              <tbody>
                {trips.slice(0, 50).map((t, i) => (
                  <tr key={i} className="border-b border-edge/50 last:border-0">
                    <Td className="font-medium">{t.symbol}</Td>
                    <Td className="text-xs text-muted">{t.strategyId ?? "—"}</Td>
                    <Td className="text-xs text-faint">{t.regime?.replace(/_/g, " ") ?? "—"}</Td>
                    <Td className="text-right">
                      {fmtUsd(t.entryPrice)} → {fmtUsd(t.exitPrice)}
                    </Td>
                    <Td className="text-right">{t.quantity}</Td>
                    <Td className={`text-right ${t.plUsd >= 0 ? "text-positive" : "text-negative"}`}>
                      {fmtUsd(t.plUsd)} ({fmtPct(t.plPct)})
                    </Td>
                    <Td className="text-right">{t.holdingDays.toFixed(1)}d</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Journal entries (decision context)">
        {filteredEntries.length === 0 ? (
          <Empty>No journal entries yet — entries are written each time a proposal executes.</Empty>
        ) : (
          <div className="space-y-3">
            {filteredEntries.slice(0, 25).map((e) => (
              <div key={e.id} className="rounded-md border border-edge bg-raised p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.side === "buy" ? "green" : "amber"}>{e.side.toUpperCase()}</Badge>
                  <span className="font-medium">
                    {e.quantity} {e.symbol} @ {e.fillPrice ? fmtUsd(e.fillPrice) : "pending"}
                  </span>
                  {e.strategyId && <span className="text-xs text-muted">{e.strategyId}</span>}
                  {e.regime && <span className="text-xs text-faint">{e.regime.replace(/_/g, " ")}</span>}
                  {!e.dataQualityOk && <Badge tone="amber">Quote degraded</Badge>}
                  <span className="ml-auto text-xs text-faint">{fmtDateTime(e.createdAt)}</span>
                </div>
                {e.thesis && <p className="mt-2 text-xs text-muted">Thesis: {e.thesis}</p>}
                {e.counterargument && (
                  <p className="mt-1 text-xs text-faint">Counter: {e.counterargument}</p>
                )}
                {e.invalidationCondition && (
                  <p className="mt-1 text-xs text-faint">Invalidation: {e.invalidationCondition}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
