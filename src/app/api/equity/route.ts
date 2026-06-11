import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { getStore } from "@/lib/store";

// Lightweight live-equity feed for the Autopilot chart. Auth required.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const store = await getStore();
  const settings = await store.getSettings();
  try {
    const brokerage = getBrokerageClient(settings.tradingMode);
    const [account, clock] = await Promise.all([
      brokerage.getAccount(),
      getMarketDataClient(settings.tradingMode)
        .getMarketClock()
        .catch(() => null),
    ]);
    return NextResponse.json({
      mode: settings.tradingMode,
      equity: account.equity,
      cash: account.cash,
      marketOpen: clock?.isOpen ?? null,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 200) : "Brokerage unavailable" },
      { status: 502 },
    );
  }
}
