"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";

interface DrillResult {
  name: string;
  mandatory: boolean;
  status: "PASS" | "FAIL" | "SKIPPED";
  detail: string;
}
interface DrillRun {
  ranAt: string;
  results: DrillResult[];
  allMandatoryPassed: boolean;
}

export function DrillRunner({
  initialRun,
  gateReason,
}: {
  initialRun: DrillRun | null;
  gateReason: string | null;
}) {
  const [run, setRun] = useState<DrillRun | null>(initialRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function runDrills() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error ?? "Drill run failed");
      else setRun(json.run);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={runDrills}
          disabled={busy}
          className="rounded bg-accent/90 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-background hover:bg-accent disabled:opacity-40"
        >
          {busy ? "Running drills…" : "Run all drills"}
        </button>
        {gateReason && <span className="text-xs text-warning">⚠ {gateReason}</span>}
        {run?.allMandatoryPassed && (
          <Badge tone="green">All mandatory drills passed</Badge>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-critical">{error}</p>}
      {run && (
        <ul className="mt-4 space-y-1.5">
          {run.results.map((r) => (
            <li key={r.name} className="flex items-start gap-2 text-sm">
              <Badge tone={r.status === "PASS" ? "green" : r.status === "FAIL" ? "red" : "muted"}>
                {r.status}
              </Badge>
              <div>
                <span className="font-mono text-xs">{r.name}</span>
                {!r.mandatory && <span className="ml-1 text-[10px] text-faint">(optional)</span>}
                <p className="text-xs text-faint">{r.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PilotStageControl({ currentStage }: { currentStage: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const router = useRouter();

  async function setStage(stage: string) {
    const confirmation = window.prompt(
      `Change live capital stage to ${stage}?\n\nLive allocation changes require manual approval. Historical performance does not guarantee future profit.\n\nType "CHANGE LIVE CAPITAL STAGE" to confirm:`,
    );
    if (confirmation === null) return;
    const reason = window.prompt("Reason (recorded in the audit log):");
    if (!reason) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/pilot-stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, confirmation, reason }),
      });
      const json = await res.json().catch(() => ({}));
      setIsError(!res.ok);
      setMessage(res.ok ? `Stage set to ${stage}.` : (json.error ?? "Failed"));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {["CANARY_100", "PILOT_250", "PILOT_500", "REVIEW_REQUIRED"].map((stage) => (
          <button
            key={stage}
            disabled={busy || stage === currentStage}
            onClick={() => setStage(stage)}
            className={`rounded border px-3 py-1.5 text-xs font-bold uppercase tracking-wide disabled:cursor-default ${
              stage === currentStage
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-edge-strong text-muted hover:border-accent hover:text-foreground disabled:opacity-40"
            }`}
          >
            {stage.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      {message && (
        <p className={`mt-2 text-xs ${isError ? "text-critical" : "text-positive"}`}>{message}</p>
      )}
    </div>
  );
}
