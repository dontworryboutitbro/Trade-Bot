import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { deriveRoundTrips } from "@/lib/journal-stats";
import { modeToEnvironment } from "@/lib/types";

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV export of the paper journal (round trips + entries). Auth required.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const store = await getStore();
  const settings = await store.getSettings();
  const environment = modeToEnvironment(settings.tradingMode);
  const [entries, orders] = await Promise.all([
    store.listJournalEntries({ environment, limit: 1000 }),
    store.listOrders({ environment, limit: 1000 }),
  ]);
  const trips = deriveRoundTrips(entries, orders);

  const header = [
    "symbol","strategy","regime","confidence","entry_at","exit_at","entry_price","exit_price",
    "quantity","pl_usd","pl_pct","holding_days","est_costs_usd",
  ].join(",");
  const rows = trips.map((t) =>
    [
      t.symbol, t.strategyId ?? "", t.regime ?? "", t.confidence ?? "", t.entryAt, t.exitAt,
      t.entryPrice.toFixed(4), t.exitPrice.toFixed(4), t.quantity, t.plUsd.toFixed(2),
      t.plPct.toFixed(2), t.holdingDays.toFixed(2), t.estimatedCostsUsd.toFixed(2),
    ]
      .map(csvEscape)
      .join(","),
  );

  return new NextResponse([header, ...rows].join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="paper-journal-${environment.toLowerCase()}.csv"`,
    },
  });
}
