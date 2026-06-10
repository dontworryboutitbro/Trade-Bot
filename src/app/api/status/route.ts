import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getBrokerageClient, getMarketDataClient } from "@/lib/brokerage/factory";
import { getStore } from "@/lib/store";

// Top-bar status: mode, market clock, connection, sync time. Auth required.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const store = await getStore();
  const settings = await store.getSettings();

  let marketOpen: boolean | null = null;
  let brokerageOk: boolean | null = null;
  try {
    const clock = await getMarketDataClient(settings.tradingMode).getMarketClock();
    marketOpen = clock.isOpen;
  } catch {
    marketOpen = null;
  }
  try {
    const check = await getBrokerageClient(settings.tradingMode).checkConnection();
    brokerageOk = check.ok;
  } catch {
    brokerageOk = false;
  }

  return NextResponse.json({
    mode: settings.tradingMode,
    killSwitch: settings.globalKillSwitch,
    stopNewOrders: settings.stopNewOrders,
    marketOpen,
    brokerageOk,
    syncedAt: new Date().toISOString(),
  });
}
