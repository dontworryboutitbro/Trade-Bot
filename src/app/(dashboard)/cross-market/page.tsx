import { Badge, Card, Empty, Stat, Td, Th } from "@/components/ui";
import { buildCrossMarketRows } from "@/lib/cross-market/research";
import { isNotable } from "@/lib/cross-market/scoring";
import type { MatchQuality } from "@/lib/cross-market/types";
import { fmtDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const qualityTone: Record<MatchQuality, "green" | "amber" | "red" | "muted"> = {
  EXACT_MATCH: "green",
  CLOSE_PROXY: "amber",
  EXPIRY_MISMATCH: "amber",
  SETTLEMENT_RULE_MISMATCH: "amber",
  STALE_DATA: "red",
  LOW_LIQUIDITY: "amber",
  FALLBACK_DATA: "muted",
  REJECTED: "red",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="text-xs text-faint">—</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points
    .map((p, i) => `${(i / (points.length - 1)) * 60},${18 - ((p - min) / range) * 16}`)
    .join(" ");
  return (
    <svg width="60" height="20" className="inline-block">
      <polyline points={coords} fill="none" stroke="#c9a96a" strokeWidth="1.2" />
    </svg>
  );
}

export default async function CrossMarketPage() {
  const rows = await buildCrossMarketRows();
  const notable = rows.filter(isNotable);
  const exact = rows.filter((r) => r.matchQuality === "EXACT_MATCH").length;
  const stale = rows.filter((r) => r.matchQuality === "STALE_DATA").length;
  const fallback = rows.filter((r) => r.matchQuality === "FALLBACK_DATA").length;
  const largest = notable.sort((a, b) => (b.netDivergence ?? 0) - (a.netDivergence ?? 0))[0];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <h1 className="text-lg font-semibold">Cross-Market Research</h1>

      <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs text-warning">
        Cross-market research only. Divergences may reflect different expiries, settlement rules,
        liquidity, and risk premia. This module is read-only: it cannot place orders anywhere.
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Largest net divergence"
          value={largest ? pct(largest.netDivergence) : "—"}
          sub={largest?.event.slice(0, 40)}
        />
        <Stat label="Exact matches" value={exact} sub={`${rows.length} events tracked`} />
        <Stat label="Stale data" value={stale} />
        <Stat label="Fallback rows" value={fallback} sub="no external comparison available" />
      </div>

      <Card title="Featured events">
        {rows.length === 0 ? (
          <Empty>No cross-market data available right now.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Event</Th>
                  <Th className="text-right">PM mid</Th>
                  <Th className="text-right">Buy (ask)</Th>
                  <Th className="text-right">External prob</Th>
                  <Th className="text-right">Raw div</Th>
                  <Th className="text-right">Net div</Th>
                  <Th>Match</Th>
                  <Th>7d</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-edge/50 align-top last:border-0">
                    <Td>
                      <div className="font-medium">{row.event}</div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-faint hover:text-muted">
                          Details
                        </summary>
                        <div className="mt-1 space-y-0.5 text-xs text-faint">
                          <p>Slug: {row.polymarketSlug ?? "—"}</p>
                          <p>Intended expiry: {fmtDateTime(row.intendedExpiry)}</p>
                          <p>Actual expiry: {row.actualExpiry ? fmtDateTime(row.actualExpiry) : "—"}</p>
                          <p>External method: {row.externalMethod}</p>
                          <p>Depth (top 5 levels): {row.depthUsd ? `$${row.depthUsd.toFixed(0)}` : "—"}</p>
                          <p>Safety buffer deducted: 2 pts + half-spread</p>
                          {row.mismatchExplanation && <p>Note: {row.mismatchExplanation}</p>}
                          <p>Captured: {fmtDateTime(row.capturedAt)}</p>
                        </div>
                      </details>
                    </Td>
                    <Td className="text-right">{pct(row.midpoint)}</Td>
                    <Td className="text-right">{pct(row.yesBestAsk)}</Td>
                    <Td className="text-right">{pct(row.externalImpliedProbability)}</Td>
                    <Td className="text-right">
                      {row.rawDivergence === null ? "—" : `${(row.rawDivergence * 100).toFixed(1)} pts`}
                    </Td>
                    <Td
                      className={`text-right ${row.netDivergence !== null && row.netDivergence > 0 ? "text-warning" : ""}`}
                    >
                      {row.netDivergence === null ? "—" : `${(row.netDivergence * 100).toFixed(1)} pts`}
                    </Td>
                    <Td>
                      <Badge tone={qualityTone[row.matchQuality]}>
                        {row.matchQuality.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                    <Td>
                      <Sparkline points={row.sparkline} />
                    </Td>
                    <Td className="text-xs text-muted">{row.sourceStatus}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-faint">
        Sources: Polymarket Gamma + public CLOB read endpoints. External probabilities are
        model-based proxies where labeled. No Polymarket account, wallet, or execution exists in
        this app, and this data can never trigger an Alpaca order.
      </p>
    </div>
  );
}
