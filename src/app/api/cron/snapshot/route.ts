import { type NextRequest } from "next/server";
import { dailyKey, runCronJob } from "@/lib/cron";
import { captureSnapshot } from "@/lib/trading/pipeline";

export const maxDuration = 60;

// Daily portfolio + SPY benchmark snapshot.
export async function GET(request: NextRequest) {
  return runCronJob(request, "capture-snapshot", dailyKey, () => captureSnapshot());
}
