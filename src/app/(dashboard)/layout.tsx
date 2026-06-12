import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { getConfigStatus } from "@/lib/env";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Explicit system state (20.1): the system is never "IDLE" while healthy —
 * between scheduled runs it is MONITORING.
 */
async function getSystemState(
  store: Awaited<ReturnType<typeof getStore>>,
): Promise<{ systemState: string; scannerActive: boolean }> {
  try {
    const now = Date.now();
    const [heartbeats, dailyRuns] = await Promise.all([
      store.listLearningRecords("worker_heartbeats", { limit: 1 }),
      store.listLearningRecords("learning_runs", { keys: { kind: "daily" }, limit: 1 }),
    ]);
    const beatAge = heartbeats[0]
      ? now - new Date(heartbeats[0].createdAt).getTime()
      : Infinity;
    const scannerActive = beatAge < 3 * 60_000;
    const lastDaily = dailyRuns[0] ? now - new Date(dailyRuns[0].createdAt).getTime() : Infinity;
    const hourUtc = new Date().getUTCHours();
    let systemState = "MONITORING";
    if (lastDaily < 30 * 60_000) systemState = "LEARNING RUN";
    else if (hourUtc >= 21 && hourUtc < 23) systemState = "LEARNING SCHEDULED";
    else if (scannerActive) systemState = "SCANNER ACTIVE";
    return { systemState, scannerActive };
  } catch {
    return { systemState: "MONITORING", scannerActive: false };
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  const settings = await store.getSettings();
  const config = getConfigStatus();
  const { systemState, scannerActive } = await getSystemState(store);

  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <TopBar initialMode={settings.tradingMode} />
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar
          status={{
            mode: settings.tradingMode,
            feed: "IEX LIMITED",
            supabaseOk: config.supabase && config.supabaseServiceRole,
            alpacaConfigured: config.alpacaPaper,
            systemState,
            scannerActive,
            killSwitch: settings.globalKillSwitch,
          }}
        />
        <main className="min-w-0 flex-1 px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}
