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
  let spy: { price: number; changePct: number | null } | null = null;
  let regime: string | null = null;
  try {
    const marketData = getMarketDataClient(settings.tradingMode);
    const clock = await marketData.getMarketClock();
    marketOpen = clock.isOpen;
    const bars = await marketData.getDailyBars("SPY", 130).catch(() => []);
    if (bars.length >= 2) {
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      spy = { price: last.close, changePct: ((last.close - prev.close) / prev.close) * 100 };
      const { classifyRegime } = await import("@/lib/regime/engine");
      regime = classifyRegime(bars).regime;
    }
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
    spy,
    regime,
    syncedAt: new Date().toISOString(),
  });
}
