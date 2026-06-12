import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { getConfigStatus } from "@/lib/env";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

async function isLearnerActive(store: Awaited<ReturnType<typeof getStore>>): Promise<boolean> {
  try {
    const runs = await store.listLearningRecords("learning_runs", {
      keys: { kind: "daily" },
      limit: 1,
    });
    const last = runs[0]?.createdAt;
    return Boolean(last && Date.now() - new Date(last).getTime() < 3 * 86_400_000);
  } catch {
    return false;
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  const settings = await store.getSettings();
  const config = getConfigStatus();
  const learnerActive = await isLearnerActive(store);

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
            learnerActive,
            killSwitch: settings.globalKillSwitch,
          }}
        />
        <main className="min-w-0 flex-1 px-4 py-5 md:px-6">{children}</main>
      </div>
    </div>
  );
}
