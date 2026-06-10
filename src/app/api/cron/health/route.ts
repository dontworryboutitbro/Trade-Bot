import { type NextRequest } from "next/server";
import { hourlyKey, runCronJob } from "@/lib/cron";
import { runHealthChecks, syncAccount } from "@/lib/trading/pipeline";

export const maxDuration = 60;

// Hourly health check + account sync.
export async function GET(request: NextRequest) {
  return runCronJob(request, "health-check", hourlyKey, async () => {
    const health = await runHealthChecks();
    const sync = await syncAccount().catch((error) => ({
      error: error instanceof Error ? error.message.slice(0, 200) : "sync failed",
    }));
    return { health, sync };
  });
}
