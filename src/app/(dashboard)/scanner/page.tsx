import { Badge, Card, Empty, Stat, StatusRow, Td, Th } from "@/components/ui";
import { getStore } from "@/lib/store";
import { fmtDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */

function classifyWorkerState(lastBeatIso: string | null): string {
  if (!lastBeatIso) return "NOT DEPLOYED";
  const ageMin = (Date.now() - new Date(lastBeatIso).getTime()) / 60_000;
  return ageMin < 3 ? "SCANNER ACTIVE" : "HEARTBEAT STALE";
}

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "all" } = await searchParams;
  const store = await getStore();
  const [runs, candidateRows, rejectionRows, heartbeats, streamEvents, changes] =
    await Promise.all([
      store.listLearningRecords("scanner_runs", { limit: 10 }),
      store.listLearningRecords("scanner_candidates", { limit: 1 }),
      store.listLearningRecords("asset_rejections", { limit: 150 }),
      store.listLearningRecords("worker_heartbeats", { limit: 5 }),
      store.listLearningRecords("worker_stream_health", { limit: 10 }),
      store.listLearningRecords("execution_universe_changes", { limit: 10 }),
    ]);

  const lastRun = runs[0]?.payload as any | undefined;
  const lastRunAt = runs[0]?.createdAt ?? null;
  const candidates = ((candidateRows[0]?.payload as any)?.ranked ?? []) as {
    symbol: string; assetClass: string; score: number; components: Record<string, number>;
  }[];
  const lastHeartbeat = heartbeats[0];
  const workerState = classifyWorkerState(lastHeartbeat?.createdAt ?? null);

  let rejections = rejectionRows.map((r) => ({
    symbol: String(r.keys.symbol ?? "?"),
    layer: String(r.keys.layer ?? "?"),
    reasons: ((r.payload as any)?.reasons ?? []) as string[],
    at: r.createdAt,
  }));
  // De-duplicate to the latest record per symbol.
  const seen = new Set<string>();
  rejections = rejections.filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)));
  if (filter === "rejected") rejections = rejections.filter((r) => r.layer === "REJECTED");
  else if (filter === "stale") rejections = rejections.filter((r) => r.reasons.join(" ").toLowerCase().includes("stale"));
  else if (filter === "liquidity") rejections = rejections.filter((r) => r.reasons.join(" ").toLowerCase().includes("volume"));
  else if (filter === "spread") rejections = rejections.filter((r) => r.reasons.join(" ").toLowerCase().includes("spread"));
  else if (filter === "crypto") rejections = rejections.filter((r) => r.symbol.includes("/"));
  else if (filter === "stocks") rejections = rejections.filter((r) => !r.symbol.includes("/"));

  const FILTERS = [
    ["all", "All"], ["stocks", "Stocks"], ["crypto", "Crypto"], ["rejected", "Rejected"],
    ["stale", "Stale quotes"], ["liquidity", "Low liquidity"], ["spread", "Wide spread"],
  ] as const;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-base font-semibold tracking-tight">Scanner</h1>
        <Badge tone={workerState === "SCANNER ACTIVE" ? "magenta" : "muted"}>{workerState}</Badge>
        {lastRunAt && (
          <span className="font-num text-[10px] uppercase text-faint">
            Last universe refresh {fmtDateTime(lastRunAt)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Stat label="Equities discovered" value={lastRun?.discovered?.equities ?? "—"} />
        <Stat label="Crypto pairs" value={lastRun?.discovered?.crypto ?? "—"} />
        <Stat label="Research eligible" value={lastRun?.researchEligible ?? "—"} sub={`pool of ${lastRun?.evaluatedPool ?? "—"} evaluated`} />
        <Stat label="Paper-execution eligible" value={lastRun?.paperExecutionEligible ?? "—"} />
        <Stat label="Rejected" value={lastRun?.rejected ?? "—"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top ranked candidates (deterministic, pre-AI)">
          {candidates.length === 0 ? (
            <Empty>Run a universe refresh to rank candidates</Empty>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th>Class</Th>
                  <Th className="text-right">Score</Th>
                  <Th className="text-right">Trend</Th>
                  <Th className="text-right">RS</Th>
                  <Th className="text-right">Liquidity</Th>
                </tr>
              </thead>
              <tbody>
                {candidates.slice(0, 12).map((c) => (
                  <tr key={c.symbol} className="border-b border-edge/40 transition-colors last:border-0 hover:bg-raised/50">
                    <Td className="font-medium">{c.symbol}</Td>
                    <Td className="text-[10px] uppercase text-faint">{c.assetClass === "crypto" ? "Crypto" : "Equity"}</Td>
                    <Td className="text-right text-accent">{c.score.toFixed(1)}</Td>
                    <Td className="text-right">{c.components.trend?.toFixed(0) ?? "—"}</Td>
                    <Td className="text-right">{c.components.relativeStrength?.toFixed(0) ?? "—"}</Td>
                    <Td className="text-right">{c.components.liquidity?.toFixed(0) ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Worker health">
          {!lastHeartbeat ? (
            <div>
              <Empty>No worker heartbeats yet</Empty>
              <p className="text-[11px] text-faint">
                The always-on worker streams quotes 24/7 and is deployed separately (see{" "}
                <code className="text-muted">worker/README.md</code>). Without it, the 6-hour
                serverless universe cron remains the baseline — scanning still works, just slower.
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              <StatusRow label="Heartbeat" state={workerState} tone={workerState === "SCANNER ACTIVE" ? "magenta" : "amber"} pulse={workerState === "SCANNER ACTIVE"} />
              <StatusRow label="Last beat" state={fmtDateTime(lastHeartbeat.createdAt)} tone="muted" />
              <StatusRow label="Equity stream" state={String((lastHeartbeat.payload as any)?.equity?.status ?? "—")} tone={(lastHeartbeat.payload as any)?.equity?.status === "CONNECTED" ? "green" : "amber"} />
              <StatusRow label="Crypto stream" state={String((lastHeartbeat.payload as any)?.crypto?.status ?? "—")} tone={(lastHeartbeat.payload as any)?.crypto?.status === "CONNECTED" ? "green" : "amber"} />
              <StatusRow label="Reconnects" state={String(((lastHeartbeat.payload as any)?.equity?.reconnects ?? 0) + ((lastHeartbeat.payload as any)?.crypto?.reconnects ?? 0))} tone="muted" />
              <StatusRow label="REST fallback" state={(lastHeartbeat.payload as any)?.equity?.fallbackActive || (lastHeartbeat.payload as any)?.crypto?.fallbackActive ? "ACTIVE" : "STANDBY"} tone="muted" />
            </div>
          )}
          {streamEvents.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-edge pt-2 text-[10px] text-faint">
              {streamEvents.slice(0, 4).map((e) => (
                <li key={e.id}>
                  {fmtDateTime(e.createdAt)} · {String(e.keys.stream)} {String(e.keys.event)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Eligibility rejections (latest per symbol)">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {FILTERS.map(([key, label]) => (
            <a
              key={key}
              href={`/scanner?filter=${key}`}
              className={`rounded-[4px] border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${filter === key ? "border-accent/60 bg-accent/10 text-accent" : "border-edge text-faint hover:text-muted"}`}
            >
              {label}
            </a>
          ))}
        </div>
        {rejections.length === 0 ? (
          <Empty>No matching rejections</Empty>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th>Symbol</Th>
                  <Th>Reached layer</Th>
                  <Th>Reasons</Th>
                </tr>
              </thead>
              <tbody>
                {rejections.slice(0, 60).map((r) => (
                  <tr key={r.symbol} className="border-b border-edge/40 align-top last:border-0">
                    <Td className="font-medium">{r.symbol}</Td>
                    <Td>
                      <Badge tone={r.layer === "REJECTED" ? "red" : r.layer === "RESEARCH_UNIVERSE" ? "amber" : "muted"}>
                        {r.layer.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                    <Td className="text-[11px] text-muted">{r.reasons.join(" ")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {changes.length > 0 && (
        <Card title="Execution-universe changes">
          <ul className="space-y-1.5 text-[12px] text-muted">
            {changes.slice(0, 6).map((c) => (
              <li key={c.id} className="font-num">
                {fmtDateTime(c.createdAt)} — +{((c.payload as any)?.activated ?? []).length} activated,{" "}
                -{((c.payload as any)?.deactivated ?? []).length} deactivated{" "}
                <span className="text-faint">({String(c.keys.trigger)})</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-[10px] uppercase tracking-[0.16em] text-faint">
        Scan broadly · trade selectively — discovery never implies execution eligibility
      </p>
    </div>
  );
}
