"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, ...json } : { ok: false, error: json.error ?? res.statusText };
}

export function EmergencyControls({
  killSwitch,
  stopNewOrders,
  compact = false,
}: {
  killSwitch: boolean;
  stopNewOrders: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  async function run(name: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(name);
    setMessage(null);
    try {
      const result = await fn();
      if (!result.ok) setMessage(result.error ?? "Action failed");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const btn =
    "rounded border px-3 py-2 text-xs font-bold uppercase tracking-wide transition-colors disabled:opacity-40";

  return (
    <div id="emergency">
      <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4"}`}>
        <button
          disabled={busy !== null}
          className={`${btn} ${stopNewOrders ? "border-warning bg-warning/20 text-warning" : "border-warning/50 text-warning hover:bg-warning/15"}`}
          onClick={() => run("stop", () => post("/api/admin/stop-orders", { stop: !stopNewOrders }))}
        >
          {stopNewOrders ? "Resume new orders" : "Stop new orders"}
        </button>
        <button
          disabled={busy !== null}
          className={`${btn} border-warning/50 text-warning hover:bg-warning/15`}
          onClick={() => {
            if (window.confirm("Cancel ALL open orders at the brokerage?")) {
              run("cancel", () => post("/api/admin/cancel-orders", {}));
            }
          }}
        >
          Cancel open orders
        </button>
        <button
          disabled={busy !== null}
          className={`${btn} border-critical/60 text-critical hover:bg-critical/15`}
          onClick={() => {
            const typed = window.prompt(
              'CLOSE ALL POSITIONS?\n\nThis liquidates every holding at market. Live fill prices may vary from the last quote.\n\nType "CLOSE ALL POSITIONS" to confirm:',
            );
            if (typed !== null) {
              run("close", () => post("/api/admin/close-positions", { confirmation: typed }));
            }
          }}
        >
          Close all positions
        </button>
        {killSwitch ? (
          <button
            disabled={busy !== null}
            className={`${btn} border-critical bg-critical text-white`}
            onClick={() => {
              const typed = window.prompt(
                'Reset the global kill switch?\n\nType "RESET KILL SWITCH" to confirm. Stop-new-orders will remain ON until separately disabled.',
              );
              if (typed !== null) {
                run("kill", () =>
                  post("/api/admin/kill-switch", { action: "RESET", acknowledgment: typed }),
                );
              }
            }}
          >
            Reset kill switch
          </button>
        ) : (
          <button
            disabled={busy !== null}
            className={`${btn} border-critical bg-critical/90 text-white hover:bg-critical`}
            onClick={() => {
              const reason = window.prompt(
                "ENGAGE GLOBAL KILL SWITCH?\n\nBlocks all new orders immediately, rejects queued proposals, and attempts to cancel open orders.\n\nEnter a reason to confirm:",
              );
              if (reason !== null) {
                run("kill", () => post("/api/admin/kill-switch", { action: "ENGAGE", reason }));
              }
            }}
          >
            Global kill switch
          </button>
        )}
      </div>
      {message && <p className="mt-2 text-xs text-critical">{message}</p>}
    </div>
  );
}
