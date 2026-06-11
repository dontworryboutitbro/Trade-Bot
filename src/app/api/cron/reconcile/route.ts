import { type NextRequest } from "next/server";
import { quarterHourKey, runCronJob } from "@/lib/cron";
import { checkStopRules, expireProposals, reconcileOrders } from "@/lib/trading/pipeline";

export const maxDuration = 120;

// Reconcile open orders + expire stale proposals + enforce stop-losses.
export async function GET(request: NextRequest) {
  return runCronJob(request, "reconcile-orders", quarterHourKey, async () => {
    const expired = await expireProposals();
    const { updated } = await reconcileOrders("cron");
    const stops = await checkStopRules("cron");
    return { expiredProposals: expired, ordersUpdated: updated, stopsTriggered: stops.triggered };
  });
}
