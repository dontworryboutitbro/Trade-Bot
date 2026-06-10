"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModeBadge } from "@/components/mode-badge";
import { Badge } from "@/components/ui";
import type { TradingMode } from "@/lib/types";
import { isLiveMode } from "@/lib/types";

interface Status {
  mode: TradingMode;
  killSwitch: boolean;
  stopNewOrders: boolean;
  marketOpen: boolean | null;
  brokerageOk: boolean | null;
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
        <div className="bg-critical px-4 py-1.5 text-center text-xs font-bold uppercase tracking-widest text-white">
          Live money — real funds are at risk in this mode
        </div>
      )}
      {status?.killSwitch && (
        <div className="bg-critical/20 border-b border-critical px-4 py-1.5 text-center text-xs font-semibold text-critical">
          GLOBAL KILL SWITCH ENGAGED — all order creation is blocked. Reset it in Settings.
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-edge bg-background/95 px-4 backdrop-blur">
        <span className="text-sm font-semibold tracking-tight">Fable Fund Lab</span>
        <ModeBadge mode={mode} />
        <div className="hidden items-center gap-3 text-xs text-muted sm:flex">
          {status?.marketOpen !== null && status?.marketOpen !== undefined && (
            <span className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${status.marketOpen ? "bg-positive" : "bg-faint"}`}
              />
              Market {status.marketOpen ? "open" : "closed"}
            </span>
          )}
          {status?.brokerageOk !== null && status?.brokerageOk !== undefined && (
            <span className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${status.brokerageOk ? "bg-positive" : "bg-critical"}`}
              />
              {mode === "MOCK" ? "Mock data" : "Alpaca"}
            </span>
          )}
          {status?.syncedAt && (
            <span className="hidden text-faint lg:inline">
              Synced{" "}
              {new Date(status.syncedAt).toLocaleTimeString("en-US", {
                hour: "numeric",
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
            className={`rounded border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
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
