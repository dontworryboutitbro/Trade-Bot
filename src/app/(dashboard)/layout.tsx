import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const store = await getStore();
  const settings = await store.getSettings();
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar initialMode={settings.tradingMode} />
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar />
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
