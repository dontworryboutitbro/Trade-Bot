import { Badge, Card, Empty } from "@/components/ui";
import { getActivityData } from "@/lib/dashboard";
import { fmtDateTime, fmtUsd } from "@/lib/utils";
import type { ProposalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const statusTone: Record<string, "muted" | "amber" | "red" | "green"> = {
  EXECUTED: "green",
  FILLED: "green",
  AWAITING_APPROVAL: "amber",
  QUEUED: "amber",
  SUBMITTED: "amber",
  ACCEPTED: "amber",
  PARTIALLY_FILLED: "amber",
  BLOCKED: "red",
  REJECTED: "red",
  FAILED: "red",
  CANCELED: "muted",
  EXPIRED: "muted",
};

const FILTERS: { key: string; label: string; statuses: ProposalStatus[] }[] = [
  { key: "all", label: "All", statuses: [] },
  { key: "executed", label: "Executed", statuses: ["EXECUTED"] },
  { key: "pending", label: "Pending", statuses: ["AWAITING_APPROVAL", "QUEUED", "EXECUTING"] },
  { key: "blocked", label: "Blocked", statuses: ["BLOCKED"] },
  { key: "rejected", label: "Rejected / failed", statuses: ["REJECTED", "FAILED", "EXPIRED"] },
];

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = "all" } = await searchParams;
  const data = await getActivityData();
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const proposals =
    active.statuses.length === 0
      ? data.proposals
      : data.proposals.filter((p) => active.statuses.includes(p.status));
  const ordersByProposal = new Map(data.orders.filter((o) => o.proposalId).map((o) => [o.proposalId!, o]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-4 text-lg font-semibold">Activity</h1>
        {FILTERS.map((f) => (
          <a
            key={f.key}
            href={`/activity?filter=${f.key}`}
            className={`rounded-full border px-3 py-1 text-xs ${
              f.key === active.key
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-edge text-muted hover:text-foreground"
            }`}
          >
            {f.label}
          </a>
        ))}
      </div>

      {proposals.length === 0 ? (
        <Card>
          <Empty>No matching activity.</Empty>
        </Card>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => {
            const order = ordersByProposal.get(p.id);
            const evaluations = data.evaluationsByProposal[p.id] ?? [];
            const latestEval = evaluations[0];
            return (
              <Card key={p.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={statusTone[p.status] ?? "muted"}>{p.status.replace(/_/g, " ")}</Badge>
                  <span className="font-semibold">
                    {p.action} {p.quantity} {p.symbol}
                  </span>
                  <span className="tabular text-sm text-muted">≈ {fmtUsd(p.proposedNotional)}</span>
                  <span className="ml-auto text-xs text-faint">{fmtDateTime(p.createdAt)}</span>
                </div>

                <p className="mt-2 text-sm text-muted">{p.conciseReasoning}</p>
                <p className="mt-1 text-xs text-faint">
                  Key risk: {p.keyRisk} · Confidence {p.confidence}/100 · {p.orderType}
                  {p.limitPrice ? ` @ ${fmtUsd(p.limitPrice)}` : ""}
                </p>

                {/* status timeline */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                  <span className="rounded bg-raised px-2 py-0.5">Proposed {fmtDateTime(p.createdAt)}</span>
                  {latestEval && (
                    <>
                      <span>→</span>
                      <span
                        className={`rounded px-2 py-0.5 ${latestEval.overallResult === "PASS" ? "bg-positive/15 text-positive" : "bg-critical/15 text-critical"}`}
                      >
                        Risk {latestEval.overallResult} {fmtDateTime(latestEval.evaluatedAt)}
                      </span>
                    </>
                  )}
                  {order && (
                    <>
                      <span>→</span>
                      <span className="rounded bg-raised px-2 py-0.5">
                        {order.status}{" "}
                        {order.filledAvgPrice
                          ? `${order.filledQuantity} @ ${fmtUsd(order.filledAvgPrice)}`
                          : ""}
                      </span>
                    </>
                  )}
                </div>

                {latestEval && latestEval.blockReasons.length > 0 && (
                  <div className="mt-3 rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
                    {latestEval.blockReasons.map((r, i) => (
                      <p key={i}>{r}</p>
                    ))}
                  </div>
                )}

                {latestEval && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-faint hover:text-muted">
                      Risk checks ({latestEval.checks.filter((c) => c.passed).length}/
                      {latestEval.checks.length} passed)
                    </summary>
                    <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                      {latestEval.checks.map((c) => (
                        <li key={c.name} className="flex items-start gap-1.5">
                          <span className={c.passed ? "text-positive" : "text-critical"}>
                            {c.passed ? "✓" : "✕"}
                          </span>
                          <span className="text-muted">
                            <span className="text-foreground">{c.name}</span>: {c.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
