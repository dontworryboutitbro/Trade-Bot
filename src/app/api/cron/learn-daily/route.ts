import { type NextRequest } from "next/server";
import { dailyKey, runCronJob } from "@/lib/cron";
import { runDailyLearning } from "@/lib/learning/daily-review";

export const maxDuration = 300;

// Nightly learning run (after the post-close snapshot). Idempotent per date.
// Observes, labels, calibrates, shadow-tests. Never trades, never changes settings.
export async function GET(request: NextRequest) {
  return runCronJob(request, "learn-daily", dailyKey, () => runDailyLearning());
}
