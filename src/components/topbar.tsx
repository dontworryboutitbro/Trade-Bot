"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModeBadge } from "@/components/mode-badge";
import { Badge, LivePulse } from "@/components/ui";
import type { TradingMode } from "@/lib/types";
import { isLiveMode } from "@/lib/types";

interface Status {
  mode: TradingMode;
  killSwitch: boolean;
  stopNewOrders: boolean;
  marketOpen: boolean | null;
  brokerageOk: boolean | null;
  spy: { price: number; changePct: number | null } | null;
  regime: string | null;
  syncedAt: string;
}

export function TopBar({ initialMode }: { initialMode: TradingMode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } catch {
      // top bar degrades silently; pages surface errors
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [refresh]);

  const mode = status?.mode ?? initialMode;

  async function toggleKillSwitch() {
    if (!status) return;
    if (status.killSwitch) {
      router.push("/settings#emergency");
      return;
    }
    const reason = window.prompt(
      "ENGAGE GLOBAL KILL SWITCH?\n\nThis immediately blocks all new orders, rejects queued proposals, and attempts to cancel open orders.\n\nEnter a reason to confirm:",
    );
    if (reason === null) return;
    setBusy(true);
    try {
      await fetch("/api/admin/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ENGAGE", reason }),
      });
      await refresh();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {isLiveMode(mode) && (
        <div className="relative z-20 bg-critical px-4 py-1 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-white">
          Live money — real funds are at risk in this mode
        </div>
      )}
      {status?.killSwitch && (
        <div className="relative z-20 border-b border-critical bg-critical/15 px-4 py-1 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-critical">
          Global kill switch engaged — all order creation blocked · reset in Settings
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2.5 border-b border-edge bg-background/90 px-4 backdrop-blur">
        <ModeBadge mode={mode} />

        <div className="hidden items-center gap-2.5 sm:flex">
          {status?.marketOpen !== null && status?.marketOpen !== undefined && (
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              <LivePulse tone={status.marketOpen ? "green" : "muted"} />
              {status.marketOpen ? "Market open" : "Market closed"}
            </span>
          )}
          {status?.spy && (
            <span className="font-num text-[11px] text-muted">
              SPY{" "}
              <span className="text-foreground">${status.spy.price.toFixed(2)}</span>{" "}
              {status.spy.changePct !== null && (
                <span className={status.spy.changePct >= 0 ? "text-positive" : "text-negative"}>
                  {status.spy.changePct >= 0 ? "+" : ""}
                  {status.spy.changePct.toFixed(2)}%
                </span>
              )}
            </span>
          )}
          {status?.regime && status.regime !== "INSUFFICIENT_DATA" && (
            <Badge tone="violet">{status.regime.replace(/_/g, " ")}</Badge>
          )}
          {status?.brokerageOk !== null && status?.brokerageOk !== undefined && (
            <span className="hidden items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] lg:flex">
              <LivePulse tone={status.brokerageOk ? "green" : "red"} />
              <span className={status.brokerageOk ? "text-muted" : "text-critical"}>
                {mode === "MOCK" ? "Mock data" : "Alpaca"}
              </span>
            </span>
          )}
          {status?.syncedAt && (
            <span className="font-num hidden text-[10px] uppercase text-faint xl:inline">
              SYNC{" "}
              {new Date(status.syncedAt).toLocaleTimeString("en-US", {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {status?.stopNewOrders && !status.killSwitch && (
            <Badge tone="amber">Orders stopped</Badge>
          )}
          <button
            onClick={toggleKillSwitch}
            disabled={busy}
            className={`rounded-[5px] border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${
              status?.killSwitch
                ? "border-critical bg-critical text-white"
                : "border-critical/60 text-critical hover:bg-critical hover:text-white"
            } disabled:opacity-50`}
          >
            {status?.killSwitch ? "Kill switch ON" : "Kill switch"}
          </button>
        </div>
      </header>
    </>
  );
}
