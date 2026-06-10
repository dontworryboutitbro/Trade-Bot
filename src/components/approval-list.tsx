"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Empty } from "@/components/ui";
import { fmtDateTime, fmtUsd } from "@/lib/utils";
import type { TradeProposal } from "@/lib/types";

export function ApprovalList({ proposals }: { proposals: TradeProposal[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    if (
      decision === "APPROVED" &&
      !window.confirm("Approve this trade? A final risk check runs immediately before submission.")
    ) {
      return;
    }
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: id, decision, reason: null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "Action failed");
      else if (decision === "APPROVED" && json.executed === false) {
        setError(`Approved, but execution was blocked: ${(json.reasons ?? []).join("; ")}`);
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) {
    return <Empty>No proposals awaiting approval.</Empty>;
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-critical">{error}</p>}
      {proposals.map((p) => (
        <div key={p.id} className="rounded-md border border-edge bg-raised p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={p.action === "BUY" ? "green" : "amber"}>{p.action}</Badge>
            <span className="font-semibold">
              {p.quantity} × {p.symbol}
            </span>
            <span className="tabular text-sm text-muted">≈ {fmtUsd(p.proposedNotional)}</span>
            <span className="ml-auto text-xs text-faint">
              Confidence {p.confidence}/100 · expires {fmtDateTime(p.expiresAt)}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted">{p.conciseReasoning}</p>
          <p className="mt-1 text-xs text-faint">Key risk: {p.keyRisk}</p>
          <div className="mt-3 flex gap-2">
            <button
              disabled={busy !== null}
              onClick={() => decide(p.id, "APPROVED")}
              className="rounded bg-positive/90 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-positive disabled:opacity-40"
            >
              Approve & execute
            </button>
            <button
              disabled={busy !== null}
              onClick={() => decide(p.id, "REJECTED")}
              className="rounded border border-edge-strong px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-muted hover:text-foreground disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
