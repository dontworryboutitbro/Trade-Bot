import { type NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron";
import { refreshUniverse } from "@/lib/universe/refresh";

export const maxDuration = 300;

// Universe discovery + eligibility + ranking, every 6 hours. The always-on
// worker (when deployed) triggers this more frequently; this cron is the
// guaranteed serverless baseline. Idempotent per 6-hour window.
const sixHourKey = (now: Date) =>
  `${now.toISOString().slice(0, 10)}-${Math.floor(now.getUTCHours() / 6)}`;

export async function GET(request: NextRequest) {
  return runCronJob(request, "universe-refresh", sixHourKey, () => refreshUniverse("cron"));
}
